"""Public market endpoints for the signed-out landing page.

Real data only — no mocks. Reads Haven's Binance Alpha caches and is heavily
rate-limited.
"""
import re
import time
import threading
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import func

from database.db import get_db
from database.models import Token, LatestTicker, MarketCandle

router = APIRouter(prefix="/public", tags=["public"])


STABLE_SYMBOLS = {
    "USDT", "USDC", "USDE", "USDG", "DAI", "BUSD", "TUSD", "FDUSD", "USD1",
    "USDD", "FRAX", "LUSD", "GUSD", "PYUSD", "EURC", "EUROC", "CUSD", "DUSD",
    "USDP", "Tether", "USD", "USDBC", "USDB",
}
JUNK_NAME_RE = re.compile(
    r"test|scam|honeypot|harrypotter|obama|inuinu|pepepepe",
    re.I,
)
MIN_LIQ_USD = 100_000.0   # match product floor (HAVEN_MIN_TOKEN_LIQUIDITY_USD)
MIN_MCAP = 1_000_000.0
MAX_ABS_CHG = 200.0
DEFAULT_TICKER_SYMS = (
    "PEPE", "FLOKI", "GRT", "TWT", "SAFE", "BEAM", "AERO", "SPX",
    "CAKE", "UNI", "AAVE", "LINK", "CRV", "COMP", "SUSHI", "1INCH",
    "PENDLE", "RDNT", "JOE", "GMX", "SNX", "BAL", "YFI", "LDO",
)

_PUB_RATE = int(__import__("os").environ.get("PUBLIC_RATE_LIMIT_PER_MIN", "60"))
_rate: dict = {}
_rate_lock = threading.Lock()


