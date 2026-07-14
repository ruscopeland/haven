"""Bounded client for Binance Alpha's public market-data endpoints."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import aiohttp

BASE_URL = "https://www.binance.com/bapi/defi/v1"


class AlphaError(RuntimeError):
    pass


@dataclass(frozen=True)
class AlphaResponse:
    data: Any


class BinanceAlphaClient:
    def __init__(self, session: aiohttp.ClientSession | None = None):
        self._session = session
        self._owns_session = session is None

    async def __aenter__(self):
        if self._session is None:
            self._session = aiohttp.ClientSession(
                headers={"User-Agent": "Haven/1.0 market-data"},
                timeout=aiohttp.ClientTimeout(total=30, connect=10),
            )
        return self

    async def __aexit__(self, *_):
        if self._owns_session and self._session:
            await self._session.close()
        self._session = None

    async def get(self, path: str, params: dict | None = None, attempts: int = 3) -> AlphaResponse:
        if self._session is None:
            raise RuntimeError("BinanceAlphaClient must be used as an async context manager")
        for attempt in range(attempts):
            try:
                async with self._session.get(BASE_URL + path, params=params) as response:
                    payload = await response.json(content_type=None)
                    if response.status < 400 and isinstance(payload, dict) and payload.get("code") == "000000":
                        return AlphaResponse(payload.get("data"))
                    message = payload.get("message") if isinstance(payload, dict) else None
                    if response.status not in (408, 429, 500, 502, 503, 504) or attempt == attempts - 1:
                        raise AlphaError(message or f"Binance Alpha HTTP {response.status}")
            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                if attempt == attempts - 1:
                    raise AlphaError(f"Binance Alpha request failed: {type(exc).__name__}") from exc
            await asyncio.sleep(0.5 * (2 ** attempt))
        raise AssertionError("unreachable")

    async def tokens(self) -> AlphaResponse:
        return await self.get("/public/wallet-direct/buw/wallet/cex/alpha/all/token/list")

    async def ticker(self, symbol: str) -> AlphaResponse:
        return await self.get("/public/alpha-trade/ticker", {"symbol": symbol})

    async def klines(self, symbol: str, interval: str, limit: int = 500) -> AlphaResponse:
        return await self.get("/public/alpha-trade/klines", {
            "symbol": symbol, "interval": interval, "limit": min(max(limit, 1), 1500),
        })
