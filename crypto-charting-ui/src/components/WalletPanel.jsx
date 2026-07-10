import { useState, useMemo } from 'react';
import { fmtUsd, fmtQty, fmtPrice, tokenColor } from '../utils/format';
import { unrealizedFor } from '../utils/pnl';

const DUST_USD = 1;
const RECENT_TRADE_MS = 14 * 24 * 60 * 60 * 1000; // "a couple of weeks"

// Token Assets panel — the old wallet's holdings list, key-free (C2 hook).
// Rows are clickable and open the in-app token page. The wallet data hook
// lives in DashboardView so the summary cards share the same numbers.
// Holdings scan the FULL Alpha token universe (see useWalletData.js), so
// small leftover dust is common — hide it UNLESS the token was traded
// recently, since the user is still actively watching that one.
export default function WalletPanel({ wallet, prices, tokenMap, signals, pnlBySymbol, lastTradeBySymbol, onSelectToken }) {
  const { address, setAddress, bnb, bnbPrice, tokens, error } = wallet;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(address);

  const change24h = useMemo(() =>
    Object.fromEntries((signals || []).map(s => [s.symbol, s.price_change_24h])), [signals]);

  const { rows, hiddenCount } = useMemo(() => {
    const now = Date.now();
    const all = tokens.map(t => {
      const price = prices?.[t.symbol] || 0;
      const lastTradeAt = lastTradeBySymbol?.[t.symbol];
      return {
        ...t,
        price,
        usd: t.qty * price,
        chg: change24h[t.symbol],
        pnl: unrealizedFor(pnlBySymbol?.[t.symbol], price),
        color: tokenColor(tokenMap?.[t.symbol]?.contract_address || t.symbol),
        recentlyTraded: lastTradeAt != null && now - lastTradeAt < RECENT_TRADE_MS,
      };
    });
    all.sort((a, b) => b.usd - a.usd);
    const visible = all.filter(t => t.usd >= DUST_USD || t.recentlyTraded);
    return { rows: visible, hiddenCount: all.length - visible.length };
  }, [tokens, prices, change24h, pnlBySymbol, tokenMap, lastTradeBySymbol]);

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
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span className="wallet-addr" title={address || 'No address'}>
              {address ? `${address.slice(0, 8)}…${address.slice(-6)}` : 'No address set'}
            </span>
            <button type="button" className="strat-edit-btn" style={{ fontSize: 11 }}
              onClick={() => { setDraft(address); setEditing(true); }}>
              {address ? 'Change' : 'Add wallet'}
            </button>
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

          {rows.length === 0 && hiddenCount === 0 && (
            <div className="dash-muted" style={{ fontSize: 12, padding: '10px 0' }}>
              No token holdings found for this wallet yet.
            </div>
          )}

          {hiddenCount > 0 && (
            <div className="dash-muted" style={{ fontSize: 11, padding: '6px 0 0 4px' }}>
              {hiddenCount} holding{hiddenCount > 1 ? 's' : ''} under $1 hidden (no trade in the last 2 weeks) —
              still counted in Portfolio Net Worth above.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
