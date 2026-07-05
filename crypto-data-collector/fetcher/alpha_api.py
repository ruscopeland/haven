import aiohttp
import asyncio

class BinanceAlphaAPI:
    BASE_URL = "https://www.binance.com/bapi/defi/v1"

    def __init__(self):
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        }
        self.session = None

    async def _get_session(self):
        if self.session is None or self.session.closed:
            self.session = aiohttp.ClientSession(headers=self.headers)
        return self.session

    async def close(self):
        if self.session and not self.session.closed:
            await self.session.close()

    async def get_all_tokens(self):
        session = await self._get_session()
        url = f"{self.BASE_URL}/public/wallet-direct/buw/wallet/cex/alpha/all/token/list"
        async with session.get(url) as response:
            response.raise_for_status()
            return await response.json()

    async def get_ticker(self, symbol: str):
        session = await self._get_session()
        url = f"{self.BASE_URL}/public/alpha-trade/ticker"
        params = {"symbol": symbol}
        async with session.get(url, params=params) as response:
            response.raise_for_status()
            return await response.json()

    async def get_agg_trades(self, symbol: str, limit: int = 1000):
        session = await self._get_session()
        url = f"{self.BASE_URL}/public/alpha-trade/agg-trades"
        params = {"symbol": symbol, "limit": limit}
        async with session.get(url, params=params) as response:
            response.raise_for_status()
            return await response.json()

    async def get_klines(self, symbol: str, interval: str = "1m", limit: int = 1000):
        session = await self._get_session()
        url = f"{self.BASE_URL}/public/alpha-trade/klines"
        params = {"symbol": symbol, "interval": interval, "limit": limit}
        async with session.get(url, params=params) as response:
            response.raise_for_status()
            return await response.json()

    async def get_exchange_info(self):
        session = await self._get_session()
        url = f"{self.BASE_URL}/public/alpha-trade/get-exchange-info"
        async with session.get(url) as response:
            response.raise_for_status()
            return await response.json()
