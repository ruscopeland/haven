"""Minimal async JSON-RPC client for EVM chains (aiohttp, already a dep).

Design (DATA-ROADMAP AD-D4): the ingester POLLS — eth_blockNumber +
eth_getLogs on a timer — instead of holding per-event subscriptions. Batch
requests put many calls in one HTTP round trip. Every call is counted so M2
can report the real provider-credit burn.
"""
import asyncio
import json

import aiohttp


class RpcError(Exception):
    def __init__(self, message, code=None, data=None):
        super().__init__(message)
        self.code = code
        self.data = data


class RpcClient:
    def __init__(self, url: str, timeout_s: float = 30.0):
        self.url = url
        self.timeout = aiohttp.ClientTimeout(total=timeout_s)
        self._session: aiohttp.ClientSession | None = None
        self._id = 0
        # usage counters (credit-burn measurement, DATA-ROADMAP M2)
        self.calls = 0
        self.batch_items = 0

    async def _session_get(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=self.timeout)
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    async def call(self, method: str, params: list, retries: int = 3):
        """Single JSON-RPC call with exponential backoff on transport errors."""
        payload = {"jsonrpc": "2.0", "id": self._next_id(),
                   "method": method, "params": params}
        last_err = None
        for attempt in range(retries):
            try:
                session = await self._session_get()
                self.calls += 1
                async with session.post(self.url, json=payload) as resp:
                    if resp.status == 429:  # rate limited — back off, don't count as fatal
                        raise RpcError("rate limited", code=429)
                    body = await resp.json(content_type=None)
                if "error" in body:
                    err = body["error"]
                    # Provider errors (bad params, response too large) are not
                    # transient — surface immediately so callers can adapt
                    # (e.g. halve a getLogs block range).
                    raise RpcError(err.get("message", "rpc error"),
                                   code=err.get("code"), data=err.get("data"))
                return body.get("result")
            except RpcError as e:
                if e.code == 429 and attempt < retries - 1:
                    await asyncio.sleep(1.0 * (2 ** attempt))
                    last_err = e
                    continue
                raise
            except (aiohttp.ClientError, asyncio.TimeoutError, json.JSONDecodeError) as e:
                last_err = e
                if attempt < retries - 1:
                    await asyncio.sleep(0.5 * (2 ** attempt))
                    continue
                raise RpcError(f"transport error after {retries} tries: {e}") from e
        raise RpcError(f"unreachable: {last_err}")

    async def batch(self, requests: list[tuple[str, list]], retries: int = 3):
        """Batched JSON-RPC: [(method, params), …] → list of results (same order).

        A single item error raises RpcError with its message — callers treat a
        batch as all-or-nothing (bootstrap/sweep code retries at its own level).
        """
        if not requests:
            return []
        payload = [{"jsonrpc": "2.0", "id": i, "method": m, "params": p}
                   for i, (m, p) in enumerate(requests)]
        for attempt in range(retries):
            try:
                session = await self._session_get()
                self.calls += 1
                self.batch_items += len(requests)
                async with session.post(self.url, json=payload) as resp:
                    if resp.status == 429:
                        raise RpcError("rate limited", code=429)
                    body = await resp.json(content_type=None)
                if isinstance(body, dict):  # provider rejected the whole batch
                    err = body.get("error", {})
                    raise RpcError(err.get("message", "batch rejected"), code=err.get("code"))
                results = [None] * len(requests)
                for item in body:
                    if "error" in item:
                        err = item["error"]
                        raise RpcError(err.get("message", "rpc error in batch"),
                                       code=err.get("code"))
                    results[item["id"]] = item.get("result")
                return results
            except RpcError as e:
                if e.code == 429 and attempt < retries - 1:
                    await asyncio.sleep(1.0 * (2 ** attempt))
                    continue
                raise
            except (aiohttp.ClientError, asyncio.TimeoutError, json.JSONDecodeError) as e:
                if attempt < retries - 1:
                    await asyncio.sleep(0.5 * (2 ** attempt))
                    continue
                raise RpcError(f"batch transport error: {e}") from e

    # ── Convenience wrappers ─────────────────────────────────────────────────

    async def block_number(self) -> int:
        return int(await self.call("eth_blockNumber", []), 16)

    async def get_block_timestamp(self, block_number: int) -> int:
        """Block timestamp in unix SECONDS (header-only fetch)."""
        blk = await self.call("eth_getBlockByNumber", [hex(block_number), False])
        return int(blk["timestamp"], 16)

    async def get_logs(self, from_block: int, to_block: int,
                       addresses: list[str] | None, topics: list) -> list[dict]:
        params = {"fromBlock": hex(from_block), "toBlock": hex(to_block),
                  "topics": topics}
        if addresses:
            params["address"] = addresses
        return await self.call("eth_getLogs", [params])

    async def eth_call(self, to: str, data: str) -> str:
        return await self.call("eth_call", [{"to": to, "data": data}, "latest"])
