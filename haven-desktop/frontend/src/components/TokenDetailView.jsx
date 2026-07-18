import { useState, useEffect, useMemo } from 'react';
import { formatUnits } from 'ethers';
import Chart from './Chart';
import { getSavedAddress } from '../hooks/useWalletData';
import { fmtUsd, fmtQty, fmtPrice, fmtTime, tokenColor, tradeUsd } from '../utils/format';
import AlphaRisk from './AlphaRisk';
import ManualTradePanel from './ManualTradePanel';
import RiskTradeBanner from './RiskTradeBanner';
import '../dashboard.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// Token overview page: compact chart + stacked trade ticket, full chart is on Charts.
export default function TokenDetailView({
  symbol, name, signals, onBack, onOpenChart, onOpenPortfolio,
}) {
  const [interval_, setInterval_] = useState('15m');
  const [meta, setMeta] = useState(null);
  const [price, setPrice] = useState(null);
  const [trades, setTrades] = useState([]);
  const [markers, setMarkers] = useState([]);
  const [heldQty, setHeldQty] = useState(null);
  const [copied, setCopied] = useState(false);
  const [tradePolicy, setTradePolicy] = useState(null);

  const signal = useMemo(() => (signals || []).find(s => s.symbol === symbol), [signals, symbol]);
  const chg = signal?.price_change_24h;

  useEffect(() => {
    let alive = true;
    const loadMeta = async () => {
      try {
        const r = await fetch(`${API_URL}/tokens/${encodeURIComponent(symbol)}`);
        if (!r.ok || !alive) return;
        setMeta(await r.json());
      } catch { /* */ }
    };
    const loadPrice = async () => {
      try {
        const r = await fetch(`${API_URL}/dashboard/overview`);
        if (!r.ok || !alive) return;
        const o = await r.json();
        setPrice(o.token_prices?.[symbol] ?? null);
      } catch { /* */ }
    };
    const loadTrades = async () => {
      try {
        const r = await fetch(`${API_URL}/trades?limit=1000`);
        if (!r.ok || !alive) return;
        setTrades((await r.json()).filter(t => t.symbol === symbol));
      } catch { /* */ }
    };
    const loadMarkers = async () => {
      try {
        const r = await fetch(`${API_URL}/markers/${symbol}`);
        if (r.ok && alive) setMarkers(await r.json());
      } catch { /* */ }
    };
    const loadSecurity = async () => {
      try {
        const r = await fetch(`${API_URL}/security/check/${encodeURIComponent(symbol)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: false }),
        });
        if (!r.ok || !alive) return;
        const data = await r.json();
        setTradePolicy(data.trade_policy || null);
        // Merge security into meta-shaped view if /tokens lacked a scan yet
        if (data && alive) {
          setMeta(prev => prev ? {
            ...prev,
            security: data.safe != null || data.critical
              ? {
                  safe: data.safe,
                  critical: data.critical,
                  flags: data.flags,
                  is_honeypot: data.is_honeypot,
                  buy_tax: data.buy_tax,
                  sell_tax: data.sell_tax,
                  is_in_dex: data.is_in_dex,
                  scanned_at: data.scanned_at,
                }
              : prev.security,
          } : prev);
        }
      } catch { /* banner optional */ }
    };
    loadMeta(); loadPrice(); loadTrades(); loadMarkers(); loadSecurity();
    const a = setInterval(loadPrice, 10_000);
    const b = setInterval(loadTrades, 15_000);
    const c = setInterval(loadMarkers, 10_000);
    return () => { alive = false; clearInterval(a); clearInterval(b); clearInterval(c); };
  }, [symbol]);

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
        if (alive) setHeldQty(parseFloat(formatUnits(BigInt(raw), dec)));
      } catch { /* */ }
    };
    load();
    const iv = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(iv); };
  }, [meta?.contract_address]);

  const displayName = meta?.display_symbol || meta?.name || name || symbol;
  const contract = meta?.contract_address;
  const chartToken = useMemo(
    () => ({ symbol, name: displayName, interval: interval_ }),
    [symbol, displayName, interval_],
  );
  const heldUsd = heldQty != null && price ? heldQty * price : null;

  const handleCopy = () => {
    navigator.clipboard.writeText(contract || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="token-root">
      <div className="glass-panel" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <div className="token-head">
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn-secondary" onClick={onBack} style={{ padding: '6px 12px', fontSize: 12 }}>← Back</button>
              <div className="token-icon-placeholder" style={{
                width: 36, height: 36, fontSize: 11,
                background: `linear-gradient(135deg, ${tokenColor(contract || symbol)} 0%, #1e1e2d 100%)`,
              }}>
                {displayName.replace(/[^A-Za-z0-9]/g, '').substring(0, 3).toUpperCase()}
              </div>
              <h1 style={{ fontSize: 22, margin: 0 }}>{displayName}</h1>
              <span className="badge" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}>{symbol}</span>
              <button type="button" className="strat-edit-btn" onClick={() => onOpenChart?.(symbol, displayName)}>
                Full chart ↗
              </button>
              <button type="button" className="strat-edit-btn" onClick={() => onOpenPortfolio?.(symbol)}>
                Portfolio swap
              </button>
            </div>
            <div className="token-contract">
              <span>Contract:</span>
              <code>{contract ? `${contract.substring(0, 8)}…${contract.substring(contract.length - 8)}` : 'unknown'}</code>
              {contract && (
                <>
                  <button onClick={handleCopy}>{copied ? '✓ copied' : 'copy'}</button>
                  <a href={`https://bscscan.com/token/${contract}`} target="_blank" rel="noopener noreferrer">BscScan ↗</a>
                </>
              )}
            </div>
            <div className="dash-muted" style={{ fontSize: 12, marginTop: 6 }}>
              Wallet: {heldQty != null ? `${fmtQty(heldQty)} (${heldUsd != null ? fmtUsd(heldUsd) : '—'})` : '—'}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="price-big" style={{ fontSize: 24 }}>{price ? `$${fmtPrice(price)}` : '…'}</div>
            {typeof chg === 'number' && (
              <span className={`badge ${chg >= 0 ? 'badge-gain' : 'badge-loss'}`}>
                {chg >= 0 ? '+' : ''}{chg.toFixed(2)}% 24h
              </span>
            )}
          </div>
        </div>
      </div>

      <RiskTradeBanner
        policy={tradePolicy}
        security={meta?.security}
        contract={contract}
        chain={meta?.chain_id}
        symbol={displayName}
      />

      <AlphaRisk
        security={meta?.security}
        chain={meta?.chain_id}
        address={contract}
        symbol={displayName}
      />

      {/* Compact chart + trade column */}
      <div className="token-split">
        <div className="token-split-chart glass-panel">
          <div className="token-chart-embed compact">
            <Chart token={chartToken} onIntervalChange={setInterval_} signals={signals || []} />
          </div>
        </div>
        <div className="token-split-trade glass-panel" style={{ padding: 16 }}>
          <ManualTradePanel
            symbol={symbol}
            displayName={displayName}
            contract={contract}
            price={price}
            heldQty={heldQty}
            stacked
          />
        </div>
      </div>

      <div className="dash-grid" style={{ marginTop: 16 }}>
        <div className="dash-panel">
          <h3>Trade history — {displayName} ({trades.length})</h3>
          <div style={{ overflowX: 'auto' }}>
            <table className="dash-table">
              <thead>
                <tr><th>Time</th><th>Side</th><th>USD</th><th>Price</th><th>Status</th><th>Tx</th></tr>
              </thead>
              <tbody>
                {trades.slice(0, 50).map(t => {
                  const realTx = t.tx_hash && !String(t.tx_hash).startsWith('paper');
                  return (
                    <tr key={t.id}>
                      <td className="dash-muted">{fmtTime(t.block_time)}</td>
                      <td><span className={`side-pill ${t.direction === 'BUY' ? 'buy' : 'sell'}`}>{t.direction}</span></td>
                      <td>{fmtUsd(tradeUsd(t))}</td>
                      <td>{fmtPrice(t.execution_price || t.expected_price)}</td>
                      <td><span className={`status-pill ${t.status === 'FILLED' ? 'FILLED' : t.status === 'PAPER' ? 'PAPER' : 'other'}`}>{t.status}</span></td>
                      <td>{realTx ? <a href={`https://bscscan.com/tx/${t.tx_hash}`} target="_blank" rel="noreferrer">tx</a> : (t.tx_hash ? 'paper' : '—')}</td>
                    </tr>
                  );
                })}
                {!trades.length && <tr><td colSpan={6} className="dash-muted">No trades for this token yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="dash-panel">
          <h3>Active markers ({markers.filter(m => m.active).length})</h3>
          <div style={{ overflowX: 'auto' }}>
            <table className="dash-table">
              <thead><tr><th>Type</th><th>Dir</th><th>Price</th><th>Label</th></tr></thead>
              <tbody>
                {markers.filter(m => m.active).map(m => (
                  <tr key={m.id}>
                    <td>{m.marker_type}</td>
                    <td>{m.direction || 'cross'}</td>
                    <td>{fmtPrice(m.price)}</td>
                    <td className="dash-muted">{m.label || ''}</td>
                  </tr>
                ))}
                {!markers.filter(m => m.active).length && (
                  <tr><td colSpan={4} className="dash-muted">No active markers.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