def _rate_public(request: Request):
    ip = request.client.host if request.client else "unknown"
    window = int(time.time() // 60)
    key = f"pub:{ip}"
    with _rate_lock:
        bucket, count = _rate.get(key, (window, 0))
        if bucket != window:
            bucket, count = window, 0
        count += 1
        _rate[key] = (bucket, count)
        if len(_rate) > 20_000:
            _rate.clear()
    if count > _PUB_RATE:
        raise HTTPException(status_code=429, detail="Rate limit exceeded")


class PublicToken(BaseModel):
    symbol: str
    display: str
    name: str | None = None
    chain: str | None = None
    market_cap: float = 0.0
    alpha_rank: int | None = None
    alpha_id: str | None = None
    logo_url: str | None = None
    price: float | None = None
    price_change_24h: float | None = None
    volume_24h: float = 0.0
    liquidity_usd: float = 0.0
    default_checked: bool = False
    # Real closes from the Binance Alpha candle cache over ~24h (downsampled).
    sparkline: List[float] = []


def _display(tok: Token) -> str:
    return (tok.display_symbol or tok.name or tok.symbol or "").strip() or tok.symbol


def _logo_url(tok: Token) -> str | None:
    return None


def _is_stable(tok: Token) -> bool:
    ds = (_display(tok) or "").upper()
    name = (tok.name or "").upper()
    if ds in STABLE_SYMBOLS or name in STABLE_SYMBOLS:
        return True
    if ds.endswith("USD") and len(ds) <= 5:
        return True
    return False


def _passes_quality(tok: Token, ticker: LatestTicker | None, *,
                    require_price_change: bool = False,
                    min_liq: float = MIN_LIQ_USD) -> bool:
    if tok.status not in ("active", None):
        return False
    if tok.status == "blacklisted":
        return False
    if _is_stable(tok):
        return False
    mc = tok.market_cap or 0.0
    # Market caps are accepted only for tokens in the current Alpha catalogue.
    if mc > 0 and not tok.alpha_id:
        return False
    if mc > 0 and mc < MIN_MCAP:
        return False
    if mc > 50_000_000_000:  # $50B ceiling for our Alpha surface
        return False
    liq = tok.liquidity_usd or 0.0
    vol = (ticker.volume_24h if ticker else 0.0) or 0.0
    if liq < min_liq and vol < min_liq:
        return False
    label = f"{_display(tok)} {tok.name or ''}"
    if JUNK_NAME_RE.search(label):
        return False
    if require_price_change:
        if not ticker or ticker.price_change_24h is None:
            return False
        if abs(ticker.price_change_24h) > MAX_ABS_CHG:
            return False
        if ticker.last_price is None or ticker.last_price <= 0:
            return False
    return True


def _downsample(points: list[float], target: int = 24) -> list[float]:
    if not points:
        return []
    if len(points) <= target:
        return [float(p) for p in points if p is not None and p > 0]
    out = []
    step = (len(points) - 1) / (target - 1)
    for i in range(target):
        idx = int(round(i * step))
        p = points[idx]
        if p is not None and p > 0:
            out.append(float(p))
    return out


def _sparklines(db: Session, symbols: list[str], points: int = 24) -> dict[str, list[float]]:
    """Close prices from cached, closed Binance Alpha 15-minute candles."""
    if not symbols:
        return {}
    start_ms = int(time.time() * 1000) - 86_400_000
    rows = (db.query(Token.symbol, MarketCandle.open_time, MarketCandle.close_price)
            .join(MarketCandle, MarketCandle.alpha_id == Token.alpha_id)
            .filter(Token.symbol.in_(symbols), MarketCandle.interval == "15min",
                    MarketCandle.closed == 1, MarketCandle.open_time >= start_ms)
            .order_by(Token.symbol, MarketCandle.open_time.asc()).all())
    by_sym: dict[str, list[float]] = {}
    for sym, _ts, close in rows:
        if close is None or close <= 0:
            continue
        by_sym.setdefault(sym, []).append(float(close))
    return {s: _downsample(pts, points) for s, pts in by_sym.items()}


def _to_public(tok: Token, ticker: LatestTicker | None,
               default_checked: bool = False,
               sparkline: list[float] | None = None) -> PublicToken:
    return PublicToken(
        symbol=tok.symbol,
        display=_display(tok),
        name=tok.name,
        chain=tok.chain_id,
        market_cap=float(tok.market_cap or 0),
        alpha_rank=tok.alpha_rank,
        alpha_id=tok.alpha_id,
        logo_url=_logo_url(tok),
        price=ticker.last_price if ticker else None,
        price_change_24h=ticker.price_change_24h if ticker else None,
        volume_24h=float(ticker.volume_24h or 0) if ticker else 0.0,
        liquidity_usd=float(tok.liquidity_usd or 0),
        default_checked=default_checked,
        sparkline=sparkline or [],
    )


def _ranked_universe(db: Session) -> list[tuple[Token, LatestTicker | None]]:
    tickers = {t.symbol: t for t in db.query(LatestTicker).all()}
    tokens = (db.query(Token)
              .filter((Token.status == "active") | (Token.status.is_(None)))
              .filter(Token.market_cap.isnot(None))
              .filter(Token.market_cap > 0)
              .all())
    pairs = [(t, tickers.get(t.symbol)) for t in tokens]
    pairs = [p for p in pairs if _passes_quality(p[0], p[1], min_liq=10_000)]

    def sort_key(item):
        t, _ = item
        rank = t.alpha_rank if t.alpha_rank and t.alpha_rank > 0 else 10_000_000
        return (rank, -(t.market_cap or 0))

    pairs.sort(key=sort_key)
    return pairs


def _default_checked_set(universe: list[tuple[Token, LatestTicker | None]]) -> set[str]:
    by_display = {}
    for t, tk in universe[:120]:
        by_display[_display(t).upper()] = t.symbol
        by_display[(t.symbol or "").upper()] = t.symbol

    chosen = []
    for want in DEFAULT_TICKER_SYMS:
        sym = by_display.get(want.upper())
        if sym and sym not in chosen:
            chosen.append(sym)
        if len(chosen) >= 10:
            break
    if len(chosen) < 8:
        for t, _ in universe[:40]:
            if t.symbol not in chosen:
                chosen.append(t.symbol)
            if len(chosen) >= 10:
                break
    return set(chosen)


@router.get("/movers", response_model=List[PublicToken])
def public_movers(
    request: Request,
    band_start: int = Query(100, ge=1, le=500),
    band_end: int = Query(200, ge=2, le=1000),
    limit: int = Query(12, ge=1, le=40),
    db: Session = Depends(get_db),
):
    _rate_public(request)
    if band_end <= band_start:
        raise HTTPException(status_code=400, detail="band_end must be > band_start")

    universe = _ranked_universe(db)
    band = universe[band_start - 1:band_end]
    movers = []
    for t, tk in band:
        if not _passes_quality(t, tk, require_price_change=True):
            continue
        movers.append((abs(tk.price_change_24h or 0), t, tk))
    movers.sort(key=lambda x: x[0], reverse=True)
    top = movers[:limit]
    sparks = _sparklines(db, [t.symbol for _, t, _ in top])
    return [_to_public(t, tk, sparkline=sparks.get(t.symbol, []))
            for _, t, tk in top]


@router.get("/ticker-universe", response_model=List[PublicToken])
def public_ticker_universe(
    request: Request,
    limit: int = Query(150, ge=10, le=300),
    q: Optional[str] = Query(None, description="Search display/name/symbol"),
    db: Session = Depends(get_db),
):
    _rate_public(request)
    universe = _ranked_universe(db)[:max(limit, 120)]
    defaults = _default_checked_set(universe)
    out = []
    ql = (q or "").strip().lower()
    for t, tk in universe:
        if ql:
            hay = f"{_display(t)} {t.name or ''} {t.symbol}".lower()
            if ql not in hay:
                continue
        out.append(_to_public(t, tk, default_checked=t.symbol in defaults))
        if len(out) >= limit:
            break
    return out


@router.get("/ticker", response_model=List[PublicToken])
def public_ticker(
    request: Request,
    symbols: str = Query(..., description="Comma-separated token symbols/slugs"),
    db: Session = Depends(get_db),
):
    """Live prices + logos + real 24h sparklines for the landing ticker."""
    _rate_public(request)
    syms = [s.strip() for s in symbols.split(",") if s.strip()][:40]
    if not syms:
        return []
    tokens = db.query(Token).filter(Token.symbol.in_(syms)).all()
    by_sym = {t.symbol: t for t in tokens}
    tickers = {t.symbol: t for t in
               db.query(LatestTicker).filter(LatestTicker.symbol.in_(syms)).all()}
    sparks = _sparklines(db, syms)
    out = []
    for s in syms:
        t = by_sym.get(s)
        if not t:
            continue
        out.append(_to_public(t, tickers.get(s), sparkline=sparks.get(s, [])))
    return out


@router.get("/ticker-defaults", response_model=List[PublicToken])
def public_ticker_defaults(request: Request, db: Session = Depends(get_db)):
    _rate_public(request)
    universe = _ranked_universe(db)[:120]
    defaults = _default_checked_set(universe)
    out = []
    for t, tk in universe:
        if t.symbol in defaults:
            out.append(_to_public(t, tk, default_checked=True))
    return out
