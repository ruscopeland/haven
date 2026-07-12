"""On-demand CMC discovery: typeahead search + ensure-token-into-DB.

Used by the screener so users can find tokens that are not yet in the local
universe, then pull history and track them like any other token.

Search sources (in order):
  1. Local tokens table (fast, already tracked)
  2. CoinMarketCap public search (website data-api) for names/symbols
  3. Optional: match contract from CMC map/info when selecting

Ensure:
  Upserts tokens row + latest_ticker, optionally backfills OHLCV from CMC k-line,
  and returns the slug the rest of the app uses.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from database.db import SessionLocal
from database.models import Token, LatestTicker
from ingest.evm import make_slug, sanitize_display_symbol

# Official-ish public endpoints (same family as seed_cmc / cmc_ranking).
CMC_MAP_URL = "https://pro-api.coinmarketcap.com/public-api/v1/cryptocurrency/map"
CMC_DETAIL_URL = "https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail"
CMC_LISTINGS_URL = "https://pro-api.coinmarketcap.com/public-api/v3/cryptocurrency/listings/latest"
CMC_LOGO = "https://s2.coinmarketcap.com/static/img/coins/64x64/{id}.png"

# Platform slug → our chain_id
PLATFORM_TO_CHAIN = {
    "bnb": "bsc",
    "binance-smart-chain": "bsc",
    "bsc": "bsc",
    "ethereum": "ethereum",
    "eth": "ethereum",
    "base": "base",
}

SUPPORTED_CHAINS = set(PLATFORM_TO_CHAIN.values())
ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")

# In-process caches
_search_cache: dict[str, tuple[float, list[dict]]] = {}
_SEARCH_TTL = 120.0
# Full CMC map index for typeahead (list of compact dicts)
_map_cache: list[dict] = []
_map_cache_expires = 0.0
_MAP_TTL = float(os.environ.get("CMC_MAP_CACHE_SEC", str(6 * 3600)))
# Default 1500 listings is enough for CMC-like typeahead of liquid names
# without a multi-minute cold start. Raise via CMC_MAP_LIMIT if needed.
_MAP_LIMIT = int(os.environ.get("CMC_MAP_LIMIT", "1500"))


def _http_json(url: str, timeout: float = 25.0) -> dict | list | None:
    try:
        req = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 HavenScreener/1.0",
                "Origin": "https://coinmarketcap.com",
                "Referer": "https://coinmarketcap.com/",
            },
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


def _row_from_listing(token: dict, global_rank: int) -> dict | None:
    """Normalize a listings.latest row into typeahead index shape."""
    try:
        cmc_id = int(token["id"]) if token.get("id") is not None else None
    except (TypeError, ValueError):
        cmc_id = None
    rank = token.get("cmc_rank") or token.get("rank") or global_rank
    try:
        rank = int(rank)
    except (TypeError, ValueError):
        rank = global_rank

    chain = None
    addr = None
    platform = token.get("platform")
    if isinstance(platform, dict) and platform:
        pslug = (platform.get("slug") or "").lower()
        chain = PLATFORM_TO_CHAIN.get(pslug)
        addr = (platform.get("token_address") or "").strip().lower()
        if addr and not ADDR_RE.match(addr):
            chain, addr = None, None

    quote = None
    quotes = token.get("quote") or []
    if isinstance(quotes, list):
        for q in quotes:
            if q.get("symbol") == "USD":
                quote = q
                break
    elif isinstance(quotes, dict):
        quote = quotes.get("USD") or quotes.get("usd")

    return {
        "cmc_id": cmc_id,
        "name": (token.get("name") or "").strip(),
        "symbol": (token.get("symbol") or "").strip(),
        "slug": (token.get("slug") or "")[:120] or None,
        "rank": rank,
        "chain": chain,
        "contract_address": addr,
        "market_cap": float(quote["market_cap"]) if quote and quote.get("market_cap") is not None else None,
        "price": float(quote["price"]) if quote and quote.get("price") is not None else None,
        "volume_24h": float(quote["volume_24h"]) if quote and quote.get("volume_24h") is not None else None,
        "price_change_24h": (
            float(quote["percent_change_24h"])
            if quote and quote.get("percent_change_24h") is not None else None
        ),
    }


def _load_cmc_map(force: bool = False) -> list[dict]:
    """Build typeahead index from CMC listings (mcap rank) + map pages.

    Listings first so popular tokens (PEPE, etc.) are present even when their
    CMC id is high. Map pages add broader name coverage. Cached in memory.
    """
    global _map_cache, _map_cache_expires
    now = time.time()
    if not force and _map_cache and _map_cache_expires > now:
        return _map_cache

    by_id: dict[int, dict] = {}
    start = 1
    per_page = 200
    global_rank = 0
    listing_cap = min(_MAP_LIMIT, 3000)

    while len(by_id) < listing_cap:
        limit = min(per_page, listing_cap - len(by_id))
        qs = urllib.parse.urlencode({
            "start": str(start),
            "limit": str(limit),
            "convert": "USD",
        })
        payload = _http_json(f"{CMC_LISTINGS_URL}?{qs}", timeout=40)
        if not payload or not isinstance(payload, dict):
            break
        batch = payload.get("data") or []
        if not batch:
            break
        for token in batch:
            global_rank += 1
            row = _row_from_listing(token, global_rank)
            if row and row.get("cmc_id"):
                by_id[row["cmc_id"]] = row
        if len(batch) < limit:
            break
        start += limit
        time.sleep(0.3)

    # Map pages for broader coverage (name/symbol even without listing quote)
    start = 1
    while len(by_id) < _MAP_LIMIT:
        limit = min(per_page, _MAP_LIMIT - len(by_id) + 200)
        qs = urllib.parse.urlencode({
            "listing_status": "active",
            "start": str(start),
            "limit": str(limit),
        })
        payload = _http_json(f"{CMC_MAP_URL}?{qs}", timeout=40)
        if not payload or not isinstance(payload, dict):
            break
        batch = payload.get("data") or []
        if not batch:
            break
        for c in batch:
            if not isinstance(c, dict):
                continue
            try:
                cmc_id = int(c["id"]) if c.get("id") is not None else None
            except (TypeError, ValueError):
                cmc_id = None
            if not cmc_id or cmc_id in by_id:
                continue
            platform = c.get("platform") or {}
            chain = None
            addr = None
            if isinstance(platform, dict) and platform:
                pslug = (platform.get("slug") or "").lower()
                chain = PLATFORM_TO_CHAIN.get(pslug)
                addr = (platform.get("token_address") or "").strip().lower()
                if addr and not ADDR_RE.match(addr):
                    chain, addr = None, None
            rank = c.get("rank")
            try:
                rank = int(rank) if rank is not None else None
            except (TypeError, ValueError):
                rank = None
            by_id[cmc_id] = {
                "cmc_id": cmc_id,
                "name": (c.get("name") or "").strip(),
                "symbol": (c.get("symbol") or "").strip(),
                "slug": (c.get("slug") or "")[:120] or None,
                "rank": rank,
                "chain": chain,
                "contract_address": addr,
                "market_cap": None,
                "price": None,
                "volume_24h": None,
                "price_change_24h": None,
            }
        if len(batch) < limit:
            break
        start += limit
        time.sleep(0.25)

    out = list(by_id.values())
    if out:
        _map_cache = out
        _map_cache_expires = now + _MAP_TTL
    return _map_cache or out


def _logo(cmc_id: int | None) -> str | None:
    if not cmc_id:
        return None
    return CMC_LOGO.format(id=int(cmc_id))


def _local_hits(db, q: str, limit: int = 12) -> list[dict]:
    ql = q.strip().lower()
    if not ql:
        return []
    # Cheap Python filter — token table is product-sized, not millions.
    rows = (
        db.query(Token)
        .filter((Token.status.is_(None)) | (Token.status != "retired"))
        .all()
    )
    scored: list[tuple[int, Token]] = []
    for t in rows:
        disp = (t.display_symbol or "").lower()
        name = (t.name or "").lower()
        sym = (t.symbol or "").lower()
        slug = (t.cmc_slug or "").lower()
        addr = (t.contract_address or "").lower()
        hay = f"{disp} {name} {sym} {slug}"
        if ql in addr or ql in hay:
            # Prefer exact / prefix display matches
            score = 0
            if disp == ql or sym == ql or (t.symbol or "").lower() == ql:
                score = 0
            elif disp.startswith(ql) or name.startswith(ql):
                score = 1
            else:
                score = 2
            scored.append((score, t))
    scored.sort(key=lambda x: (x[0], x[1].cmc_rank or 10_000_000, -(x[1].market_cap or 0)))
    out = []
    for _, t in scored[:limit]:
        out.append({
            "source": "local",
            "in_db": True,
            "symbol": t.symbol,
            "display": t.display_symbol or t.name or t.symbol,
            "name": t.name,
            "chain": t.chain_id,
            "contract_address": t.contract_address,
            "cmc_id": t.cmc_id,
            "cmc_rank": t.cmc_rank,
            "cmc_slug": t.cmc_slug,
            "market_cap": t.market_cap,
            "logo_url": _logo(t.cmc_id),
            "status": t.status,
            "liquidity_usd": t.liquidity_usd,
        })
    return out


def _cmc_search_remote(q: str, limit: int = 12) -> list[dict]:
    """Filter a cached CMC cryptocurrency map (typeahead like the website)."""
    ql = q.strip()
    if len(ql) < 1:
        return []
    now = time.time()
    key = ql.lower()
    cached = _search_cache.get(key)
    if cached and cached[0] > now:
        return cached[1][:limit]

    index = _load_cmc_map()
    if not index:
        _search_cache[key] = (now + 30, [])
        return []

    ql_l = key
    scored: list[tuple[int, int, dict]] = []
    for c in index:
        sym = (c.get("symbol") or "").lower()
        name = (c.get("name") or "").lower()
        slug = (c.get("slug") or "").lower()
        if not (ql_l in sym or ql_l in name or ql_l in slug):
            continue
        if sym == ql_l:
            score = 0
        elif sym.startswith(ql_l) or name.startswith(ql_l):
            score = 1
        else:
            score = 2
        rank = c.get("rank") if c.get("rank") is not None else 9_999_999
        scored.append((score, rank, c))

    scored.sort(key=lambda x: (x[0], x[1]))
    rows: list[dict] = []
    for _, _, c in scored[:limit]:
        cmc_id = c.get("cmc_id")
        rows.append({
            "source": "cmc",
            "in_db": False,
            "symbol": None,  # filled on ensure
            "display": c.get("symbol") or c.get("name") or "TOKEN",
            "name": c.get("name") or c.get("symbol") or "Token",
            "chain": c.get("chain"),
            "contract_address": c.get("contract_address"),
            "cmc_id": cmc_id,
            "cmc_rank": c.get("rank"),
            "cmc_slug": c.get("slug"),
            "market_cap": c.get("market_cap"),
            "price": c.get("price"),
            "volume_24h": c.get("volume_24h"),
            "price_change_24h": c.get("price_change_24h"),
            "logo_url": _logo(cmc_id),
            "status": None,
            "liquidity_usd": None,
        })

    _search_cache[key] = (now + _SEARCH_TTL, rows)
    if len(_search_cache) > 500:
        for k in list(_search_cache.keys())[:200]:
            _search_cache.pop(k, None)
    return rows


def _enrich_cmc_detail(cmc_id: int) -> dict[str, Any]:
    """Pull contract platforms for a CMC id (search results often lack address)."""
    qs = urllib.parse.urlencode({"id": str(cmc_id)})
    payload = _http_json(f"{CMC_DETAIL_URL}?{qs}", timeout=25)
    if not payload or not isinstance(payload, dict):
        return {}
    data = payload.get("data") or {}
    # platforms / contractAddress variants
    platforms = data.get("platforms") or data.get("contractAddress") or []
    chain = None
    addr = None
    if isinstance(platforms, list):
        for p in platforms:
            if not isinstance(p, dict):
                continue
            pslug = (
                p.get("platformSlug")
                or p.get("slug")
                or p.get("name")
                or p.get("platform")
                or ""
            ).lower()
            ch = PLATFORM_TO_CHAIN.get(pslug)
            a = (
                p.get("contractAddress")
                or p.get("token_address")
                or p.get("address")
                or ""
            ).strip().lower()
            if ch and a and ADDR_RE.match(a):
                chain, addr = ch, a
                # Prefer BSC for trading engine today
                if ch == "bsc":
                    break
    quote = None
    stats = data.get("statistics") or data.get("quotes") or {}
    if isinstance(stats, dict):
        quote = stats.get("price") or stats.get("priceUsd")
    mc = None
    if isinstance(stats, dict):
        mc = stats.get("marketCap") or stats.get("market_cap")
    vol = None
    if isinstance(stats, dict):
        vol = stats.get("volume24h") or stats.get("volume_24h")
    chg = None
    if isinstance(stats, dict):
        chg = stats.get("priceChangePercentage24h") or stats.get("percent_change_24h")
    return {
        "chain": chain,
        "address": addr,
        "name": data.get("name"),
        "symbol": data.get("symbol"),
        "slug": data.get("slug"),
        "price": float(quote) if quote not in (None, "") else None,
        "market_cap": float(mc) if mc not in (None, "") else None,
        "volume_24h": float(vol) if vol not in (None, "") else None,
        "price_change_24h": float(chg) if chg not in (None, "") else None,
    }


def search_tokens(q: str, limit: int = 12) -> list[dict]:
    """Combined local + CMC typeahead results."""
    q = (q or "").strip()
    if len(q) < 1:
        return []
    db = SessionLocal()
    try:
        local = _local_hits(db, q, limit=limit)
        local_keys = {
            ((r.get("chain") or ""), (r.get("contract_address") or "").lower())
            for r in local if r.get("contract_address")
        }
        local_cmc = {r.get("cmc_id") for r in local if r.get("cmc_id")}
        remote = _cmc_search_remote(q, limit=limit)
        merged = list(local)
        for r in remote:
            key = ((r.get("chain") or ""), (r.get("contract_address") or "").lower())
            if r.get("contract_address") and key in local_keys:
                continue
            if r.get("cmc_id") and r["cmc_id"] in local_cmc:
                continue
            # Mark already-in-db if we have cmc_id match without address
            if r.get("cmc_id"):
                existing = db.query(Token).filter(Token.cmc_id == r["cmc_id"]).first()
                if existing:
                    r = {
                        **r,
                        "source": "local",
                        "in_db": True,
                        "symbol": existing.symbol,
                        "chain": existing.chain_id,
                        "contract_address": existing.contract_address,
                        "status": existing.status,
                    }
            merged.append(r)
            if len(merged) >= limit:
                break
        return merged[:limit]
    finally:
        db.close()


def ensure_token(
    *,
    cmc_id: int | None = None,
    chain: str | None = None,
    contract_address: str | None = None,
    display: str | None = None,
    name: str | None = None,
    cmc_slug: str | None = None,
    cmc_rank: int | None = None,
    market_cap: float | None = None,
    price: float | None = None,
    volume_24h: float | None = None,
    price_change_24h: float | None = None,
    backfill: bool = True,
    scan_security: bool = True,
) -> dict:
    """Upsert a token into the DB and optionally backfill history + GoPlus.

    Returns token row fields + optional security + backfill stats.
    Charting is always allowed; security may flag risk.
    """
    chain = (chain or "").strip().lower() or None
    addr = (contract_address or "").strip().lower() or None
    if addr and not ADDR_RE.match(addr):
        raise ValueError("Invalid contract address")

    # Enrich from CMC detail when we only have cmc_id
    if cmc_id and (not addr or not chain):
        detail = _enrich_cmc_detail(int(cmc_id))
        chain = chain or detail.get("chain")
        addr = addr or detail.get("address")
        name = name or detail.get("name")
        display = display or detail.get("symbol")
        cmc_slug = cmc_slug or detail.get("slug")
        price = price if price is not None else detail.get("price")
        market_cap = market_cap if market_cap is not None else detail.get("market_cap")
        volume_24h = volume_24h if volume_24h is not None else detail.get("volume_24h")
        price_change_24h = (
            price_change_24h if price_change_24h is not None
            else detail.get("price_change_24h")
        )

    if not addr or not chain:
        raise ValueError(
            "Need a supported EVM contract (bsc/ethereum/base). "
            "CMC entry has no usable contract on those chains."
        )
    if chain not in SUPPORTED_CHAINS:
        raise ValueError(f"Unsupported chain '{chain}' — use bsc, ethereum, or base")

    db = SessionLocal()
    now = int(time.time() * 1000)
    created = False
    try:
        tok = (
            db.query(Token)
            .filter(Token.chain_id == chain)
            .filter(Token.contract_address == addr)
            .first()
        )
        if not tok and cmc_id:
            tok = db.query(Token).filter(Token.cmc_id == int(cmc_id)).first()

        disp = sanitize_display_symbol(display or name or "TOKEN")
        full_name = (name or display or disp)[:120]

        if tok is None:
            taken = {r[0] for r in db.query(Token.symbol).all()}
            slug = make_slug(disp, chain, taken, addr)
            tok = Token(
                id=f"{chain}:{addr}",
                symbol=slug,
                name=full_name,
                chain_id=chain,
                contract_address=addr,
                display_symbol=disp[:32],
                market_cap=market_cap,
                cmc_rank=cmc_rank,
                cmc_slug=(cmc_slug or "")[:120] or None,
                cmc_id=int(cmc_id) if cmc_id else None,
                liquidity_usd=100_000.0,  # synthetic until pool sweep
                listed_at=now,
                status="active",
            )
            db.add(tok)
            created = True
        else:
            tok.name = full_name
            if disp:
                tok.display_symbol = disp[:32]
            if market_cap is not None:
                tok.market_cap = market_cap
            if cmc_rank is not None:
                tok.cmc_rank = cmc_rank
            if cmc_slug:
                tok.cmc_slug = cmc_slug[:120]
            if cmc_id:
                tok.cmc_id = int(cmc_id)
            if not tok.contract_address:
                tok.contract_address = addr
            if not tok.chain_id:
                tok.chain_id = chain
            # Revive retired so user-selected tokens stay chartable
            if tok.status == "retired":
                tok.status = "active"
            if not tok.liquidity_usd or tok.liquidity_usd < 50_000:
                tok.liquidity_usd = max(tok.liquidity_usd or 0, 100_000.0)

        tk = db.query(LatestTicker).filter(LatestTicker.symbol == tok.symbol).first()
        if not tk:
            tk = LatestTicker(symbol=tok.symbol)
            db.add(tk)
        if price is not None and price > 0:
            tk.last_price = float(price)
        if volume_24h is not None:
            tk.volume_24h = float(volume_24h)
        if price_change_24h is not None:
            tk.price_change_24h = float(price_change_24h)
        tk.last_updated = now

        db.commit()
        db.refresh(tok)
        symbol = tok.symbol
        chain_id = tok.chain_id
        contract = tok.contract_address
        display_out = tok.display_symbol
        status = tok.status
        cmc_id_out = tok.cmc_id
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    backfill_stats = None
    if backfill:
        try:
            from backfill_history import backfill_token
            db2 = SessionLocal()
            try:
                t2 = db2.query(Token).filter(Token.symbol == symbol).first()
                if t2:
                    backfill_stats = backfill_token(
                        db2, t2, daily=True, fifteen_min=True
                    )
                    db2.commit()
            finally:
                db2.close()
        except Exception as e:
            backfill_stats = {"error": str(e)}

    security = None
    if scan_security:
        try:
            from ingest.goplus import scan_one_token
            from ingest.chains import load_env_file
            load_env_file()
            db3 = SessionLocal()
            try:
                t3 = db3.query(Token).filter(Token.symbol == symbol).first()
                if t3 and t3.contract_address:
                    security = scan_one_token(
                        db3, t3, force=False, count_budget=True
                    )
            finally:
                db3.close()
        except Exception as e:
            security = {"error": str(e), "safe": None}

    return {
        "created": created,
        "symbol": symbol,
        "display": display_out,
        "name": full_name,
        "chain": chain_id,
        "contract_address": contract,
        "cmc_id": cmc_id_out,
        "status": status,
        "logo_url": _logo(cmc_id_out),
        "backfill": backfill_stats,
        "security": security,
        "chart_allowed": True,
    }


def trade_policy_from_security(sec: dict | None, status: str | None = None) -> dict:
    """Map GoPlus summary → UI/engine trade policy.

    Policy:
      - Always chart.
      - Elevated risk → warn; allow manual trade only with contract verify +
        warned ack; recommend small probe first.
    """
    probe = float(os.environ.get("HAVEN_RISK_PROBE_USD", "1"))
    warnings: list[str] = []
    critical: list[str] = []
    flags: list[str] = []
    safe = True

    if status == "blacklisted":
        safe = False
        critical.append("blacklisted")
        warnings.append(
            "This token is blacklisted in Haven (honeypot / extreme tax / scam flags)."
        )

    if sec:
        critical = list(sec.get("critical") or critical)
        flags = list(sec.get("flags") or [])
        if sec.get("safe") is False or critical:
            safe = False
        if sec.get("is_honeypot"):
            warnings.append("GoPlus reports HONEYPOT — you may not be able to sell.")
        if any(str(c).startswith("sell_tax") or str(c).startswith("buy_tax") for c in critical):
            warnings.append("High buy/sell tax reported — size will be eaten by fees.")
        if "cannot_sell_all" in flags or "cannot_sell_all" in critical:
            warnings.append("Cannot sell all — selling may be restricted.")
        if "cannot_buy" in flags:
            warnings.append("Buying may be restricted on this contract.")
        if "has_blacklist_fn" in flags:
            warnings.append(
                "Contract has a blacklist function — the creator can block your wallet "
                "after a small probe or on a larger buy."
            )
        if "airdrop_scam" in critical:
            warnings.append("Flagged as airdrop scam / phishing-style token.")
        if "possible_copycat" in critical:
            warnings.append("Possible copycat of a real project — verify contract carefully.")

    if not warnings and not safe:
        warnings.append("Security scan found elevated risk flags on this token.")

    if safe and not critical:
        return {
            "mode": "clear",
            "chart_allowed": True,
            "manual_trade_allowed": True,
            "require_contract_verify": False,
            "require_risk_ack": False,
            "recommend_probe_usd": probe,
            "require_large_ack_above_usd": None,
            "warnings": [],
            "critical": [],
            "flags": flags,
        }

    return {
        "mode": "elevated_risk",
        "chart_allowed": True,  # always chart
        "manual_trade_allowed": True,  # with acknowledgments
        "require_contract_verify": True,
        "require_risk_ack": True,
        "recommend_probe_usd": probe,
        "require_large_ack_above_usd": probe,
        "warnings": warnings
        + [
            f"If you still insist on trading, start with a small probe (about ${probe:.0f}) first.",
            "Even a successful small buy does not prove safety — the creator can still "
            "blacklist your wallet or block sells on the next try or a larger purchase.",
            "Manually verify the contract address on the explorer before proceeding. "
            "You have been warned.",
        ],
        "critical": critical,
        "flags": flags,
    }
