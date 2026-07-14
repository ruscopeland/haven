"""Small authenticated client for documented CoinMarketCap Startup APIs."""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from typing import Any

import aiohttp


REST_BASE = "https://pro-api.coinmarketcap.com"
WS_URL = "wss://pro-stream.coinmarketcap.com/v1"


class CmcError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


@dataclass(frozen=True)
class CmcResponse:
    data: Any
    status: dict


class CmcClient:
    """Authenticated REST client with bounded retries and no key leakage."""

    def __init__(self, api_key: str | None = None, session: aiohttp.ClientSession | None = None):
        self.api_key = (api_key or os.environ.get("CMC_API_KEY", "")).strip()
        self._session = session
        self._owns_session = session is None
        self.last_credit_count = 0

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    async def __aenter__(self):
        if self._session is None:
            timeout = aiohttp.ClientTimeout(total=35, connect=10)
            self._session = aiohttp.ClientSession(timeout=timeout)
        return self

    async def __aexit__(self, *_):
        if self._owns_session and self._session:
            await self._session.close()
        self._session = None

    async def get(self, path: str, params: dict | None = None, *, attempts: int = 3) -> CmcResponse:
        if not self.configured:
            raise CmcError("CMC_API_KEY is not configured")
        if not path.startswith("/"):
            raise ValueError("CMC path must start with /")
        if self._session is None:
            raise RuntimeError("CmcClient must be used as an async context manager")

        headers = {"Accept": "application/json", "X-CMC_PRO_API_KEY": self.api_key}
        for attempt in range(attempts):
            try:
                async with self._session.get(REST_BASE + path, params=params, headers=headers) as response:
                    payload = await response.json(content_type=None)
                    cmc_status = payload.get("status") if isinstance(payload, dict) else {}
                    cmc_status = cmc_status or {}
                    self.last_credit_count = int(cmc_status.get("credit_count") or 0)
                    error_code = int(cmc_status.get("error_code") or 0)
                    if response.status < 400 and error_code == 0:
                        data = payload.get("data", payload) if isinstance(payload, dict) else payload
                        return CmcResponse(data=data, status=cmc_status)
                    message = cmc_status.get("error_message") or f"CMC HTTP {response.status}"
                    retryable = response.status in (408, 429, 500, 502, 503, 504)
                    if not retryable or attempt == attempts - 1:
                        raise CmcError(message, status=response.status, retryable=retryable)
            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                if attempt == attempts - 1:
                    raise CmcError(f"CMC request failed: {type(exc).__name__}", retryable=True) from exc
            await asyncio.sleep(min(8.0, 0.5 * (2 ** attempt)))
        raise AssertionError("unreachable")

    async def listings(self, *, limit: int = 500) -> CmcResponse:
        return await self.get("/v3/cryptocurrency/listings/latest", {
            "start": 1, "limit": min(max(limit, 1), 5000), "convert": "USD",
            "aux": "platform,date_added,max_supply,circulating_supply,total_supply,cmc_rank",
        })

    async def metadata(self, cmc_ids: list[int]) -> CmcResponse:
        return await self.get("/v2/cryptocurrency/info", {
            "id": ",".join(str(i) for i in cmc_ids[:100]),
            "aux": "urls,logo,description,tags,platform,date_added,notice",
        })

    async def quotes(self, cmc_ids: list[int]) -> CmcResponse:
        return await self.get("/v3/cryptocurrency/quotes/latest", {
            "id": ",".join(str(i) for i in cmc_ids[:100]), "convert": "USD",
            "aux": "cmc_rank,num_market_pairs,circulating_supply,total_supply,max_supply",
            "skip_invalid": "true",
        })

    async def dex_candles(self, *, platform: str, address: str, interval: str,
                          start_s: int | None = None, end_s: int | None = None,
                          limit: int = 1000) -> CmcResponse:
        params = {
            "platform": platform, "address": address, "interval": interval,
            "limit": min(max(limit, 1), 1000),
            "unit": "usd", "pm": "p",
        }
        if start_s is not None:
            params["from"] = start_s
        if end_s is not None:
            params["to"] = end_s
        return await self.get("/v1/k-line/candles", params)

    async def security(self, *, platform: str, address: str) -> CmcResponse:
        return await self.get("/v1/dex/security/detail", {
            "platformName": platform, "address": address,
        })

    async def key_info(self) -> CmcResponse:
        return await self.get("/v1/key/info", attempts=2)
