"""Per-chain universe manager (DATA-ROADMAP AD-D6).

Owns the pools/tokens tables for one chain: bootstrap seeding, new-pool
probation, metadata fetch, the liquidity sweep with floor/2 hysteresis, and
the in-memory pool-context map the ingester decodes against.

Bootstrap sources (cheap-first, in order):
1. quote + native tokens from the chain registry (hardcoded metadata),
2. the legacy Alpha token list already in our DB (contract addresses known —
   guarantees every token the owner's strategies use is covered on day one),
3. a recent-window factory scan (default 30 days; genesis deep-scan = M5).
"""
import asyncio
import re
import time

from database.db import SessionLocal
from database.models import Token, Pool

from . import evm
from .chains import CHAINS, LEGACY_CHAIN_ID_MAP, MULTICALL3, STAGED
from .rpc import RpcClient, RpcError
from .store import log, now_ms, write_debug_log

EVM_ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
SEL_GET_RESERVES = "0x0902f1ac"
SEL_SLOT0 = "0x3850c7bd"


class UniverseManager:
    def __init__(self, chain: str, rpc: RpcClient):
        self.chain = chain
        self.cfg = CHAINS[chain]
        self.rpc = rpc
        self.quotes: dict = self.cfg["quotes"]          # addr → (sym, dec, pegged)
        self.native_addr: str = self.cfg["native"]["address"]
        self.native_usd: float = 0.0                     # updated live by the ingester
        self.anchor_pool: str | None = None              # native/stable pool address
        # pool address (lowercase, no chain prefix) → decode context
        self.pool_ctx: dict[str, dict] = {}
        self.candidates: dict[str, dict] = {}            # probation pools awaiting sweep
        self._slugs_taken: set = set()

    # ── helpers ──────────────────────────────────────────────────────────────

    def _tid(self, addr: str) -> str:
        return f"{self.chain}:{addr.lower()}"

    def _pid(self, addr: str) -> str:
        return f"{self.chain}:{addr.lower()}"

    def quote_usd(self, quote_addr: str) -> float:
        info = self.quotes.get(quote_addr)
        if not info:
            return 0.0
        return 1.0 if info[2] else self.native_usd

    async def _multicall(self, calls: list[tuple[str, str]]) -> list[tuple[bool, str]]:
        """aggregate3 in chunks of 300 targets."""
        out: list[tuple[bool, str]] = []
        for i in range(0, len(calls), 300):
            chunk = calls[i:i + 300]
            data = evm.encode_aggregate3(chunk)
            res = await self.rpc.eth_call(MULTICALL3, data)
            out.extend(evm.decode_aggregate3(res, len(chunk)))
        return out

    # ── Bootstrap ────────────────────────────────────────────────────────────

    async def bootstrap(self):
        db = SessionLocal()
        try:
            # Repair orphaned pools first: an UNPATCHED old Binance collector's
            # token sync can delete new-format token rows (seen live 2026-07-07
            # — its parallel-run guard only takes effect after ITS restart).
            # A pool whose token row vanished is useless to the decode map —
            # drop it so the candidate probe below recreates both rows fresh.
            token_ids = {t.id for t in
                         db.query(Token).filter(Token.chain_id == self.chain).all()}
            orphans = [p for p in db.query(Pool).filter(Pool.chain == self.chain).all()
                       if p.token_id not in token_ids]
            for p in orphans:
                db.delete(p)
            if orphans:
                db.commit()
                log(f"[{self.chain}] repaired {len(orphans)} orphaned pool(s) "
                    f"(token rows were deleted externally — re-probing)", "WARNING")
                write_debug_log("ERROR",
                                f"[{self.chain}] {len(orphans)} orphaned pools repaired — "
                                f"is an unpatched old collector running?")
            # Existing new-format rows (idempotent restart) + slug reservations.
            for t in db.query(Token).filter(Token.chain_id == self.chain).all():
                self._slugs_taken.add(t.symbol)
            existing_pools = {p.id: p for p in
                              db.query(Pool).filter(Pool.chain == self.chain).all()}
        finally:
            db.close()

        await self._ensure_quote_tokens()
        await self._discover_anchor()

        candidates = set()
        candidates |= await self._seed_from_legacy_tokens()
        candidates |= await self._scan_recent_factory_events()
        # The anchor (queued by _discover_anchor) is probed NOW, not at the
        # first sweep — the native price feed depends on it being watched.
        candidates |= {(p, c["token"], c["quote"], c["dex"], c["kind"], c["fee"])
                       for p, c in self.candidates.items()}
        self.candidates.clear()
        # Never re-probe pools we already track.
        candidates = {c for c in candidates
                      if self._pid(c[0]) not in existing_pools}

        if candidates:
            await self._probe_and_add(list(candidates))
        # Load every stored watch=1 pool into the decode map (restart path).
        self._load_ctx_from_db()
        log(f"[{self.chain}] universe ready: {len(self.pool_ctx)} watched pools, "
            f"anchor={self.anchor_pool}, native≈${self.native_usd:,.2f}")
        write_debug_log("INFO", f"[{self.chain}] universe ready: "
                                f"{len(self.pool_ctx)} pools watched")

    async def _ensure_quote_tokens(self):
        """Quote + native tokens exist as active token rows (they ARE tokens)."""
        db = SessionLocal()
        try:
            for addr, (sym, dec, _pegged) in self.quotes.items():
                tid = self._tid(addr)
                if not db.query(Token).filter_by(id=tid).first():
                    slug = evm.make_slug(sym, self.chain, self._slugs_taken, addr)
                    self._slugs_taken.add(slug)
                    db.add(Token(id=tid, symbol=slug, name=sym, chain_id=self.chain,
                                 contract_address=addr, display_symbol=sym,
                                 decimals=dec, status="active", listed_at=now_ms()))
            db.commit()
        finally:
            db.close()

    async def _discover_anchor(self):
        """Find the deepest native/stable pool via factory calls; set native_usd."""
        stables = [a for a, info in self.quotes.items() if info[2]]
        v2 = [f for f in self.cfg["factories"] if f["kind"] == "v2"]
        best = (0.0, None, None)  # (stable_balance, pool_addr, stable_addr)
        calls, meta = [], []
        for f in v2:
            for s in stables:
                calls.append((f["address"], evm.calldata_v2_get_pair(self.native_addr, s)))
                meta.append(s)
        for f in (f for f in self.cfg["factories"] if f["kind"] == "v3"):
            for s in stables:
                for fee in self.cfg["v3_fee_tiers"]:
                    calls.append((f["address"],
                                  evm.calldata_v3_get_pool(self.native_addr, s, fee)))
                    meta.append(s)
        results = await self._multicall(calls)
        pools = [(evm.word_address(r, 0), meta[i])
                 for i, (ok, r) in enumerate(results)
                 if ok and evm.word_address(r, 0) != evm.ZERO_ADDRESS]
        if not pools:
            raise RuntimeError(f"[{self.chain}] no native/stable anchor pool found — "
                               "check factory addresses in chains.py")
        bal_calls = [(s, evm.calldata_balance_of(p)) for p, s in pools]
        bals = await self._multicall(bal_calls)
        for (pool, stable), (ok, r) in zip(pools, bals):
            if not ok:
                continue
            dec = self.quotes[stable][1]
            bal = evm.uint(r, 0) / 10 ** dec
            if bal > best[0]:
                best = (bal, pool, stable)
        _, self.anchor_pool, anchor_stable = best
        # Kind detection: v2 getReserves() reverts on a v3 pool.
        try:
            reserves = await self.rpc.eth_call(self.anchor_pool, SEL_GET_RESERVES)
            anchor_kind = "v2"
        except RpcError:
            reserves = None
            anchor_kind = "v3"
        # Initial native price: v2 = reserves ratio; v3 = slot0 sqrtPrice
        # (balance ratios are MEANINGLESS on v3 — concentrated liquidity).
        native_dec = self.cfg["native"]["decimals"]
        stable_dec = self.quotes[anchor_stable][1]
        native_is_token0 = self.native_addr.lower() < anchor_stable.lower()
        if anchor_kind == "v2" and reserves:
            r0, r1 = evm.uint(reserves, 0), evm.uint(reserves, 1)
            r_nat, r_stb = (r0, r1) if native_is_token0 else (r1, r0)
            p = evm.v2_price_from_reserves(r_nat, r_stb, native_dec, stable_dec, 1.0)
            if p:
                self.native_usd = p
        else:
            slot0 = await self.rpc.eth_call(self.anchor_pool, SEL_SLOT0)
            sqrt_p = evm.uint(slot0, 0)
            if native_is_token0:
                self.native_usd = evm.price_from_sqrt_x96(sqrt_p, native_dec, stable_dec)
            else:
                p = evm.price_from_sqrt_x96(sqrt_p, stable_dec, native_dec)
                self.native_usd = 1.0 / p if p > 0 else 0.0
        # The anchor is watched like any pool; its "ranked token" is the native.
        self.candidates[self.anchor_pool.lower()] = {
            "token": self.native_addr, "quote": anchor_stable,
            "dex": "anchor", "kind": anchor_kind, "fee": 0,
        }

    async def _seed_from_legacy_tokens(self) -> set:
        """Candidate (pool, token, quote, dex, kind, fee) for known Alpha tokens."""
        db = SessionLocal()
        try:
            legacy = db.query(Token).filter(~Token.id.contains(":")).all()
        finally:
            db.close()
        addrs = []
        for t in legacy:
            slug_chain = LEGACY_CHAIN_ID_MAP.get(str(t.chain_id or ""))
            if slug_chain == self.chain and t.contract_address \
                    and EVM_ADDR_RE.match(t.contract_address):
                addrs.append(t.contract_address.lower())
        if not addrs:
            return set()
        found = set()
        calls, meta = [], []
        for f in self.cfg["factories"]:
            for a in addrs:
                for q in self.quotes:
                    if f["kind"] == "v2":
                        calls.append((f["address"], evm.calldata_v2_get_pair(a, q)))
                        meta.append((a, q, f["dex"], "v2", 0))
                    else:
                        for fee in self.cfg["v3_fee_tiers"]:
                            calls.append((f["address"], evm.calldata_v3_get_pool(a, q, fee)))
                            meta.append((a, q, f["dex"], "v3", fee))
        results = await self._multicall(calls)
        for (a, q, dex, kind, fee), (ok, r) in zip(meta, results):
            if not ok:
                continue
            pool = evm.word_address(r, 0)
            if pool != evm.ZERO_ADDRESS:
                found.add((pool, a, q, dex, kind, fee))
        log(f"[{self.chain}] legacy-token seed: {len(addrs)} tokens → "
            f"{len(found)} candidate pools")
        return found

    async def _scan_recent_factory_events(self) -> set:
        """PairCreated/PoolCreated over the recent window, quote-filtered by topic.

        Runs on the bulk-scan lane (public RPC) — Alchemy's free tier caps
        getLogs at 10 blocks, useless for a 30-day sweep. A dead scan lane is
        NOT fatal: we log loudly and continue with the legacy seed + the
        forward factory watch (the universe grows from today instead).
        """
        from .chains import scan_rpc_url
        days = self.cfg.get("recent_pool_scan_days", 30)
        scan_url = scan_rpc_url(self.chain)
        scan_rpc = RpcClient(scan_url) if scan_url else self.rpc
        head = await self.rpc.block_number()
        span = int(days * 86_400 / self.cfg["block_time"])
        start = max(1, head - span)
        found = set()
        quote_topics = ["0x" + evm.pad_address(q) for q in self.quotes]

        async def scan(factory, kind, dex, topic0, position):
            lo, step = start, 50_000
            while lo <= head:
                hi = min(lo + step - 1, head)
                topics = [topic0, None, None]
                topics[position] = quote_topics  # OR-list on token0 or token1
                try:
                    logs = await scan_rpc.get_logs(lo, hi, [factory["address"]], topics)
                except RpcError:
                    if step > 500:   # response too large / range cap — halve
                        step //= 2
                        continue
                    raise
                for lg in logs:
                    d = (evm.decode_v2_pair_created(lg) if kind == "v2"
                         else evm.decode_v3_pool_created(lg))
                    t0, t1 = d["token0"], d["token1"]
                    if t0 in self.quotes and t1 in self.quotes:
                        continue  # quote/quote pool — not a ranked token
                    token = t1 if t0 in self.quotes else t0
                    quote = t0 if t0 in self.quotes else t1
                    found.add((d["pool"], token, quote, dex, kind, d["fee"]))
                lo = hi + 1

        try:
            tasks = []
            for f in self.cfg["factories"]:
                topic0 = (evm.TOPIC_V2_PAIR_CREATED if f["kind"] == "v2"
                          else evm.TOPIC_V3_POOL_CREATED)
                tasks.append(scan(f, f["kind"], f["dex"], topic0, 1))
                tasks.append(scan(f, f["kind"], f["dex"], topic0, 2))
            await asyncio.gather(*tasks)
            log(f"[{self.chain}] factory scan ({days}d): {len(found)} candidate pools")
        except Exception as e:
            log(f"[{self.chain}] factory scan failed ({e}) — continuing with "
                f"legacy seed + forward watch only", "WARNING")
            write_debug_log("ERROR", f"[{self.chain}] bootstrap factory scan failed: {e}")
        finally:
            if scan_rpc is not self.rpc:
                await scan_rpc.close()
        return found

    # ── Probation → tokens/pools rows ────────────────────────────────────────

    async def _probe_and_add(self, cands: list[tuple]):
        """Liquidity-check candidates; add tokens+pools for those ≥ the floor."""
        floor = self.cfg["liquidity_floor_usd"]
        bal_calls = [(q, evm.calldata_balance_of(p)) for p, _t, q, _d, _k, _f in cands]
        bals = await self._multicall(bal_calls)
        keep = []
        for cand, (ok, r) in zip(cands, bals):
            if not ok:
                continue
            pool, token, quote, dex, kind, fee = cand
            liq = 2 * (evm.uint(r, 0) / 10 ** self.quotes[quote][1]) * self.quote_usd(quote)
            if liq >= floor:
                keep.append((cand, liq))
        if not keep:
            return
        # token0/token1 ordering (Uniswap sorts by address) + metadata.
        token_addrs = sorted({t for (p, t, q, d, k, f), _ in keep})
        meta_calls = []
        for a in token_addrs:
            meta_calls += [(a, evm.SEL_SYMBOL), (a, evm.SEL_NAME),
                           (a, evm.SEL_DECIMALS), (a, evm.SEL_TOTAL_SUPPLY)]
        metas = await self._multicall(meta_calls)
        token_meta = {}
        for i, a in enumerate(token_addrs):
            ok_s, sym = metas[i * 4]
            ok_n, nam = metas[i * 4 + 1]
            ok_d, dec = metas[i * 4 + 2]
            ok_t, sup = metas[i * 4 + 3]
            if not ok_d:
                continue  # not a readable ERC-20 — skip entirely
            decimals = evm.uint(dec, 0)
            if decimals > 36:
                continue
            token_meta[a] = {
                "symbol": evm.sanitize_display_symbol(evm.decode_string_result(sym) if ok_s else ""),
                "name": (evm.decode_string_result(nam) if ok_n else "")[:80],
                "decimals": decimals,
                "supply": (evm.uint(sup, 0) / 10 ** decimals) if ok_t else None,
            }

        db = SessionLocal()
        added_t = added_p = 0
        # autoflush is OFF on SessionLocal — rows added this batch are invisible
        # to queries, so track them locally or a multi-pool token INSERTs twice.
        batch_rows: dict[str, Token] = {}
        batch_pools: set[str] = set()
        try:
            for (pool, token, quote, dex, kind, fee), liq in keep:
                is_native = token == self.native_addr
                m = token_meta.get(token)
                if m is None and not is_native:
                    continue
                tid = self._tid(token)
                row = batch_rows.get(tid) or db.query(Token).filter_by(id=tid).first()
                if row is None:
                    display = (self.cfg["native"]["symbol"] if is_native
                               else m["symbol"])
                    slug = evm.make_slug(display, self.chain, self._slugs_taken, token)
                    self._slugs_taken.add(slug)
                    row = Token(id=tid, symbol=slug, name=None if is_native else m["name"],
                                chain_id=self.chain, contract_address=token,
                                display_symbol=display,
                                decimals=self.cfg["native"]["decimals"] if is_native else m["decimals"],
                                total_supply=None if is_native else m["supply"],
                                liquidity_usd=liq, listed_at=now_ms(), status=STAGED)
                    db.add(row)
                    added_t += 1
                elif (row.liquidity_usd or 0) < liq:
                    row.liquidity_usd = liq
                batch_rows[tid] = row
                pid = self._pid(pool)
                if pid not in batch_pools \
                        and not db.query(Pool).filter_by(id=pid).first():
                    db.add(Pool(id=pid, chain=self.chain, dex=dex, kind=kind,
                                token_id=tid, quote_address=quote,
                                token_is_token0=1 if token.lower() < quote.lower() else 0,
                                fee_tier=fee, liquidity_usd=liq, watch=1,
                                created_at=now_ms(), last_checked=now_ms()))
                    batch_pools.add(pid)
                    added_p += 1
                if not row.primary_pool or (row.liquidity_usd or 0) <= liq:
                    row.primary_pool = pid
            db.commit()
            log(f"[{self.chain}] added {added_t} tokens / {added_p} pools over "
                f"${floor:,.0f} floor")
        except Exception as e:
            db.rollback()
            log(f"[{self.chain}] probe/add failed (batch rolled back): {e}", "ERROR")
            write_debug_log("ERROR", f"[{self.chain}] probe/add failed: {e}")
        finally:
            db.close()

    def _load_ctx_from_db(self):
        """(Re)build the in-memory decode map from watched pools."""
        db = SessionLocal()
        try:
            tokens = {t.id: t for t in
                      db.query(Token).filter(Token.chain_id == self.chain).all()}
            self.pool_ctx = {}
            for p in db.query(Pool).filter_by(chain=self.chain, watch=1).all():
                t = tokens.get(p.token_id)
                q = self.quotes.get(p.quote_address)
                if not t or not q or t.decimals is None:
                    continue
                addr = p.id.split(":", 1)[1]
                self.pool_ctx[addr] = {
                    "kind": p.kind, "slug": t.symbol,
                    "token_is_token0": bool(p.token_is_token0),
                    "token_decimals": t.decimals, "quote_addr": p.quote_address,
                    "quote_decimals": q[1], "pegged": q[2],
                }
        finally:
            db.close()

    # ── Live additions + periodic sweep ──────────────────────────────────────

    def on_pool_created(self, decoded: dict, dex: str, kind: str):
        t0, t1 = decoded["token0"], decoded["token1"]
        if (t0 in self.quotes) == (t1 in self.quotes):
            return  # neither or both are quotes — unpriceable/uninteresting
        token = t1 if t0 in self.quotes else t0
        quote = t0 if t0 in self.quotes else t1
        self.candidates[decoded["pool"].lower()] = {
            "token": token, "quote": quote, "dex": dex, "kind": kind,
            "fee": decoded.get("fee", 0)}

    async def sweep(self):
        """Every 10 min: probe candidates; hourly-ish: re-check watched pools."""
        if self.candidates:
            cands = [(p, c["token"], c["quote"], c["dex"], c["kind"], c["fee"])
                     for p, c in list(self.candidates.items())]
            self.candidates.clear()
            try:
                await self._probe_and_add(cands)
                self._load_ctx_from_db()
            except Exception as e:
                log(f"[{self.chain}] candidate sweep failed: {e}", "ERROR")
        # Liquidity re-check with floor/2 hysteresis.
        db = SessionLocal()
        try:
            pools = db.query(Pool).filter_by(chain=self.chain, watch=1).all()
            stale = [p for p in pools
                     if now_ms() - (p.last_checked or 0) > 3_600_000]
            if not stale:
                return
            bals = await self._multicall(
                [(p.quote_address, evm.calldata_balance_of(p.id.split(":", 1)[1]))
                 for p in stale])
            floor = self.cfg["liquidity_floor_usd"]
            dropped = 0
            for p, (ok, r) in zip(stale, bals):
                p.last_checked = now_ms()
                if not ok:
                    continue
                dec = self.quotes[p.quote_address][1]
                liq = 2 * (evm.uint(r, 0) / 10 ** dec) * self.quote_usd(p.quote_address)
                p.liquidity_usd = liq
                if liq < floor / 2 and p.id.split(":", 1)[1] != (self.anchor_pool or "").lower():
                    p.watch = 0
                    dropped += 1
                tok = db.query(Token).filter_by(id=p.token_id).first()
                if tok and tok.primary_pool == p.id:
                    tok.liquidity_usd = liq
            db.commit()
            if dropped:
                log(f"[{self.chain}] sweep dropped {dropped} pool(s) below "
                    f"${floor / 2:,.0f}")
                self._load_ctx_from_db()
        except Exception as e:
            db.rollback()
            log(f"[{self.chain}] liquidity sweep failed: {e}", "ERROR")
        finally:
            db.close()
