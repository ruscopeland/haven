"""Server-side Binance Alpha catalogue, ticker, and closed-candle cache."""
from __future__ import annotations

import asyncio
import json
import os
import time

from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from database.db import SessionLocal
from database.models import AlphaAsset, CandleCoverage, LatestTicker, MarketCandle, ProviderStatus, Token
from .alpha_client import AlphaError, BinanceAlphaClient

INTERVAL_MS = {"1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000,
               "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}


class BinanceAlphaMarketDataService:
    provider = "binance_alpha"

    def __init__(self):
        self.refresh_sec = max(15, int(os.environ.get("BINANCE_ALPHA_REFRESH_SEC", "60")))
        self._task: asyncio.Task | None = None

    async def start(self):
        await self.refresh()
        self._task = asyncio.create_task(self._run(), name="binance-alpha-refresh")

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run(self):
        while True:
            await asyncio.sleep(self.refresh_sec)
            try:
                await self.refresh()
            except AlphaError:
                pass

    @staticmethod
    def _number(value, default=None):
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    async def refresh(self):
        now = int(time.time() * 1000)
        try:
            async with BinanceAlphaClient() as client:
                rows = (await client.tokens()).data
            if not isinstance(rows, list):
                raise AlphaError("Binance Alpha returned an invalid token catalogue")
            db = SessionLocal()
            try:
                for rank, row in enumerate(rows, start=1):
                    if not isinstance(row, dict) or str(row.get("chainId")) != "56":
                        continue
                    alpha_id = str(row.get("alphaId") or "").strip()
                    address = str(row.get("contractAddress") or "").lower()
                    if not alpha_id or not address.startswith("0x"):
                        continue
                    values = {"alpha_id": alpha_id, "symbol": str(row.get("symbol") or alpha_id),
                              "name": str(row.get("name") or alpha_id), "rank": rank, "chain_id": "56",
                              "contract_address": address, "metadata_json": json.dumps(row, separators=(",", ":")),
                              "fetched_at": now, "expires_at": now + self.refresh_sec * 2000}
                    db.merge(AlphaAsset(**values))
                    token = db.query(Token).filter(Token.alpha_id == alpha_id).first()
                    if token is None:
                        token = Token(id=f"alpha:{alpha_id}:56", symbol=f"{row.get('symbol')}_{alpha_id}_bsc",
                                      alpha_id=alpha_id, chain_id="56", contract_address=address)
                        db.add(token)
                    token.name = values["name"]; token.display_symbol = values["symbol"]
                    token.contract_address = address; token.decimals = int(row.get("decimals") or 18)
                    token.liquidity_usd = self._number(row.get("liquidity")); token.market_cap = self._number(row.get("marketCap"))
                    token.alpha_rank = rank; token.status = "active"
                    ticker = db.get(LatestTicker, token.symbol) or LatestTicker(symbol=token.symbol)
                    ticker.last_price = self._number(row.get("price")); ticker.price_change_24h = self._number(row.get("percentChange24h"))
                    ticker.volume_24h = self._number(row.get("volume24h")); ticker.last_updated = now
                    db.merge(ticker)
                self._status(db, "connected", now, None, {"asset_count": len(rows), "transport": "REST polling"})
                db.commit()
            finally:
                db.close()
        except Exception as exc:
            db = SessionLocal()
            try:
                self._status(db, "error", now, str(exc), {})
                db.commit()
            finally:
                db.close()
            if isinstance(exc, AlphaError):
                raise

    @staticmethod
    def _status(db: Session, state: str, at: int, error: str | None, details: dict):
        row = db.get(ProviderStatus, "binance_alpha") or ProviderStatus(provider="binance_alpha", state=state, updated_at=at)
        row.state = state; row.last_event_at = at if state == "connected" else row.last_event_at
        row.last_reconciled_at = at if state == "connected" else row.last_reconciled_at
        row.error = error; row.details_json = json.dumps(details); row.updated_at = at
        db.merge(row)

    async def candles(self, *, alpha_id: str, interval: str, limit: int) -> list[MarketCandle]:
        if interval not in INTERVAL_MS:
            raise ValueError("Unsupported Binance Alpha candle interval")
        asset_db = SessionLocal()
        try:
            asset = asset_db.get(AlphaAsset, alpha_id)
            if not asset:
                raise ValueError("Unknown Binance Alpha asset")
            pair = f"{alpha_id}USDT"
            address = asset.contract_address
        finally:
            asset_db.close()
        async with BinanceAlphaClient() as client:
            raw = (await client.klines(pair, interval, limit)).data
        now = int(time.time() * 1000); width = INTERVAL_MS[interval]; db = SessionLocal()
        try:
            for row in raw if isinstance(raw, list) else []:
                if not isinstance(row, list) or len(row) < 7:
                    continue
                opened, closed = int(row[0]), int(row[6])
                values = {"alpha_id": alpha_id, "contract_address": address, "interval": interval,
                          "open_time": opened, "close_time": closed, "open_price": float(row[1]),
                          "high_price": float(row[2]), "low_price": float(row[3]), "close_price": float(row[4]),
                          "volume": float(row[5]), "trader_count": int(float(row[8] or 0)) if len(row) > 8 else None,
                          "closed": int(closed < now - 1000), "source": "binance_alpha", "updated_at": now}
                existing = (db.query(MarketCandle).filter_by(alpha_id=alpha_id, contract_address=address,
                            interval=interval, open_time=opened).first())
                if existing:
                    for key, value in values.items(): setattr(existing, key, value)
                else: db.add(MarketCandle(**values))
            db.commit()
            return (db.query(MarketCandle).filter_by(alpha_id=alpha_id, contract_address=address, interval=interval)
                    .order_by(MarketCandle.open_time.asc()).all())
        finally:
            db.close()
