import { useState, useEffect, useMemo } from 'react';
import Chart from './Chart';
import { getSavedAddress } from '../hooks/useWalletData';
import { fmtUsd, fmtQty, fmtPrice, fmtTime, tokenColor } from '../utils/format';
import '../dashboard.css';

const API_URL = 'http://localhost:8000';

// In-app token page (old wallet's TokenDetails, rebuilt key-free):
// header with price/contract, the SAME chart as the Charts tab embedded in a
// window on this page (no separate browser tab), buy/sell routed through the
// engine (immediate-fire STRAT_BUY/STRAT_SELL markers — full guard stack +
// 120s TTL, AD-2: this app never holds the private key), and the token's
// trade history + active markers. Deliberately NO auto-trade section.
export default function TokenDetailView({ symbol, name, signals, onBack }) {
  const [interval_, setInterval_] = useState('15m');
  const [meta, setMeta] = useState(null);          // /tokens row (name, contract)
  const [price, setPrice] = useState(null);        // collector price (engine's feed)
  const [trades, setTrades] = useState([]);
  const [markers, setMarkers] = useState([]);
  const [heldQty, setHeldQty] = useState(null);    // wallet balance of this token
  const [copied, setCopied] = useState(false);

  // Trade box state
  const [side, setSide] = useState(null);          // 'BUY' | 'SELL' awaiting confirm
  const [buyUsd, setBuyUsd] = useState('');
  const [sellUsd, setSellUsd] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);            // {kind:'ok'|'err', text}

  const signal = useMemo(() => (signals || []).find(s => s.symbol === symbol), [signals, symbol]);
  const chg = signal?.price_change_24h;

  useEffect(() => {
    let alive = true;
    const loadMeta = async () => {
      try {
        const r = await fetch(`${API_URL}/tokens?limit=500`);
        if (!r.ok || !alive) return;
        const t = (await r.json()).find(t => t.symbol === symbol);
        if (t) setMeta(t);
      } catch { /* header falls back to the symbol */ }
    };
    const loadPrice = async () => {
      try {
        const r = await fetch(`${API_URL}/dashboard/overview`);
        if (!r.ok || !alive) return;
        const o = await r.json();
        setPrice(o.token_prices?.[symbol] ?? null);
      } catch { /* keep last price */ }
    };
    const loadTrades = async () => {
      try {
        const r = await fetch(`${API_URL}/trades?limit=1000`);
        if (!r.ok || !alive) return;
        setTrades((await r.json()).filter(t => t.symbol === symbol));
      } catch { /* table keeps last data */ }
    };
    const loadMarkers = async () => {
      try {
        const r = await fetch(`${API_URL}/markers/${symbol}`);
        if (r.ok && alive) setMarkers(await r.json());
      } catch { /* table keeps last data */ }
    };
    loadMeta(); loadPrice(); loadTrades(); loadMarkers();
    const a = setInterval(loadPrice, 10_000);
    const b = setInterval(loadTrades, 15_000);
    const c = setInterval(loadMarkers, 10_000);
    return () => { alive = false; clearInterval(a); clearInterval(b); clearInterval(c); };
  }, [symbol]);

  // Wallet balance of this one token via raw RPC (key-free, same as C2 hook).
  useEffect(() => {
    const contract = meta?.contract_address;
    const address = getSavedAddress();
    if (!contract || !/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
    let alive = true;
    const load = async () => {
      try {
        const call = async (data) => {
          const r = await fetch('https://bsc-dataseed.binance.org/', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data }, 'latest'] }),
          });
          return (await r.json()).result;
        };
        const dec = parseInt(await call('0x313ce567'), 16) || 18;
        const raw = await call('0x70a08231' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0'));
        if (alive) setHeldQty(parseInt(raw, 16) / 10 ** dec);
      } catch { /* leave unknown; next poll retries */ }
    };
    load();
    const iv = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(iv); };
  }, [meta?.contract_address]);

  const displayName = meta?.name || name || symbol;
  const contract = meta?.contract_address;
  const tradeable = !!contract;
  const chartToken = useMemo(() => ({ symbol, name: displayName, interval: interval_ }), [symbol, displayName, interval_]);

  const buyNum = parseFloat(buyUsd);
  const sellNum = parseFloat(sellUsd);
  const heldUsd = heldQty != null && price ? heldQty * price : null;

  // Same key-free order path as live strategies: immediate-fire marker,
  // executed by the engine with its full guard stack; self-cancels via the
  // 120s TTL if the engine is down (never fires late at a stale price).
  const send = async (dir, usdNum) => {
    setBusy(true); setMsg(null);
    try {
      const s = await (await fetch(`${API_URL}/engine/settings`)).json();
      if (s.paused) {
        setMsg({ kind: 'err', text: 'Engine is PAUSED — resume it on the Dashboard first, otherwise the order would expire unexecuted.' });
        setSide(null); setBusy(false); return;
      }
      const r = await fetch(`${API_URL}/markers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          price: price || 0,
          marker_type: dir === 'BUY' ? 'STRAT_BUY' : 'STRAT_SELL',
          direction: 'cross',
          label: `Manual ${dir} $${usdNum}`,
          metadata_json: JSON.stringify({ usd: usdNum, tag: 'manual' }),
        }),
      });
      if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
      setMsg({ kind: 'ok', text: `${dir} $${usdNum} of ${displayName} sent — the engine executes it within seconds (risk guards apply). It will appear in the history below.` });
      if (dir === 'BUY') setBuyUsd(''); else setSellUsd('');
      setSide(null);
    } catch (e) {
      setMsg({ kind: 'err', text: `Order failed: ${e.message || e}` });
      setSide(null);
    }
    setBusy(false);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(contract || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const confirmUsd = side === 'BUY' ? buyNum : sellNum;

  return (
    <div className="token-root">
      {/* Header */}
      <div className="glass-panel" style={{ padding: '20px 24px', marginBottom: 20 }}>
        <div className="token-head">
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <button className="btn-secondary" onClick={onBack} style={{ padding: '6px 14px', fontSize: 13 }}>← Dashboard</button>
              <div className="token-icon-placeholder" style={{ background: `linear-gradient(135deg, ${tokenColor(contract || symbol)} 0%, #1e1e2d 100%)` }}>
                {displayName.replace(/[^A-Za-z0-9]/g, '').substring(0, 3).toUpperCase()}
              </div>
              <h1 style={{ fontSize: 26, margin: 0 }}>{displayName}</h1>
              <span className="badge" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}>{symbol}</span>
            </div>
            <div className="token-contract">
              <span>Contract:</span>
              <code>{contract ? `${contract.substring(0, 8)}…${contract.substring(contract.length - 8)}` : 'unknown'}</code>
              {contract && (
                <>
                  <button onClick={handleCopy} title="Copy address">{copied ? '✓ copied' : '⧉ copy'}</button>
                  <a href={`https://bscscan.com/token/${contract}`} target="_blank" rel="noopener noreferrer" title="View on BscScan">BscScan ↗</a>
                </>
              )}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="price-big">{price ? `$${fmtPrice(price)}` : '…'}</div>
            {typeof chg === 'number' && (
              <span className={`badge ${chg >= 0 ? 'badge-gain' : 'badge-loss'}`} style={{ marginTop: 4 }}>
                {chg >= 0 ? '+' : ''}{chg.toFixed(2)}% (24h)
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Embedded chart — same component as the Charts tab, sized to this page */}
      <div className="token-chart-embed" style={{ marginBottom: 20 }}>
        <Chart token={chartToken} onIntervalChange={setInterval_} signals={signals || []} />
      </div>

      {/* Buy / Sell via engine */}
      <div className="glass-panel" style={{ padding: '20px 24px', marginBottom: 20 }}>
        <h3 style={{ margin: '0 0 4px 0', fontSize: 16 }}>Trade {displayName}</h3>
        <div className="qt-note" style={{ marginTop: 0, marginBottom: 14 }}>
          Orders route through the trading engine (risk guards: max trade size, price impact, daily cap).
          This app never holds your key; if the engine is offline, unexecuted orders self-cancel after 120 seconds.
        </div>

        {!tradeable ? (
          <div className="dash-error">This token has no contract address on file — the engine cannot swap it.</div>
        ) : (
          <div className="trade-cards">
            <div className="trade-box">
              <div className="head"><span>BUY</span><span className="badge badge-gain">via engine</span></div>
              <div className="qt-row">
                <input type="number" min="1" step="1" placeholder="Amount in USD" value={buyUsd}
                  onChange={e => { setBuyUsd(e.target.value); setSide(null); setMsg(null); }} />
              </div>
              <div className="trade-line">
                <span className="l">You receive (est.)</span>
                <span className="v">{price && buyNum > 0 ? `≈ ${fmtQty(buyNum / price)} ${displayName}` : '—'}</span>
              </div>
              <button className="trade-send buy" disabled={!(buyNum > 0) || !price || busy}
                onClick={() => { setSide('BUY'); setMsg(null); }}>
                Buy {buyNum > 0 ? `$${buyNum}` : ''}
              </button>
            </div>

            <div className="trade-box">
              <div className="head"><span>SELL</span><span className="badge badge-loss">via engine</span></div>
              <div className="qt-row">
                <input type="number" min="1" step="1" placeholder="Amount in USD" value={sellUsd}
                  onChange={e => { setSellUsd(e.target.value); setSide(null); setMsg(null); }} />
                {heldUsd != null && heldUsd > 0 && (
                  <button className="btn-secondary" style={{ padding: '6px 12px', fontSize: 12 }}
                    onClick={() => { setSellUsd(String(Math.floor(heldUsd * 100) / 100)); setSide(null); }}>Max</button>
                )}
              </div>
              <div className="trade-line">
                <span className="l">You hold</span>
                <span className="v">{heldQty != null ? `${fmtQty(heldQty)} (${heldUsd != null ? fmtUsd(heldUsd) : '—'})` : '—'}</span>
              </div>
              <div className="trade-line">
                <span className="l">You sell (est.)</span>
                <span className="v">{price && sellNum > 0 ? `≈ ${fmtQty(sellNum / price)} ${displayName}` : '—'}</span>
              </div>
              <button className="trade-send sell" disabled={!(sellNum > 0) || !price || busy}
                onClick={() => { setSide('SELL'); setMsg(null); }}>
                Sell {sellNum > 0 ? `$${sellNum}` : ''}
              </button>
            </div>
          </div>
        )}

        {side && (
          <div className="qt-confirm">
            Send a REAL {side} of <b>${confirmUsd}</b> {side === 'BUY' ? 'into' : 'of'} <b>{displayName}</b>?
            The engine executes on-chain within seconds.
            <div className="btns">
              <button style={{ background: side === 'BUY' ? 'var(--success-gradient)' : 'var(--danger-gradient)', color: '#fff' }}
                disabled={busy} onClick={() => send(side, confirmUsd)}>{busy ? 'Sending…' : `Confirm ${side}`}</button>
              <button style={{ background: 'rgba(255,255,255,0.08)', color: '#fff' }} onClick={() => setSide(null)}>Cancel</button>
            </div>
          </div>
        )}
        {msg && <div className={msg.kind === 'ok' ? 'dash-green' : 'dash-error'} style={{ marginTop: 10, fontSize: 12 }}>{msg.text}</div>}
      </div>

      <div className="dash-grid">
        {/* Trade history for this token */}
        <div className="dash-panel">
          <h3>Trade history — {displayName} ({trades.length})</h3>
          {trades.length === 0 ? (
            <div className="dash-muted" style={{ fontSize: 12 }}>No trades for this token yet.</div>
          ) : (
            <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto' }}>
              <table className="dash-table">
                <thead><tr><th>Time</th><th>Side</th><th>USD</th><th>Qty</th><th>Price</th><th>Reason</th><th>Status</th><th>Tx</th></tr></thead>
                <tbody>
                  {trades.map(t => {
                    const qty = t.direction === 'BUY' ? t.amount_out : t.amount_in;
                    const px = t.execution_price || t.expected_price || 0;
                    const realTx = t.tx_hash && !t.tx_hash.startsWith('paper');
                    return (
                      <tr key={t.id}>
                        <td className="dash-muted">{fmtTime(t.block_time)}</td>
                        <td><span className={`side-pill ${t.direction === 'BUY' ? 'buy' : 'sell'}`}>{t.direction}</span></td>
                        <td>{fmtUsd(qty * px)}</td>
                        <td>{fmtQty(qty)}</td>
                        <td>{fmtPrice(px)}</td>
                        <td className="dash-muted">{t.reason_label || t.reason || 'manual'}</td>
                        <td><span className={`status-pill ${['FILLED', 'PAPER'].includes(t.status) ? t.status : 'other'}`}>{t.status}</span></td>
                        <td>
                          {realTx ? (
                            <a href={`https://bscscan.com/tx/${t.tx_hash}`} target="_blank" rel="noopener noreferrer"
                              style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: 11 }}>
                              {t.tx_hash.substring(0, 8)}… ↗
                            </a>
                          ) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Active markers on this token */}
        <div className="dash-panel">
          <h3>Active markers ({markers.length})</h3>
          <div className="qt-note" style={{ marginTop: 0, marginBottom: 10 }}>
            These also draw as lines on the chart above — left-click a price there to place one, right-click a line to delete it.
          </div>
          {markers.length === 0 ? (
            <div className="dash-muted" style={{ fontSize: 12 }}>No active markers on this token.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="dash-table">
                <thead><tr><th>Type</th><th>Dir</th><th>Trigger</th><th>USD</th><th>Label</th><th>Created</th></tr></thead>
                <tbody>
                  {markers.map(m => {
                    let usd = null;
                    try { usd = JSON.parse(m.metadata_json || '{}').usd; } catch { /* legacy metadata */ }
                    return (
                      <tr key={m.id}>
                        <td>{m.marker_type}</td>
                        <td className="dash-muted">{m.direction || 'cross'}</td>
                        <td>{fmtPrice(m.price)}</td>
                        <td>{usd != null ? fmtUsd(Number(usd)) : '—'}</td>
                        <td className="dash-muted">{m.label || ''}</td>
                        <td className="dash-muted">{fmtTime(m.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
