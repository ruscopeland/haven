"""GoPlus Security integration (DATA-ROADMAP M7).

Quota-safe by design:
  - Only scans tokens that are already status=active AND liquidity_usd >= floor
    (garbage must be purged first — never scan 10k retired junk).
  - Hard daily budget (default 300 addresses/day).
  - Min interval between HTTP calls (default 3s).
  - Small batches (default 5 addresses per call).
  - Results cached in tokens.security_json; refresh only after N days.

Auth (docs.gopluslabs.io):
  POST /api/v1/token  with app_key, time, sign=sha1(app_key+time+app_secret)
  Access token string already includes the 'Bearer ' prefix — use as-is
  in the Authorization header.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from database.db import SessionLocal
from database.models import Token
from ingest.store import log, write_debug_log

# GoPlus chain_id for token_security/{chain_id}
CHAIN_TO_GOPLUS = {
    "ethereum": "1",
    "bsc": "56",
    "base": "8453",
}

TOKEN_URL = "https://api.gopluslabs.io/api/v1/token"
SECURITY_URL = "https://api.gopluslabs.io/api/v1/token_security/{chain_id}"

# Critical flags → status=blacklisted (hidden from screener)
CRITICAL_TRUE = (
    "is_honeypot",
    "is_airdrop_scam",
    "is_true_token",  # inverted handling — see assess()
)
# If sell_tax / buy_tax (0-1 or percent string) exceeds this → blacklist
MAX_TAX = 0.25  # 25%

# Soft flags stored for UI but do not auto-blacklist
SOFT_FLAGS = (
    "is_mintable",
    "is_proxy",
    "owner_change_balance",
    "can_take_back_ownership",
    "hidden_owner",
    "selfdestruct",
    "external_call",
    "is_blacklisted",
    "is_whitelisted",
    "transfer_pausable",
    "trading_cooldown",
    "is_anti_whale",
    "anti_whale_modifiable",
    "cannot_buy",
    "cannot_sell_all",
    "slippage_modifiable",
    "personal_slippage_modifiable",
)


def _cfg_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _cfg_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _min_liq() -> float:
    return _cfg_float("HAVEN_MIN_TOKEN_LIQUIDITY_USD", 100_000.0)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _parse_tax(val) -> float | None:
    if val is None or val == "":
        return None
    try:
        x = float(val)
    except (TypeError, ValueError):
        return None
    # GoPlus sometimes returns 0-1 fraction, sometimes 0-100 percent.
    if x > 1.0:
        x = x / 100.0
    return x


def assess(result: dict) -> dict:
    """Normalize one GoPlus token result into our risk summary."""
    flags = []
    critical = []

    def flag_true(key: str) -> bool:
        v = result.get(key)
        return str(v) == "1" or v is True or v == 1

    if flag_true("is_honeypot"):
        critical.append("honeypot")
        flags.append("honeypot")
    if flag_true("is_airdrop_scam"):
        critical.append("airdrop_scam")
        flags.append("airdrop_scam")
    # is_true_token: "1" means legitimate name match; "0" can mean fake/copycat
    # when present. Only flag when explicitly "0".
    if result.get("is_true_token") is not None and str(result.get("is_true_token")) == "0":
        flags.append("possible_copycat")

    buy_tax = _parse_tax(result.get("buy_tax"))
    sell_tax = _parse_tax(result.get("sell_tax"))
    if sell_tax is not None and sell_tax >= MAX_TAX:
        critical.append(f"sell_tax_{sell_tax:.0%}")
        flags.append(f"sell_tax_{sell_tax:.0%}")
    if buy_tax is not None and buy_tax >= MAX_TAX:
        critical.append(f"buy_tax_{buy_tax:.0%}")
        flags.append(f"buy_tax_{buy_tax:.0%}")

    if flag_true("cannot_sell_all") and flag_true("cannot_buy"):
        critical.append("cannot_trade")
        flags.append("cannot_trade")
    elif flag_true("cannot_sell_all"):
        flags.append("cannot_sell_all")
    elif flag_true("cannot_buy"):
        flags.append("cannot_buy")

    # Soft flags — rename a few GoPlus keys so the UI is less confusing
    # (is_blacklisted means "contract has a blacklist function", not "scam").
    soft_labels = {
        "is_blacklisted": "has_blacklist_fn",
        "is_whitelisted": "has_whitelist_fn",
        "is_mintable": "mintable",
        "is_proxy": "proxy_contract",
        "owner_change_balance": "owner_can_change_balance",
        "cannot_sell_all": "cannot_sell_all",
        "cannot_buy": "cannot_buy",
        "transfer_pausable": "transfer_pausable",
        "trading_cooldown": "trading_cooldown",
        "is_anti_whale": "anti_whale",
        "is_open_source": "open_source",  # not added as flag when true
    }
    for k in SOFT_FLAGS:
        if not flag_true(k):
            continue
        if k == "is_open_source":
            continue  # positive signal, not a risk chip
        label = soft_labels.get(k, k)
        if label not in flags:
            flags.append(label)

    is_in_dex = flag_true("is_in_dex")
    open_source = flag_true("is_open_source")

    return {
        "provider": "goplus",
        "scanned_at": _now_ms(),
        "is_honeypot": flag_true("is_honeypot"),
        "buy_tax": buy_tax,
        "sell_tax": sell_tax,
        "is_in_dex": is_in_dex,
        "is_open_source": open_source,
        "flags": flags,
        "critical": critical,
        "safe": len(critical) == 0,
        "token_name": result.get("token_name"),
        "token_symbol": result.get("token_symbol"),
        "holder_count": result.get("holder_count"),
        "raw_keys": sorted(result.keys())[:40],  # compact breadcrumb, not full dump
    }


class GoPlusClient:
    def __init__(self):
        self.app_key = os.environ.get("GOPLUS_APP_KEY", "").strip()
        self.app_secret = os.environ.get("GOPLUS_APP_SECRET", "").strip()
        self._access: str | None = None
        self._access_expires = 0.0
        self._last_call = 0.0
        # Free tier is strict (4029 too many requests at 3s); default 5s.
        self.min_interval = _cfg_float("GOPLUS_MIN_INTERVAL_SEC", 5.0)
        self.batch_size = max(1, min(_cfg_int("GOPLUS_BATCH_SIZE", 5), 20))
        self.daily_budget = max(1, _cfg_int("GOPLUS_DAILY_BUDGET", 300))
        self.refresh_days = max(1, _cfg_int("GOPLUS_REFRESH_DAYS", 14))
        # Persist daily usage across process restarts
        self._usage_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "goplus_usage.json",
        )

    @property
    def configured(self) -> bool:
        return bool(self.app_key and self.app_secret)

    def _load_usage(self) -> dict:
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        try:
            with open(self._usage_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("day") != day:
                return {"day": day, "addresses": 0, "calls": 0}
            return data
        except Exception:
            return {"day": day, "addresses": 0, "calls": 0}

    def _save_usage(self, data: dict):
        try:
            with open(self._usage_path, "w", encoding="utf-8") as f:
                json.dump(data, f)
        except Exception:
            pass

    def remaining_budget(self) -> int:
        u = self._load_usage()
        return max(0, self.daily_budget - int(u.get("addresses", 0)))

    def _throttle(self):
        wait = self.min_interval - (time.time() - self._last_call)
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.time()

    def get_access_token(self) -> str:
        if self._access and time.time() < self._access_expires - 60:
            return self._access
        if not self.configured:
            raise RuntimeError("GOPLUS_APP_KEY / GOPLUS_APP_SECRET not set")
        ts = int(time.time())
        sign = hashlib.sha1(f"{self.app_key}{ts}{self.app_secret}".encode()).hexdigest()
        body = urllib.parse.urlencode({
            "app_key": self.app_key,
            "time": str(ts),
            "sign": sign,
        }).encode()
        self._throttle()
        req = urllib.request.Request(
            TOKEN_URL, data=body, method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        if data.get("code") != 1:
            raise RuntimeError(f"GoPlus auth failed: {data}")
        result = data.get("result") or {}
        # access_token already includes 'Bearer ' prefix
        self._access = result["access_token"]
        expires_in = int(result.get("expires_in") or 7200)
        self._access_expires = time.time() + expires_in
        return self._access

    def fetch_security(self, chain_slug: str, addresses: list[str]) -> dict:
        """Return {address_lower: raw_goplus_dict} for a batch on one chain."""
        chain_id = CHAIN_TO_GOPLUS.get(chain_slug)
        if not chain_id:
            return {}
        addrs = [a.lower() for a in addresses if a]
        if not addrs:
            return {}
        token = self.get_access_token()
        qs = urllib.parse.urlencode({"contract_addresses": ",".join(addrs)})
        url = SECURITY_URL.format(chain_id=chain_id) + "?" + qs
        self._throttle()
        req = urllib.request.Request(url, headers={"Authorization": token})
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                data = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:300]
            raise RuntimeError(f"GoPlus HTTP {e.code}: {body}") from e
        if data.get("code") != 1:
            raise RuntimeError(f"GoPlus security error: {data.get('code')} {data.get('message')}")
        usage = self._load_usage()
        usage["addresses"] = int(usage.get("addresses", 0)) + len(addrs)
        usage["calls"] = int(usage.get("calls", 0)) + 1
        self._save_usage(usage)
        raw = data.get("result") or {}
        # Normalize keys to lowercase
        return {str(k).lower(): v for k, v in raw.items()}


def _parse_cached(tok: Token) -> dict | None:
    if not tok.security_json:
        return None
    try:
        return json.loads(tok.security_json)
    except Exception:
        return None


def eligible_tokens(db, limit: int | None = None) -> list[Token]:
    """Active + liquid enough tokens that need a (re)scan. Never retired junk."""
    floor = _min_liq()
    refresh_ms = _cfg_int("GOPLUS_REFRESH_DAYS", 14) * 86_400_000
    now = _now_ms()
    q = (
        db.query(Token)
        .filter(Token.status == "active")
        .filter(Token.liquidity_usd.isnot(None))
        .filter(Token.liquidity_usd >= floor)
        .filter(Token.contract_address.isnot(None))
        .filter(Token.chain_id.in_(list(CHAIN_TO_GOPLUS.keys())))
    )
    rows = q.all()
    need = []
    for t in rows:
        cached = _parse_cached(t)
        if not cached or not cached.get("scanned_at"):
            need.append((0, t))  # never scanned — highest priority
            continue
        age = now - int(cached["scanned_at"])
        if age >= refresh_ms:
            need.append((age, t))
    need.sort(key=lambda x: -x[0] if x[0] else 10**18)  # never-scanned first
    out = [t for _, t in need]
    if limit is not None:
        out = out[:limit]
    return out


def apply_result(db, tok: Token, raw: dict | None):
    """Write security_json; blacklist on critical risks."""
    if not raw:
        summary = {
            "provider": "goplus",
            "scanned_at": _now_ms(),
            "safe": None,
            "error": "no_result",
            "flags": ["no_goplus_result"],
            "critical": [],
        }
        tok.security_json = json.dumps(summary)
        return summary

    summary = assess(raw)
    # Keep a compact raw subset for audit (not multi-MB dumps)
    summary["raw_subset"] = {
        k: raw.get(k) for k in (
            "is_honeypot", "buy_tax", "sell_tax", "is_in_dex", "is_open_source",
            "is_mintable", "owner_change_balance", "cannot_buy", "cannot_sell_all",
            "is_proxy", "is_blacklisted", "holder_count", "total_supply",
            "token_name", "token_symbol", "is_airdrop_scam", "is_true_token",
        ) if k in raw
    }
    tok.security_json = json.dumps(summary)
    if summary.get("critical"):
        # Auto-hide from product lists
        if tok.status != "blacklisted":
            tok.status = "blacklisted"
            log(f"GoPlus blacklisted {tok.symbol}: {summary['critical']}", "WARNING")
    elif tok.status == "blacklisted":
        # Only revive if we blacklisted for security (not manual permanent)
        # and now safe — re-activate so it can re-enter screener.
        tok.status = "active"
    return summary


def run_scan(max_addresses: int | None = None) -> dict:
    """Scan a budget-limited slice of liquid tokens. Safe to run often."""
    from ingest.chains import load_env_file
    load_env_file()

    client = GoPlusClient()
    if not client.configured:
        log("GoPlus not configured (set GOPLUS_APP_KEY/SECRET) — skip", "WARNING")
        return {"ok": False, "reason": "not_configured"}

    remaining = client.remaining_budget()
    if remaining <= 0:
        log(f"GoPlus daily budget exhausted ({client.daily_budget}/day) — skip", "WARNING")
        return {"ok": False, "reason": "budget", "budget": client.daily_budget}

    cap = remaining if max_addresses is None else min(remaining, max_addresses)
    db = SessionLocal()
    try:
        todo = eligible_tokens(db, limit=cap)
        if not todo:
            log("GoPlus: no liquid tokens need scanning")
            return {"ok": True, "scanned": 0, "blacklisted": 0, "remaining": remaining}

        # Group by chain for batched calls
        by_chain: dict[str, list[Token]] = {}
        for t in todo:
            by_chain.setdefault(t.chain_id or "", []).append(t)

        scanned = 0
        blacklisted = 0
        errors = 0

        for chain, tokens in by_chain.items():
            for i in range(0, len(tokens), client.batch_size):
                if client.remaining_budget() <= 0:
                    log("GoPlus: hit daily budget mid-run — stopping")
                    break
                batch = tokens[i:i + client.batch_size]
                addrs = [t.contract_address for t in batch]
                try:
                    results = client.fetch_security(chain, addrs)
                except Exception as e:
                    errors += 1
                    log(f"GoPlus batch failed ({chain}): {e}", "ERROR")
                    write_debug_log("ERROR", f"GoPlus batch failed: {e}")
                    # Back off harder on errors
                    time.sleep(client.min_interval * 2)
                    continue
                for t in batch:
                    addr = (t.contract_address or "").lower()
                    summary = apply_result(db, t, results.get(addr))
                    scanned += 1
                    if summary.get("critical"):
                        blacklisted += 1
                db.commit()

        usage = client._load_usage()
        log(f"GoPlus scan done: scanned={scanned}, blacklisted={blacklisted}, "
            f"errors={errors}, day_used={usage.get('addresses')}/{client.daily_budget}")
        return {
            "ok": True,
            "scanned": scanned,
            "blacklisted": blacklisted,
            "errors": errors,
            "day_used": usage.get("addresses"),
            "daily_budget": client.daily_budget,
            "remaining": client.remaining_budget(),
        }
    finally:
        db.close()
