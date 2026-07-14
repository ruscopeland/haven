"""Server-side CoinMarketCap REST cache and resilient WebSocket manager."""

from __future__ import annotations

import asyncio
import inspect
import json
import math
import os
import random
import time
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

import websockets
from sqlalchemy import and_

from database.db import SessionLocal, dialect_insert
from database.models import (
    CandleCoverage, CmcAsset, LatestTicker, MarketCandle, ProviderStatus, ProviderUsage,
    Strategy, Token,
)
from .cmc_client import CmcClient, CmcError, WS_URL


INTERVAL_MS = {
    "1min": 60_000, "3min": 180_000, "5min": 300_000, "15min": 900_000,
    "30min": 1_800_000, "1h": 3_600_000, "2h": 7_200_000,
    "4h": 14_400_000, "6h": 21_600_000, "8h": 28_800_000,
    "12h": 43_200_000, "1d": 86_400_000, "3d": 259_200_000,
    "1w": 604_800_000,
}
UI_TO_CMC_INTERVAL = {
    "1m": "1min", "3m": "3min", "5m": "5min", "15m": "15min",
    "30m": "30min", "1h": "1h", "2h": "2h", "4h": "4h",
    "6h": "6h", "8h": "8h", "12h": "12h", "1d": "1d",
    "3d": "3d", "1w": "1w",
}

CMC_PLATFORM_TO_CHAIN = {
    "bnb": "bsc", "bsc": "bsc", "binance-smart-chain": "bsc",
    "bnb-smart-chain": "bsc",
}
CMC_PLATFORM_TO_DEX_API = {
    "bnb": "bsc", "binance-smart-chain": "bsc", "bnb-smart-chain": "bsc",
}
CMC_CHAIN_TO_PLATFORM_ID = {"bsc": 14}
WS_TO_REST_INTERVAL = {"1m": "1min", "3m": "3min", "5m": "5min", "15m": "15min", "30m": "30min"}
REST_TO_WS_INTERVAL = {value: key for key, value in WS_TO_REST_INTERVAL.items()}


def now_ms() -> int:
    return int(time.time() * 1000)


def _timestamp_ms(value: Any) -> int:
    value = int(float(value))
    return value if value > 10_000_000_000 else value * 1000


def _quote_usd(row: dict) -> dict:
    quote = row.get("quote") or {}
    if isinstance(quote, list):
        for item in quote:
            if item.get("symbol") == "USD" or item.get("id") == 2781:
                return item
        return quote[0] if quote else {}
    return quote.get("USD") or quote.get("2781") or {}


@dataclass
class ServiceState:
    state: str = "stopped"
    last_event_at: int | None = None
    last_reconciled_at: int | None = None
    reconnect_count: int = 0
    gap_count: int = 0
    error: str | None = None
    subscriptions: int = 0


