import asyncio
import hashlib
import json
import time

import pytest
from fastapi import HTTPException

from api import auth, clerk_billing
from api.config import validate_production_config
from api.plans import PLANS, TRIAL
from api.server import (
    LiveApproval, StrategyCreate, StrategyUpdate, TradeCreate,
    approve_strategy_for_live, create_strategy, create_trade, update_strategy,
)
from database.db import Base, SessionLocal, engine
from database.models import CandleCoverage, CmcAsset, LatestTicker, MarketCandle, Token
from market_data.cmc_service import CmcMarketDataService, INTERVAL_MS


@pytest.fixture(autouse=True)
def clean_database():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield


def test_trial_and_paid_capacity_progression():
    assert TRIAL.live_allowed is True
    assert (TRIAL.bots, TRIAL.strategies, TRIAL.finders) == (1, 3, 1)
    assert TRIAL.ai_daily > 0
    capacities = [(p.bots, p.strategies, p.finders, p.ai_daily) for p in PLANS.values()]
    assert capacities == sorted(capacities)
    assert len({p.clerk_slug for p in PLANS.values()}) == 3


def test_local_trial_capacity_is_live_enabled_for_unconfigured_development(monkeypatch):
    monkeypatch.setattr(auth, "SOLO_MODE", False)
    monkeypatch.setattr(auth, "clerk_billing_configured", lambda: False)
    with SessionLocal() as db:
        first = auth.ensure_automatic_trial(db, "user-1")
        end = first.current_period_end
        second = auth.ensure_automatic_trial(db, "user-1")
        assert second.current_period_end == end
        ent = auth.entitlements(db, auth.Identity("user-1", "user", paid=True))
        assert ent["trial"] is True and ent["live_allowed"] is True
        assert ent["max_bots"] == 1 and ent["max_strategies"] == 3


def test_cmc_listing_creates_supported_contract_and_preserves_metadata():
    service = CmcMarketDataService()
    row = {
        "id": 7186, "symbol": "CAKE", "name": "PancakeSwap", "slug": "pancakeswap",
        "cmc_rank": 100, "platform": {"slug": "bnb-smart-chain", "token_address": "0x" + "1" * 40},
        "quote": {"USD": {"price": 2.5, "volume_24h": 1_000_000,
                            "percent_change_24h": 3.2, "market_cap": 500_000_000}},
    }
    service._store_assets([row])
    with SessionLocal() as db:
        asset = db.get(CmcAsset, 7186)
        metadata = json.loads(asset.metadata_json)
        metadata["logo"] = "https://example.invalid/logo.png"
        asset.metadata_json = json.dumps(metadata)
        db.commit()
    service._store_assets([row])
    with SessionLocal() as db:
        asset = db.get(CmcAsset, 7186)
        listed_asset = db.query(Token).filter(Token.cmc_id == 7186).one()
        ticker = db.get(LatestTicker, listed_asset.symbol)
        assert listed_asset.chain_id == "bsc" and listed_asset.symbol == "CAKE_7186_bsc"
        assert ticker.last_price == 2.5
        assert json.loads(asset.metadata_json)["logo"].endswith("logo.png")


def test_trade_reports_are_validated_and_idempotent():
    identity = auth.Identity("local", "solo", paid=True)
    tx_hash = "0x" + "a" * 64
    body = TradeCreate(symbol="CAKE_bsc", direction="BUY", expected_price=2,
                       execution_price=2.01, amount_in=0.1, amount_out=10,
                       tx_hash=tx_hash, status="PENDING")
    with SessionLocal() as db:
        first = create_trade(body, db, identity)
        body.status = "FILLED"
        second = create_trade(body, db, identity)
        assert first.id == second.id and second.status == "FILLED"
        bad = body.model_copy(update={"tx_hash": "not-a-chain-hash"})
        with pytest.raises(HTTPException) as exc:
            create_trade(bad, db, identity)
        assert exc.value.status_code == 422


def test_production_config_fails_closed(monkeypatch):
    monkeypatch.setenv("HAVEN_ENV", "production")
    for key in ("CMC_API_KEY", "CLERK_JWKS_URL", "HAVEN_OWNER_USER_IDS"):
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(RuntimeError) as exc:
        validate_production_config()
    assert "CMC_API_KEY" in str(exc.value)


def _seed_cmc_contract(service: CmcMarketDataService):
    service._store_assets([{
        "id": 7186, "symbol": "CAKE", "name": "PancakeSwap", "slug": "pancakeswap",
        "cmc_rank": 100,
        "platform": {"slug": "bnb-smart-chain", "token_address": "0x" + "1" * 40},
        "quote": {"USD": {"price": 2.5}},
    }])


def test_websocket_onchain_kline_updates_current_candle_and_ticker():
    service = CmcMarketDataService()
    _seed_cmc_contract(service)
    opened = 1_800_000_000_000
    service._apply_kline_event({
        "channel": "onchain@kline",
        "params": {"platform_id": 14, "address": "0x" + "1" * 40, "interval": "5m"},
        "data": {"o": 2.4, "h": 2.7, "l": 2.3, "c": 2.6, "vu": 50_000, "ot": opened},
    }, opened + 10_000)
    with SessionLocal() as db:
        candle = db.query(MarketCandle).one()
        ticker = db.get(LatestTicker, "CAKE_7186_bsc")
        assert candle.source == "cmc_websocket_onchain" and candle.closed == 0
        assert candle.open_price == 2.4 and candle.close_price == 2.6
        assert ticker.last_price == 2.6


