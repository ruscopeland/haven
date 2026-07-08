"""M4 cutover remap (DATA-ROADMAP AD-D10) — run with the stack STOPPED.

Maps every legacy Binance token row ("ALPHA_xxx"/"XXXUSDT" symbols, Binance
tokenId ids) onto the new-format namespace:

  * legacy row whose (chain, contract) already exists as a new-format token
    (bootstrapped by the on-chain ingester) → MERGE: the new slug wins, the
    legacy row is deleted.
  * legacy row with a supported-chain EVM address but no new row yet → the
    row is REWRITTEN in place to the new id/slug format (status 'staged').
  * anything else (non-EVM chains, missing address) → status 'retired',
    symbol kept (harmless: no prices, not tradeable).

Then every reference table (chart_markers, trade_history, strategies) has its
symbol column rewritten old→new, and strategies get an updated_at bump so
runners reload cleanly on the post-cutover restart.

Usage:
  python tools/remap_symbols.py                  # dry run (prints the mapping)
  python tools/remap_symbols.py --execute        # apply
  python tools/remap_symbols.py --execute --purge-legacy-market-data
        # ALSO delete legacy-namespace bucket/ticker rows (Binance-derived
        # data purge). Run backup-db.bat first — always.
"""
import os
import re
import sys
import time

sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                             "crypto-data-collector"))

from database.db import SessionLocal, engine, Base, ensure_db_settings  # noqa: E402
from database.models import (Token, ChartMarker, TradeHistory, Strategy,      # noqa: E402
                             OneMinBucket, FifteenMinBucket, LatestTicker)
from ingest.chains import LEGACY_CHAIN_ID_MAP                                  # noqa: E402
from ingest.evm import sanitize_display_symbol, make_slug                      # noqa: E402

EVM_ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def build_mapping(db):
    """→ (mapping old_symbol→new_slug, rewrites, merges, retires) — no writes."""
    legacy = db.query(Token).filter(~Token.id.contains(":")).all()
    new_by_key = {t.id: t for t in db.query(Token).filter(Token.id.contains(":")).all()}
    slugs_taken = {t.symbol for t in new_by_key.values()}

    mapping, rewrites, merges, retires = {}, [], [], []
    for t in legacy:
        chain = LEGACY_CHAIN_ID_MAP.get(str(t.chain_id or ""))
        addr = (t.contract_address or "").strip()
        if not chain or not EVM_ADDR_RE.match(addr):
            retires.append(t)
            continue
        new_id = f"{chain}:{addr.lower()}"
        existing = new_by_key.get(new_id)
        if existing is not None:
            mapping[t.symbol] = existing.symbol
            merges.append((t, existing))
            continue
        # No ingester row yet — rewrite the legacy row into the new format.
        display = sanitize_display_symbol((t.name or "").split(" (")[0]
                                          or t.symbol.replace("USDT", ""))
        slug = make_slug(display, chain, slugs_taken, addr)
        slugs_taken.add(slug)
        mapping[t.symbol] = slug
        rewrites.append((t, new_id, slug, display, chain))
    return mapping, rewrites, merges, retires


def apply_mapping(db, mapping, rewrites, merges, retires):
    now = int(time.time() * 1000)
    for t, existing in merges:
        db.delete(t)
    for t, new_id, slug, display, chain in rewrites:
        db.delete(t)                       # PK change = delete + insert
        db.flush()
        db.add(Token(id=new_id, symbol=slug, name=t.name, chain_id=chain,
                     contract_address=t.contract_address.lower(),
                     display_symbol=display, status="staged", listed_at=now))
    for t in retires:
        t.status = "retired"

    renamed = {"chart_markers": 0, "trade_history": 0, "strategies": 0}
    for old, new in mapping.items():
        renamed["chart_markers"] += (db.query(ChartMarker)
                                     .filter_by(symbol=old)
                                     .update({"symbol": new}))
        renamed["trade_history"] += (db.query(TradeHistory)
                                     .filter_by(symbol=old)
                                     .update({"symbol": new}))
        n = (db.query(Strategy).filter_by(symbol=old)
             .update({"symbol": new, "updated_at": now}))
        renamed["strategies"] += n
    return renamed


def activate_staged_tokens(db):
    """Cutover flip: 'staged' rows (hidden from /tokens during the parallel
    run) become 'active' — the on-chain universe goes live for every consumer."""
    return (db.query(Token).filter(Token.status == "staged")
            .update({"status": "active"}, synchronize_session=False))


def purge_legacy_market_data(db, mapping):
    """Delete Binance-derived rows (legacy symbols) from the market tables."""
    legacy_symbols = list(mapping.keys())
    deleted = {}
    for model, name in ((OneMinBucket, "one_min_buckets"),
                        (FifteenMinBucket, "fifteen_min_buckets"),
                        (LatestTicker, "latest_tickers")):
        q = db.query(model).filter(model.symbol.like("%USDT"))
        deleted[name] = q.delete(synchronize_session=False)
    return deleted, len(legacy_symbols)


def main():
    execute = "--execute" in sys.argv
    purge = "--purge-legacy-market-data" in sys.argv
    Base.metadata.create_all(bind=engine)
    ensure_db_settings()
    db = SessionLocal()
    try:
        mapping, rewrites, merges, retires = build_mapping(db)
        print(f"Legacy tokens: {len(mapping) + len(retires)} total")
        print(f"  merge into existing ingester rows : {len(merges)}")
        print(f"  rewrite in place to new format    : {len(rewrites)}")
        print(f"  retire (no supported chain/address): {len(retires)}")
        print("\nSymbol mapping (old → new):")
        for old, new in sorted(mapping.items()):
            print(f"  {old:<24} → {new}")
        if retires:
            print("\nRetired (symbol kept):")
            for t in retires:
                print(f"  {t.symbol:<24} chain_id={t.chain_id}")
        if not execute:
            print("\nDRY RUN — nothing written. Re-run with --execute to apply.")
            return
        renamed = apply_mapping(db, mapping, rewrites, merges, retires)
        print(f"\nRenamed rows: {renamed}")
        activated = activate_staged_tokens(db)
        print(f"Activated staged tokens: {activated}")
        if purge:
            deleted, _ = purge_legacy_market_data(db, mapping)
            print(f"Purged legacy market data: {deleted}")
        db.commit()
        print("COMMITTED.")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
