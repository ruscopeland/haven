import { useState, useMemo } from 'react';
import { fmtUsd, fmtQty, fmtPrice, tokenColor } from '../utils/format';
import { unrealizedFor } from '../utils/pnl';

// Token Assets panel — the old wallet's holdings list, key-free (C2 hook).
// Rows are clickable and open the in-app token page. The wallet data hook
// lives in DashboardView so the summary cards share the same numbers.
export default function WalletPanel({ wallet, prices, tokenMap, signals, pnlBySymbol, onSelectToken }) {
  const { address, setAddress, bnb, bnbPrice, tokens, error } = wallet;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(address);

  const change24h = useMemo(() =>
    Object.fromEntries((signals || []).map(s => [s.symbol, s.price_change_24h])), [signals]);

  const rows = useMemo(() => {
    const list = tokens.map(t => {
      const price = prices?.[t.symbol] || 0;
      return {
        ...t,
        price,
        usd: t.qty * price,
        chg: change24h[t.symbol],
        pnl: unrealizedFor(pnlBySymbol?.[t.symbol], price),
        color: tokenColor(tokenMap?.[t.symbol]?.contract_address || t.symbol),
      };
    });
    list.sort((a, b) => b.usd - a.usd);
    return list;
  }, [tokens, prices, change24h, pnlBySymbol, tokenMap]);

  const bnbUsd = bnb != null && bnbPrice != null ? bnb * bnbPrice : null;

  return (
    <div className="dash-panel">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ marginBottom: 8 }}>Token Assets</h3>
        {editing ? (
          <div className="qt-row" style={{ flex: 1, minWidth: 260 }}>
            <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="0x… wallet address" />
            <button className="settings-save" style={{ padding: '6px 14px' }}
              onClick={() => { setAddress(draft); setEditing(false); }}>Save</button>
          </div>
        ) : (
          <span className="wallet-addr" style={{ cursor: 'pointer' }} title="Click to change address"
            onClick={() => { setDraft(address); setEditing(true); }}>
            {address ? `${address.slice(0, 8)}…${address.slice(-6)} ✎` : 'No address set — click to add one ✎'}
          </span>
        )}
      </div>

      {error && <div className="dash-error" style={{ marginBottom: 8 }}>{error}</div>}

      {address && (
        <div>
          <div className="holding-row head">
            <div>Asset</div>
            <div>Price (USD)</div>
            <div>24h Δ</div>
            <div>Holdings</div>
            <div style={{ textAlign: 'right' }}>P/L</div>
          </div>

          {/* BNB — gas + quote currency, no token page for it */}
          <div className="holding-row">
            <div className="holding-info">
              <div className="token-icon-placeholder" style={{ background: `linear-gradient(135deg, ${tokenColor(null, true)} 0%, #1e1e2d 100%)` }}>BNB</div>
              <div style={{ minWidth: 0 }}>
                <div className="h-symbol">BNB</div>
                <div className="h-name">BNB Chain native coin</div>
              </div>
            </div>
            <div className="h-num">{bnbPrice != null ? `$${fmtPrice(bnbPrice)}` : '…'}</div>
            <div className="h-sub">—</div>
            <div>
              <div className="h-num">{bnb != null ? fmtQty(bnb) : '…'}</div>
              <div className="h-sub">{bnbUsd != null ? fmtUsd(bnbUsd) : '…'}</div>
            </div>
            <div className="h-sub" style={{ textAlign: 'right' }}>—</div>
          </div>

          {rows.map(t => (
            <div key={t.symbol} className="holding-row clickable" title={`Open ${t.name || t.symbol} page`}
              onClick={() => onSelectToken?.({ symbol: t.symbol, name: t.name || t.symbol })}>
              <div className="holding-info">
                <div className="token-icon-placeholder" style={{ background: `linear-gradient(135deg, ${t.color} 0%, #1e1e2d 100%)` }}>
                  {(t.name || t.symbol).replace(/[^A-Za-z0-9]/g, '').substring(0, 3).toUpperCase()}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="h-symbol">{t.name || t.symbol}</div>
                  <div className="h-name">{t.symbol}</div>
                </div>
              </div>
              <div className="h-num">{t.price ? `$${fmtPrice(t.price)}` : '—'}</div>
              <div>
                {typeof t.chg === 'number' ? (
                  <span className={`badge ${t.chg >= 0 ? 'badge-gain' : 'badge-loss'}`} style={{ fontSize: 11 }}>
                    {t.chg >= 0 ? '+' : ''}{t.chg.toFixed(2)}%
                  </span>
                ) : <span className="h-sub">—</span>}
              </div>
              <div>
                <div className="h-num">{fmtQty(t.qty)}</div>
                <div className="h-sub">{fmtUsd(t.usd)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                {t.pnl != null ? (
                  <span className={t.pnl >= 0 ? 'dash-green' : 'dash-red'} style={{ fontWeight: 600, fontSize: 13 }}>
                    {t.pnl >= 0 ? '+' : ''}{fmtUsd(t.pnl)}
                  </span>
                ) : <span className="h-sub">—</span>}
              </div>
            </div>
          ))}

          {rows.length === 0 && (
            <div className="dash-muted" style={{ fontSize: 12, padding: '10px 0' }}>
              No traded tokens found for this wallet yet — tokens appear here after the engine fills a trade.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
