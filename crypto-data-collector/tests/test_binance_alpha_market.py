import asyncio

import pytest

from api.config import validate_production_config
from database.db import Base, SessionLocal, engine
from database.models import AlphaAsset, LatestTicker, Token
from market_data.alpha_service import BinanceAlphaMarketDataService


@pytest.fixture(autouse=True)
def schema():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield


def test_alpha_catalogue_creates_bsc_contract_and_ticker(monkeypatch):
    service = BinanceAlphaMarketDataService()

    class Response:
        data = [{"alphaId": "ALPHA_1", "chainId": "56", "contractAddress": "0x" + "1" * 40,
                 "symbol": "TEST", "name": "Test", "decimals": 18, "price": "1.2",
                 "percentChange24h": "2", "volume24h": "5000", "liquidity": "10000", "marketCap": "20000"}]

    class Client:
        async def __aenter__(self): return self
        async def __aexit__(self, *_): pass
        async def tokens(self): return Response()

    monkeypatch.setattr("market_data.alpha_service.BinanceAlphaClient", Client)
    asyncio.run(service.refresh())
    db = SessionLocal()
    try:
        asset = db.get(AlphaAsset, "ALPHA_1")
        token = db.query(Token).filter_by(alpha_id="ALPHA_1").one()
        assert asset.contract_address == "0x" + "1" * 40
        assert token.chain_id == "56"
        assert db.get(LatestTicker, token.symbol).last_price == 1.2
    finally:
        db.close()


def test_production_does_not_require_a_cmc_key(monkeypatch):
    monkeypatch.setenv("HAVEN_ENV", "production")
    for name in ("DATABASE_URL", "HAVEN_CORS_ORIGINS", "CLERK_JWKS_URL", "CLERK_ISSUER",
                 "CLERK_SECRET_KEY", "HAVEN_OWNER_USER_IDS", "HAVEN_LEGAL_ENTITY_NAME",
                 "HAVEN_LEGAL_CONTACT_EMAIL", "HAVEN_TERMS_VERSION", "HAVEN_PRIVACY_VERSION",
                 "HAVEN_MONITORING_DASHBOARD_URL", "HAVEN_BACKUP_DASHBOARD_URL",
                 "HAVEN_ENGINE_RELEASE_PUBLIC_KEY"):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(RuntimeError) as exc:
        validate_production_config()
    assert "CMC_API_KEY" not in str(exc.value)