def test_closed_history_coverage_prevents_duplicate_rest_fetch(monkeypatch):
    service = CmcMarketDataService()
    calls = []
    width = INTERVAL_MS["5min"]
    end = (int(time.time() * 1000) // width - 2) * width
    start = end - 4 * width

    async def fake_fetch(cmc_id, platform, address, interval, start_ms, end_ms):
        calls.append((start_ms, end_ms))
        with SessionLocal() as db:
            db.add(CandleCoverage(
                cmc_id=cmc_id, platform=platform, contract_address=address,
                interval=interval, start_time=start, end_time=end + width,
                updated_at=int(time.time() * 1000),
            ))
            db.add(MarketCandle(
                cmc_id=cmc_id, platform=platform, contract_address=address,
                interval=interval, open_time=start, close_time=start + width - 1,
                open_price=1, high_price=2, low_price=.5, close_price=1.5,
                volume=100, closed=1, source="cmc_rest", updated_at=end,
            ))
            db.commit()

    monkeypatch.setattr(service, "_fetch_candle_range", fake_fetch)
    kwargs = dict(cmc_id=7186, platform="bnb-smart-chain", address="0x" + "1" * 40,
                  interval="5m", start_ms=start, end_ms=end)
    async def request_repeatedly():
        first, second = await asyncio.gather(service.candles(**kwargs), service.candles(**kwargs))
        third = await service.candles(**kwargs)
        return first, second, third

    first, second, third = asyncio.run(request_repeatedly())
    assert len(calls) == 1 and len(first) == len(second) == 1
    assert len(third) == 1


def test_clerk_billing_requires_exact_payer_and_configured_plan(monkeypatch):
    monkeypatch.setattr(clerk_billing, "CLERK_SECRET_KEY", "test-key")
    clerk_billing._cache.clear()
    starter = PLANS["starter"]
    monkeypatch.setattr(clerk_billing, "_http_get", lambda *_args, **_kwargs: {
        "payerId": "attacker", "status": "active", "subscriptionItems": [
            {"status": "active", "plan": {"slug": starter.clerk_slug}},
        ]})
    assert clerk_billing.get_clerk_entitlements("user-1")["app_access"] is False
    clerk_billing._cache.clear()
    monkeypatch.setattr(clerk_billing, "_http_get", lambda *_args, **_kwargs: {
        "payerId": "user-1", "status": "active", "subscriptionItems": [
            {"status": "active", "periodEnd": 1_800_000_000,
             "plan": {"slug": starter.clerk_slug}},
        ]})
    result = clerk_billing.get_clerk_entitlements("user-1")
    assert result["app_access"] is True and result["max_bots"] == starter.bots
    assert result["current_period_end"] == 1_800_000_000_000


def test_clerk_free_trial_uses_hobbled_capacity(monkeypatch):
    monkeypatch.setattr(clerk_billing, "CLERK_SECRET_KEY", "test-key")
    clerk_billing._cache.clear()
    starter = PLANS["starter"]
    monkeypatch.setattr(clerk_billing, "_http_get", lambda *_args, **_kwargs: {
        "payerId": "user-1", "status": "active", "subscriptionItems": [
            {"status": "active", "isFreeTrial": True, "periodEnd": 1_800_000_000,
             "plan": {"slug": starter.clerk_slug}},
        ]})
    result = clerk_billing.get_clerk_entitlements("user-1")
    assert result["app_access"] is True and result["trial"] is True
    assert result["selected_plan"] == "starter"
    assert (result["max_bots"], result["max_strategies"], result["max_finders"]) == (1, 3, 1)


def test_clerk_billing_rejects_unconfigured_plan(monkeypatch):
    monkeypatch.setattr(clerk_billing, "CLERK_SECRET_KEY", "test-key")
    clerk_billing._cache.clear()
    monkeypatch.setattr(clerk_billing, "_http_get", lambda *_args, **_kwargs: {
        "payerId": "user-1", "status": "active", "subscriptionItems": [
            {"status": "active", "plan": {"slug": "not-a-haven-plan"}},
        ]})
    assert clerk_billing.get_clerk_entitlements("user-1")["app_access"] is False


def test_live_code_requires_exact_immutable_version_approval():
    identity = auth.Identity("local", "solo", paid=True)
    original = "const strategy = { onBar() {} };"
    changed = "const strategy = { onBar(bar, ctx) { ctx.log(bar.close); } };"
    with SessionLocal() as db:
        strategy = create_strategy(StrategyCreate(
            name="Approval test", code=original, symbol="CAKE_7186_bsc"), db, identity)
        with pytest.raises(HTTPException) as exc:
            update_strategy(strategy.id, StrategyUpdate(code=changed, mode="live"), db, identity)
        assert exc.value.status_code == 409
        updated = update_strategy(strategy.id, StrategyUpdate(code=changed), db, identity)
        assert updated.mode == "off" and updated.code_version == 2
        digest = hashlib.sha256(changed.encode()).hexdigest()
        approved = approve_strategy_for_live(
            strategy.id, LiveApproval(version=2, code_hash=digest), db, identity)
        assert approved.live_approved_version == 2
        live = update_strategy(strategy.id, StrategyUpdate(mode="live"), db, identity)
        assert live.mode == "live"
