import { useState, useMemo } from 'react';
import { fmtPrice, fmtQty } from '../utils/format';

const API_URL = 'http://localhost:8000';

// C3: manual trade, key-free (AD-2). Posts an immediate-fire STRAT_BUY/
// STRAT_SELL marker — the exact path live strategies use — so the engine
// executes it with its full guard stack (claim atomicity, max_trade_usd,
// price impact, daily cap) and the 120s TTL discards it if the engine is
// down instead of firing late at a stale price.
export default function QuickTrade({ tokenMap, prices }) {
  const [query, setQuery] = useState('');
  const [side, setSide] = useState('BUY');
  const [usd, setUsd] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState(null); // {kind:'ok'|'err', text}
  const [busy, setBusy] = useState(false);

  const options = useMemo(() =>
    Object.values(tokenMap || {}).map(t => ({ symbol: t.symbol, name: t.name || t.symbol })), [tokenMap]);

  const selected = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return options.find(o => o.name.toLowerCase() === q || o.symbol.toLowerCase() === q) || null;
  }, [query, options]);

  const price = selected ? prices?.[selected.symbol] : null;
  const usdNum = parseFloat(usd);
  const valid = selected && usdNum > 0;

  const send = async () => {
    setBusy(true); setMsg(null);
    try {
      // Fresh pause check at the moment it matters — a paused engine would
      // let the marker sit until the TTL kills it, confusing the user.
      const s = await (await fetch(`${API_URL}/engine/settings`)).json();
      if (s.paused) {
        setMsg({ kind: 'err', text: 'Engine is PAUSED — resume it first, otherwise the order would expire unexecuted.' });
        setConfirming(false); setBusy(false); return;
      }
      const r = await fetch(`${API_URL}/markers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: selected.symbol,
          price: price || 0,
          marker_type: side === 'BUY' ? 'STRAT_BUY' : 'STRAT_SELL',
          direction: 'cross',
          label: `Manual ${side} $${usdNum}`,
          metadata_json: JSON.stringify({ usd: usdNum, tag: 'manual' }),
        }),
      });
      if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
      setMsg({ kind: 'ok', text: `${side} $${usdNum} of ${selected.name} sent — the engine executes it within seconds (risk guards apply). Watch Recent trades.` });
      setUsd(''); setConfirming(false);
    } catch (e) {
      setMsg({ kind: 'err', text: `Order failed: ${e.message || e}` });
      setConfirming(false);
    }
    setBusy(false);
  };

  return (
    <div className="dash-panel">
      <h3>Quick trade</h3>
      <div className="qt-row">
        <input list="qt-tokens" value={query} onChange={e => { setQuery(e.target.value); setMsg(null); setConfirming(false); }}
          placeholder="Token name or symbol…" />
        <datalist id="qt-tokens">
          {options.map(o => <option key={o.symbol} value={o.name} />)}
        </datalist>
      </div>
      <div className="qt-row">
        <div className="qt-side" style={{ flex: 1 }}>
          <button className={`buy${side === 'BUY' ? ' active' : ''}`} onClick={() => { setSide('BUY'); setConfirming(false); }}>BUY</button>
          <button className={`sell${side === 'SELL' ? ' active' : ''}`} onClick={() => { setSide('SELL'); setConfirming(false); }}>SELL</button>
        </div>
        <input type="number" min="1" step="1" value={usd} placeholder="USD"
          onChange={e => { setUsd(e.target.value); setConfirming(false); }} style={{ maxWidth: 90 }} />
      </div>

      {selected && (
        <div className="qt-note">
          {selected.name} @ {fmtPrice(price)} {price && usdNum > 0 ? `→ ≈ ${fmtQty(usdNum / price)} tokens` : ''}
        </div>
      )}

      {!confirming ? (
        <button className="qt-send" disabled={!valid || busy} onClick={() => setConfirming(true)}>
          {side} {valid ? `$${usdNum}` : ''} via engine…
        </button>
      ) : (
        <div className="qt-confirm">
          Send a REAL {side} of <b>${usdNum}</b> {side === 'BUY' ? 'into' : 'of'} <b>{selected.name}</b>?
          The engine executes on-chain within seconds. Risk guards (max trade size, price impact, daily cap) still apply.
          <div className="btns">
            <button style={{ background: side === 'BUY' ? '#00ff88' : '#ff3366', color: side === 'BUY' ? '#000' : '#fff' }}
              disabled={busy} onClick={send}>{busy ? 'Sending…' : `Confirm ${side}`}</button>
            <button style={{ background: '#2a2f42', color: '#fff' }} onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      )}

      {msg && <div className={msg.kind === 'ok' ? 'dash-green' : 'dash-error'} style={{ marginTop: 8, fontSize: 12 }}>{msg.text}</div>}
      <div className="qt-note">
        Orders route through the trading engine — this app never holds your key. If the
        engine is offline, unexecuted orders self-cancel after 120 seconds.
      </div>
    </div>
  );
}