class CmcMarketDataService:
    """Single CMC manager shared by every API user.

    REST owns durable history and reconciliation. WebSocket pushes update the
    latest ticker and the current in-progress candle; a candle is marked closed
    only when the next interval starts. On reconnect, REST quotes reconcile the
    latest state before streaming resumes.
    """

    def __init__(self):
        self.api_key = os.environ.get("CMC_API_KEY", "").strip()
        self.asset_ttl_ms = int(os.environ.get("CMC_METADATA_TTL_SEC", "86400")) * 1000
        self.refresh_sec = int(os.environ.get("CMC_LISTINGS_REFRESH_SEC", "21600"))
        self.usage_sec = int(os.environ.get("CMC_USAGE_REFRESH_SEC", "900"))
        self.ws_max = min(100, max(1, int(os.environ.get("CMC_WS_MAX_SUBSCRIPTIONS", "100"))))
        self.stream_intervals = tuple(
            x.strip() for x in os.environ.get("CMC_STREAM_CANDLE_INTERVALS", "1min,5min,15min,1h,1d").split(",")
            if x.strip() in INTERVAL_MS
        )
        self.state = ServiceState(state="disabled" if not self.api_key else "starting")
        self._stop = asyncio.Event()
        self._tasks: list[asyncio.Task] = []
        self._requested_candle_ids: set[int] = set()
        self._candle_locks: dict[tuple[int, str, str, str], asyncio.Lock] = {}

    async def start(self):
        if not self.api_key:
            self._persist_state()
            return
        self._stop.clear()
        self._tasks = [
            asyncio.create_task(self._asset_loop(), name="cmc-assets"),
            asyncio.create_task(self._usage_loop(), name="cmc-usage"),
            asyncio.create_task(self._websocket_loop(), name="cmc-websocket"),
        ]

    async def stop(self):
        self._stop.set()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with suppress(asyncio.CancelledError):
                await task
        self._tasks.clear()
        self.state.state = "stopped"
        self._persist_state()

    async def _asset_loop(self):
        while not self._stop.is_set():
            try:
                async with CmcClient(self.api_key) as client:
                    response = await client.listings(limit=int(os.environ.get("CMC_ASSET_LIMIT", "2000")))
                self._store_assets(response.data)
                await self._refresh_metadata()
                self.state.error = None
            except Exception as exc:
                self.state.error = f"asset refresh: {exc}"
                self._persist_state()
            await self._wait(self.refresh_sec)

    async def _usage_loop(self):
        while not self._stop.is_set():
            try:
                async with CmcClient(self.api_key) as client:
                    response = await client.key_info()
                self._store_usage(response.data)
            except Exception as exc:
                self.state.error = f"usage refresh: {exc}"
                self._persist_state()
            await self._wait(self.usage_sec)

    async def _wait(self, seconds: float):
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    def _store_assets(self, rows: list[dict]):
        at = now_ms()
        seen_market_symbols: set[str] = set()
        with SessionLocal() as db:
            for row in rows or []:
                cmc_id = int(row.get("id") or 0)
                if not cmc_id:
                    continue
                platform = row.get("platform") or {}
                usd = _quote_usd(row)
                platform_slug = (platform.get("slug") or platform.get("name") or "").lower()
                address = (platform.get("token_address") or "").lower()
                existing = db.get(CmcAsset, cmc_id)
                metadata = {
                    "date_added": row.get("date_added"), "tags": row.get("tags") or [],
                    "circulating_supply": row.get("circulating_supply"),
                    "total_supply": row.get("total_supply"), "max_supply": row.get("max_supply"),
                }
                if existing and existing.metadata_json:
                    with suppress(ValueError, TypeError):
                        metadata = {**json.loads(existing.metadata_json), **metadata}
                values = {
                    "cmc_id": cmc_id, "symbol": row.get("symbol") or "",
                    "name": row.get("name") or row.get("symbol") or str(cmc_id),
                    "slug": row.get("slug") or str(cmc_id), "rank": row.get("cmc_rank"),
                    "platform": platform_slug or None,
                    "contract_address": address or None,
                    "metadata_json": json.dumps(metadata, separators=(",", ":")),
                    "fetched_at": at, "expires_at": at + self.asset_ttl_ms,
                }
                stmt = dialect_insert(CmcAsset).values(**values)
                stmt = stmt.on_conflict_do_update(index_elements=["cmc_id"], set_=values)
                db.execute(stmt)
                market_symbol = row.get("symbol") or str(cmc_id)
                ticker_values = {
                    "symbol": market_symbol,
                    "last_price": usd.get("price"),
                    "price_change_24h": usd.get("percent_change_24h"),
                    "volume_24h": usd.get("volume_24h"), "last_updated": at,
                }
                if market_symbol not in seen_market_symbols:
                    ticker_stmt = dialect_insert(LatestTicker).values(**ticker_values)
                    db.execute(ticker_stmt.on_conflict_do_update(
                        index_elements=["symbol"], set_=ticker_values))
                    seen_market_symbols.add(market_symbol)
                token_updates = {
                    "market_cap": usd.get("market_cap"), "cmc_rank": row.get("cmc_rank"),
                    "cmc_slug": row.get("slug"), "cmc_id": cmc_id,
                }
                db.query(Token).filter(and_(
                    Token.contract_address.isnot(None),
                    Token.contract_address.ilike(platform.get("token_address") or "__none__")
                )).update(token_updates, synchronize_session=False)
                chain = CMC_PLATFORM_TO_CHAIN.get(platform_slug)
                if chain and address:
                    display = (row.get("symbol") or str(cmc_id)).upper()
                    # Internal trading symbols include the immutable CMC id so
                    # two assets reusing the same ticker can never select the
                    # wrong contract. The UI shows display_symbol to humans.
                    symbol = f"{display}_{cmc_id}_{chain}"
                    token_values = {
                        "id": f"{chain}:{address}", "symbol": symbol,
                        "name": row.get("name") or display, "chain_id": chain,
                        "contract_address": address, "display_symbol": display,
                        "market_cap": usd.get("market_cap"), "cmc_rank": row.get("cmc_rank"),
                        "cmc_slug": row.get("slug"), "cmc_id": cmc_id,
                        "listed_at": at, "status": "active",
                    }
                    token_stmt = dialect_insert(Token).values(**token_values)
                    db.execute(token_stmt.on_conflict_do_update(
                        index_elements=["id"], set_={k: v for k, v in token_values.items()
                                                     if k not in ("id", "listed_at")}))
                    local_ticker = {**ticker_values, "symbol": symbol}
                    local_stmt = dialect_insert(LatestTicker).values(**local_ticker)
                    db.execute(local_stmt.on_conflict_do_update(
                        index_elements=["symbol"], set_=local_ticker))
            db.commit()

    async def _refresh_metadata(self):
        """Refresh full, relatively static CMC metadata only after its TTL."""
        limit = max(0, int(os.environ.get("CMC_METADATA_ASSET_LIMIT", "300")))
        if not limit:
            return
        cutoff = now_ms() - self.asset_ttl_ms
        with SessionLocal() as db:
            candidates = db.query(CmcAsset).order_by(CmcAsset.rank).limit(limit).all()
            ids = []
            for asset in candidates:
                cached = {}
                with suppress(ValueError, TypeError):
                    cached = json.loads(asset.metadata_json or "{}")
                if int(cached.get("_metadata_at") or 0) < cutoff:
                    ids.append(asset.cmc_id)
        for offset in range(0, len(ids), 100):
            async with CmcClient(self.api_key) as client:
                response = await client.metadata(ids[offset:offset + 100])
            data = response.data or {}
            at = now_ms()
            with SessionLocal() as db:
                for key, info in data.items():
                    asset = db.get(CmcAsset, int(key))
                    if not asset or not isinstance(info, dict):
                        continue
                    current = {}
                    with suppress(ValueError, TypeError):
                        current = json.loads(asset.metadata_json or "{}")
                    safe_info = {k: info.get(k) for k in (
                        "logo", "description", "category", "tags", "urls", "notice", "date_added"
                    ) if k in info}
                    asset.metadata_json = json.dumps(
                        {**current, **safe_info, "_metadata_at": at}, separators=(",", ":"))
                    asset.expires_at = at + self.asset_ttl_ms
                db.commit()

    def _store_usage(self, data: dict):
        usage = (data or {}).get("usage") or {}
        month = usage.get("current_month") or {}
        minute = usage.get("current_minute") or {}
        with SessionLocal() as db:
            db.add(ProviderUsage(
                provider="coinmarketcap", captured_at=now_ms(),
                credits_used=month.get("credits_used"), credits_left=month.get("credits_left"),
                requests_left_minute=minute.get("requests_left"),
                payload_json=json.dumps(data, separators=(",", ":")),
            ))
            db.commit()

    def _subscription_ids(self, limit: int | None = None) -> list[int]:
        limit = limit or self.ws_max
        with SessionLocal() as db:
            active_symbols = [r[0] for r in db.query(Strategy.symbol).filter(
                Strategy.mode != "off", Strategy.symbol != "").distinct().all()]
            ids = [r[0] for r in db.query(Token.cmc_id).filter(
                Token.symbol.in_(active_symbols), Token.cmc_id.isnot(None)).all()]
            ranked = [r[0] for r in db.query(CmcAsset.cmc_id).order_by(CmcAsset.rank).limit(limit).all()]
        return list(dict.fromkeys([*ids, *ranked]))[:limit]

    def _onchain_subscriptions(self, remaining: int) -> list[dict]:
        """Build licensed BSC kline subscriptions for actively used contracts."""
        if remaining <= 0 or not self._requested_candle_ids:
            return []
        intervals = [REST_TO_WS_INTERVAL.get(value, value) for value in self.stream_intervals]
        per_asset = max(1, len(intervals))
        asset_limit = remaining // per_asset
        if not asset_limit:
            return []
        with SessionLocal() as db:
            rows = (db.query(Token)
                    .filter(Token.cmc_id.in_(list(self._requested_candle_ids)),
                            Token.chain_id == "bsc", Token.contract_address.isnot(None))
                    .limit(asset_limit).all())
        addresses = list(dict.fromkeys(row.contract_address.lower() for row in rows))
        return [
            {"platform_id": CMC_CHAIN_TO_PLATFORM_ID["bsc"], "address": addresses, "interval": interval}
            for interval in intervals if addresses
        ]

    async def _websocket_loop(self):
        attempt = 0
        while not self._stop.is_set():
            latest_limit = min(self.ws_max, max(1, int(os.environ.get("CMC_WS_LATEST_LIMIT", "60"))))
            ids = self._subscription_ids(latest_limit)
            if not ids:
                await self._wait(5)
                continue
            try:
                headers = {"X-CMC_PRO_API_KEY": self.api_key}
                if "additional_headers" in inspect.signature(websockets.connect).parameters:
                    connection = websockets.connect(WS_URL, additional_headers=headers,
                                                    ping_interval=20, ping_timeout=20, close_timeout=5)
                else:  # websockets 12 and earlier
                    connection = websockets.connect(WS_URL, extra_headers=headers,
                                                    ping_interval=20, ping_timeout=20, close_timeout=5)
                async with connection as ws:
                    await ws.send(json.dumps({
                        "id": 1, "method": "subscribe", "channel": "market@crypto_latest_price",
                        "params": {"crypto_ids": ids},
                    }))
                    onchain = self._onchain_subscriptions(self.ws_max - len(ids))
                    for request_id, params in enumerate(onchain, start=2):
                        await ws.send(json.dumps({
                            "id": request_id, "method": "subscribe", "channel": "onchain@kline",
                            "params": params,
                        }))
                    subscribed_onchain = {
                        (params["interval"], address)
                        for params in onchain for address in params["address"]
                    }
                    self.state.state = "connected"
                    self.state.subscriptions = len(ids) + sum(len(x["address"]) for x in onchain)
                    self.state.error = None
                    self._persist_state()
                    await self._reconcile_quotes(ids)
                    await self._reconcile_candles(ids)
                    attempt = 0
                    async for raw in ws:
                        received = now_ms()
                        payload = json.loads(raw)
                        if isinstance(payload, dict) and payload.get("channel") == "onchain@kline":
                            self._apply_kline_event(payload, received)
                        else:
                            for event in self._events(payload):
                                self._apply_price_event(event, received)
                        # A chart or bot can become active after connection. Add its
                        # on-chain candles without exposing the key or waiting for a reconnect.
                        desired = self._onchain_subscriptions(self.ws_max - len(ids))
                        for params in desired:
                            new_addresses = [
                                address for address in params["address"]
                                if (params["interval"], address) not in subscribed_onchain
                            ]
                            if not new_addresses:
                                continue
                            await ws.send(json.dumps({
                                "id": 10_000 + len(subscribed_onchain), "method": "subscribe",
                                "channel": "onchain@kline", "params": {**params, "address": new_addresses},
                            }))
                            subscribed_onchain.update((params["interval"], address)
                                                      for address in new_addresses)
                            self.state.subscriptions = len(ids) + len(subscribed_onchain)
                        self.state.last_event_at = received
                        self._persist_state(coarse=True)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.state.state = "reconnecting"
                self.state.reconnect_count += 1
                self.state.gap_count += 1
                self.state.error = f"{type(exc).__name__}: {exc}"
                print(f"CMC WebSocket reconnecting: {self.state.error}", flush=True)
                self._persist_state()
                attempt += 1
                await self._wait(min(60, (2 ** min(attempt, 6))) + random.random())

    @staticmethod
    def _events(payload: Any) -> list[dict]:
        if isinstance(payload, list):
            return [x for x in payload if isinstance(x, dict)]
        if not isinstance(payload, dict) or payload.get("type") == "error":
            return []
        data = payload.get("data", payload.get("d", payload))
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict)]
        return [data] if isinstance(data, dict) and ("cid" in data or "id" in data) else []

    def _apply_price_event(self, event: dict, received_at: int):
        cmc_id = int(event.get("cid") or event.get("id") or 0)
        price = float(event.get("p") or event.get("price") or 0)
        if not cmc_id or not math.isfinite(price) or price <= 0:
            return
        change = event.get("p24h", event.get("percent_change_24h"))
        volume = event.get("vu", event.get("volume_24h"))
        with SessionLocal() as db:
            assets = db.query(CmcAsset).filter(CmcAsset.cmc_id == cmc_id).all()
            symbols = set()
            for asset in assets:
                canonical = (db.query(CmcAsset).filter(CmcAsset.symbol == asset.symbol)
                             .order_by(CmcAsset.rank.asc().nullslast(), CmcAsset.cmc_id).first())
                if canonical and canonical.cmc_id == cmc_id:
                    symbols.add(asset.symbol)
            symbols.update(r[0] for r in db.query(Token.symbol).filter(Token.cmc_id == cmc_id).all())
            for symbol in symbols:
                values = {"symbol": symbol, "last_price": price,
                          "price_change_24h": float(change or 0),
                          "volume_24h": float(volume or 0), "last_updated": received_at}
                stmt = dialect_insert(LatestTicker).values(**values)
                db.execute(stmt.on_conflict_do_update(index_elements=["symbol"], set_=values))
            for interval in self.stream_intervals:
                self._upsert_stream_candle(db, cmc_id, interval, received_at, price)
            db.commit()

    def _upsert_stream_candle(self, db, cmc_id: int, interval: str, at: int, price: float):
        width = INTERVAL_MS[interval]
        opened = at - (at % width)
        db.query(MarketCandle).filter(
            MarketCandle.cmc_id == cmc_id, MarketCandle.interval == interval,
            MarketCandle.closed == 0, MarketCandle.open_time < opened,
        ).update({"closed": 1, "source": "cmc_websocket", "updated_at": at}, synchronize_session=False)
        row = db.query(MarketCandle).filter(
            MarketCandle.cmc_id == cmc_id, MarketCandle.platform == "",
            MarketCandle.contract_address == "", MarketCandle.interval == interval,
            MarketCandle.open_time == opened,
        ).first()
        if row:
            row.high_price = max(row.high_price, price)
            row.low_price = min(row.low_price, price)
            row.close_price = price
            row.updated_at = at
        else:
            db.add(MarketCandle(
                cmc_id=cmc_id, platform="", contract_address="", interval=interval,
                open_time=opened, close_time=opened + width - 1,
                open_price=price, high_price=price, low_price=price, close_price=price,
                volume=0, closed=0, source="cmc_websocket", updated_at=at,
            ))

    def _apply_kline_event(self, payload: dict, received_at: int):
        """Persist CMC on-chain OHLCV pushes as the authoritative active candle."""
        params = payload.get("params") or {}
        data = payload.get("data") or {}
        address = str(params.get("address") or data.get("a") or "").lower()
        interval = WS_TO_REST_INTERVAL.get(str(params.get("interval") or ""), str(params.get("interval") or ""))
        if not address or interval not in INTERVAL_MS:
            return
        try:
            opened = _timestamp_ms(data["ot"])
            prices = [float(data[key]) for key in ("o", "h", "l", "c")]
            volume = float(data.get("vu") or 0)
        except (KeyError, TypeError, ValueError):
            return
        if not all(math.isfinite(value) and value >= 0 for value in [*prices, volume]):
            return
        width = INTERVAL_MS[interval]
        with SessionLocal() as db:
            tokens = db.query(Token).filter(Token.chain_id == "bsc", Token.contract_address == address).all()
            for token in tokens:
                asset = db.get(CmcAsset, token.cmc_id) if token.cmc_id else None
                if not asset:
                    continue
                db.query(MarketCandle).filter(
                    MarketCandle.cmc_id == asset.cmc_id,
                    MarketCandle.platform == asset.platform,
                    MarketCandle.contract_address == address,
                    MarketCandle.interval == interval,
                    MarketCandle.closed == 0,
                    MarketCandle.open_time < opened,
                ).update({"closed": 1, "updated_at": received_at}, synchronize_session=False)
                values = {
                    "cmc_id": asset.cmc_id, "platform": asset.platform or "bnb-smart-chain",
                    "contract_address": address, "interval": interval,
                    "open_time": opened, "close_time": opened + width - 1,
                    "open_price": prices[0], "high_price": prices[1], "low_price": prices[2],
                    "close_price": prices[3], "volume": volume, "closed": 0,
                    "source": "cmc_websocket_onchain", "updated_at": received_at,
                }
                stmt = dialect_insert(MarketCandle).values(**values)
                db.execute(stmt.on_conflict_do_update(
                    index_elements=["cmc_id", "platform", "contract_address", "interval", "open_time"],
                    set_=values,
                ))
                ticker = {"symbol": token.symbol, "last_price": prices[3], "last_updated": received_at}
                ticker_stmt = dialect_insert(LatestTicker).values(**ticker)
                db.execute(ticker_stmt.on_conflict_do_update(
                    index_elements=["symbol"], set_=ticker))
            db.commit()

    async def _reconcile_quotes(self, ids: list[int]):
        async with CmcClient(self.api_key) as client:
            response = await client.quotes(ids)
        rows = response.data if isinstance(response.data, list) else list((response.data or {}).values())
        at = now_ms()
        for row in rows:
            usd = _quote_usd(row)
            self._apply_price_event({
                "cid": row.get("id"), "p": usd.get("price"),
                "p24h": usd.get("percent_change_24h"), "vu": usd.get("volume_24h"),
            }, at)
        self.state.last_reconciled_at = at
        self._persist_state()

    async def _reconcile_candles(self, subscribed_ids: list[int]):
        """Repair recent candle gaps for assets actively viewed or traded."""
        wanted = self._requested_candle_ids.intersection(subscribed_ids)
        if not wanted:
            return
        cap = max(1, int(os.environ.get("CMC_RECONCILE_MAX_ASSETS", "25")))
        with SessionLocal() as db:
            rows = (db.query(Token, CmcAsset)
                    .join(CmcAsset, CmcAsset.cmc_id == Token.cmc_id)
                    .filter(Token.cmc_id.in_(list(wanted)))
                    .limit(cap).all())
        end = now_ms()
        for token, asset in rows:
            if not token.contract_address or not asset.platform:
                continue
            for interval in self.stream_intervals:
                width = INTERVAL_MS[interval]
                with suppress(CmcError, ValueError):
                    await self._fetch_candle_range(
                        asset.cmc_id, asset.platform, token.contract_address,
                        interval, end - 3 * width, end - width)

    async def candles(self, *, cmc_id: int, platform: str, address: str,
                      interval: str, start_ms: int, end_ms: int) -> list[MarketCandle]:
        self._requested_candle_ids.add(cmc_id)
        cmc_interval = UI_TO_CMC_INTERVAL.get(interval, interval)
        width = INTERVAL_MS.get(cmc_interval)
        if not width:
            raise ValueError(f"unsupported interval: {interval}")
        closed_end = min(end_ms, now_ms() - width)
        if closed_end >= start_ms:
            lock_key = (cmc_id, platform, address.lower(), cmc_interval)
            lock = self._candle_locks.setdefault(lock_key, asyncio.Lock())
            async with lock:
                await self._ensure_candle_coverage(
                    cmc_id, platform, address, cmc_interval, width, start_ms, closed_end)
        with SessionLocal() as db:
            persisted = db.query(MarketCandle).filter(
                MarketCandle.cmc_id == cmc_id,
                MarketCandle.platform == platform,
                MarketCandle.contract_address == address.lower(),
                MarketCandle.interval == cmc_interval,
                MarketCandle.open_time >= start_ms - width,
                MarketCandle.open_time <= end_ms,
            ).order_by(MarketCandle.open_time).all()
            current = db.query(MarketCandle).filter(
                MarketCandle.cmc_id == cmc_id, MarketCandle.platform == "",
                MarketCandle.contract_address == "", MarketCandle.interval == cmc_interval,
                MarketCandle.closed == 0, MarketCandle.open_time >= start_ms - width,
                MarketCandle.open_time <= end_ms,
            ).order_by(MarketCandle.open_time).all()
            by_open = {row.open_time: row for row in persisted}
            for row in current:
                by_open.setdefault(row.open_time, row)
            return [by_open[key] for key in sorted(by_open)]

    async def _ensure_candle_coverage(self, cmc_id: int, platform: str, address: str,
                                      interval: str, width: int, start_ms: int,
                                      closed_end: int) -> None:
        """Fill only missing edges while serializing identical concurrent requests."""
        with SessionLocal() as db:
            coverage = db.query(CandleCoverage).filter(
                CandleCoverage.cmc_id == cmc_id, CandleCoverage.platform == platform,
                CandleCoverage.contract_address == address.lower(),
                CandleCoverage.interval == interval,
            ).first()
        requested_start = start_ms - (start_ms % width)
        if not coverage:
            await self._fetch_candle_range(
                cmc_id, platform, address, interval, requested_start, closed_end + width)
            return
        if coverage.start_time > requested_start:
            await self._fetch_candle_range(
                cmc_id, platform, address, interval, requested_start,
                min(closed_end + width, coverage.start_time))
        if coverage.end_time < closed_end + width:
            await self._fetch_candle_range(
                cmc_id, platform, address, interval,
                max(requested_start, coverage.end_time), closed_end + width)

    async def _fetch_candle_range(self, cmc_id: int, platform: str, address: str,
                                  interval: str, start_ms: int, end_ms: int):
        width = INTERVAL_MS[interval]
        requested_count = max(1, min(1000, (end_ms - start_ms + width - 1) // width))
        # The Startup K-line endpoint permits its rolling candle window without
        # explicit timestamps. Supplying from/to can reject the same otherwise
        # licensed data as outside the plan window, so use the rolling form for
        # requests ending at the present and cache the exact returned coverage.
        rolling = end_ms >= now_ms() - 2 * width
        async with CmcClient(self.api_key) as client:
            response = await client.dex_candles(
                platform=CMC_PLATFORM_TO_DEX_API.get(platform, platform),
                address=address, interval=interval,
                start_s=None if rolling else start_ms // 1000,
                end_s=None if rolling else end_ms // 1000,
                limit=requested_count,
            )
        rows = response.data or []
        at = now_ms()
        returned_times = [
            _timestamp_ms(candle[5]) for candle in rows
            if isinstance(candle, (list, tuple)) and len(candle) >= 6
        ]
        candle_values = []
        for candle in rows:
            if not isinstance(candle, (list, tuple)) or len(candle) < 6:
                continue
            opened = _timestamp_ms(candle[5])
            if opened + width > at:
                continue
            candle_values.append({
                "cmc_id": cmc_id, "platform": platform,
                "contract_address": address.lower(), "interval": interval,
                "open_time": opened, "close_time": opened + width - 1,
                "open_price": float(candle[0]), "high_price": float(candle[1]),
                "low_price": float(candle[2]), "close_price": float(candle[3]),
                "volume": float(candle[4] or 0),
                "trader_count": int(candle[6] or 0) if len(candle) > 6 else None,
                "closed": 1, "source": "cmc_rest", "updated_at": at,
            })
        with SessionLocal() as db:
            if candle_values:
                stmt = dialect_insert(MarketCandle).values(candle_values)
                mutable = {
                    key: getattr(stmt.excluded, key) for key in (
                        "close_time", "open_price", "high_price", "low_price",
                        "close_price", "volume", "trader_count", "closed",
                        "source", "updated_at",
                    )
                }
                if db.bind.dialect.name == "postgresql":
                    stmt = stmt.on_conflict_do_update(
                        constraint="uq_market_candle_identity", set_=mutable)
                else:
                    stmt = stmt.on_conflict_do_update(
                        index_elements=["cmc_id", "platform", "contract_address", "interval", "open_time"],
                        set_=mutable)
                db.execute(stmt)
            actual_start = min(returned_times) if returned_times else start_ms
            actual_end = max(returned_times) + width if returned_times else end_ms
            coverage_values = {
                "cmc_id": cmc_id, "platform": platform,
                "contract_address": address.lower(), "interval": interval,
                "start_time": actual_start, "end_time": actual_end, "updated_at": at,
            }
            old = db.query(CandleCoverage).filter(
                CandleCoverage.cmc_id == cmc_id, CandleCoverage.platform == platform,
                CandleCoverage.contract_address == address.lower(),
                CandleCoverage.interval == interval,
            ).first()
            if old:
                coverage_values["start_time"] = min(old.start_time, start_ms)
                coverage_values["end_time"] = max(old.end_time, end_ms)
            coverage_stmt = dialect_insert(CandleCoverage).values(**coverage_values)
            if db.bind.dialect.name == "postgresql":
                coverage_stmt = coverage_stmt.on_conflict_do_update(
                    constraint="uq_candle_coverage_identity", set_=coverage_values)
            else:
                coverage_stmt = coverage_stmt.on_conflict_do_update(
                    index_elements=["cmc_id", "platform", "contract_address", "interval"],
                    set_=coverage_values)
            db.execute(coverage_stmt)
            db.commit()

    def _persist_state(self, coarse: bool = False):
        at = now_ms()
        if coarse and self.state.last_event_at and self.state.last_event_at % 30_000 > 5_000:
            return
        values = {
            "provider": "coinmarketcap", "state": self.state.state,
            "last_event_at": self.state.last_event_at,
            "last_reconciled_at": self.state.last_reconciled_at,
            "reconnect_count": self.state.reconnect_count, "gap_count": self.state.gap_count,
            "error": self.state.error,
            "details_json": json.dumps({"subscriptions": self.state.subscriptions}),
            "updated_at": at,
        }
        with SessionLocal() as db:
            stmt = dialect_insert(ProviderStatus).values(**values)
            db.execute(stmt.on_conflict_do_update(index_elements=["provider"], set_=values))
            db.commit()
