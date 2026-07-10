// Full portfolio / wallet audit page — key-free balances + engine trade PnL.
// Manual swaps reuse ManualTradePanel (same engine path as token page).
import { useEffect, useMemo, useState } from 'react';
import useWalletData from '../hooks/useWalletData';
import usePortfolioStats from '../hooks/usePortfolioStats';
import { computePnl, unrealizedFor } from '../utils/pnl';
import { fmtUsd, fmtQty, fmtPrice, fmtTime, tokenColor, tokenLabel, tradeUsd } from '../utils/format';
import ManualTradePanel from './ManualTradePanel';
import AssetAllocation from './AssetAllocation';
import { formatUnits } from 'ethers';
import '../dashboard.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const DUST_KEY = 'havenPortfolioDustUsd';

function downloadCsv(filename, rows) {
  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function PortfolioView({
  signals = [],
  focusSymbol = null,
  onOpenToken,
  onOpenChart,
}) {
  const wallet = useWalletData();
  const { address, setAddress, bnb, bnbPrice, tokens, error } = wallet;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(address);
  const [prices, setPrices] = useState({});
  const [tokenMap, setTokenMap] = useState({});
  const [filledTrades, setFilledTrades] = useState([]);
  const [allTrades, setAllTrades] = useState([]);
  const [dustUsd, setDustUsd] = useState(() => {
    const v = parseFloat(localStorage.getItem(DUST_KEY) || '1');
    return Number.isFinite(v) ? v : 1;
  });
  const [sortKey, setSortKey] = useState('usd');
  const [selected, setSelected] = useState(focusSymbol);
  const [heldQtyFocus, setHeldQtyFocus] = useState(null);

  useEffect(() => {
    if (focusSymbol) setSelected(focusSymbol);
  }, [focusSymbol]);

  useEffect(() => {
    localStorage.setItem(DUST_KEY, String(dustUsd));
  }, [dustUsd]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [ov, toks, filled, all] = await Promise.all([
          fetch(`${API_URL}/dashboard/overview`).then(r => r.ok ? r.json() : null),
          fetch(`${API_URL}/tokens?limit=3000&min_liquidity=0&status=all`).then(r => r.ok ? r.json() : []),
          fetch(`${API_URL}/trades?status=FILLED&limit=1000`).then(r => r.ok ? r.json() : []),
          fetch(`${API_URL}/trades?limit=1000`).then(r => r.ok ? r.json() : []),
        ]);
        if (!alive) return;
        if (ov?.token_prices) setPrices(ov.token_prices);
        setTokenMap(Object.fromEntries((toks || []).map(t => [t.symbol, t])));
        setFilledTrades(filled || []);
        setAllTrades(all || []);
      } catch { /* keep last */ }
    };
    load();
    const a = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(a); };
  }, []);

  const pnlBySymbol = useMemo(() => computePnl(filledTrades), [filledTrades]);
  const stats = usePortfolioStats({ wallet, prices, tokenMap, pnlBySymbol });
  const change24h = useMemo(
    () => Object.fromEntries((signals || []).map(s => [s.symbol, s.price_change_24h])),
    [signals],
  );

  const audit = useMemo(() => {
    const filled = filledTrades.filter(t => t.status === 'FILLED');
    let gasBnb = 0;
    let wins = 0, losses = 0, flat = 0;
    // Approximate per-sell outcome using sequential avg-cost walk already in computePnl
    // For win rate: count sell fills with positive contribution vs sells
    const sells = filled.filter(t => t.direction === 'SELL');
    // Rebuild walk for win/loss on each sell
    const sorted = [...filled].sort((a, b) => (a.block_time || 0) - (b.block_time || 0));
    const state = {};
    for (const t of sorted) {
      const s = state[t.symbol] || (state[t.symbol] = { qty: 0, basis: 0 });
      const qty = t.direction === 'BUY'
        ? (t.amount_out || 0)
        : (t.amount_in || 0);
      const usd = tradeUsd(t);
      if (t.direction === 'BUY') {
        s.qty += qty; s.basis += usd;
      } else if (qty > 0) {
        const sold = Math.min(qty, s.qty);
        const avg = s.qty > 0 ? s.basis / s.qty : 0;
        const realized = usd - avg * sold;
        if (realized > 1e-6) wins++;
        else if (realized < -1e-6) losses++;
        else flat++;
        s.qty -= sold;
        s.basis -= avg * sold;
      }
      if (t.gas_cost_native) gasBnb += t.gas_cost_native;
    }
    const closed = wins + losses + flat;
    const winRate = closed > 0 ? (wins / closed) * 100 : null;
    const dayAgo = Date.now() - 86_400_000;
    const weekAgo = Date.now() - 7 * 86_400_000;
    const realized24h = (() => {
      // Approximate: recompute realized only using trades in window is hard;
      // show trade volume 24h instead + total realized from stats.
      return filled.filter(t => (t.block_time || 0) >= dayAgo).length;
    })();
    const vol24h = filled
      .filter(t => (t.block_time || 0) >= dayAgo)
      .reduce((s, t) => s + tradeUsd(t), 0);
    const vol7d = filled
      .filter(t => (t.block_time || 0) >= weekAgo)
      .reduce((s, t) => s + tradeUsd(t), 0);
    return {
      fills: filled.length,
      sells: sells.length,
      wins, losses, flat, winRate,
      gasBnb,
      gasUsd: bnbPrice != null ? gasBnb * bnbPrice : null,
      trades24h: realized24h,
      vol24h, vol7d,
    };
  }, [filledTrades, bnbPrice]);

  const holdings = useMemo(() => {
    const rows = [];
    if (bnb != null) {
      const usd = bnbPrice != null ? bnb * bnbPrice : 0;
      rows.push({
        key: 'BNB',
        symbol: 'BNB',
        name: 'BNB (native)',
        qty: bnb,
        price: bnbPrice,
        usd,
        chg: null,
        pnl: null,
        isBnb: true,
        contract: null,
      });
    }
    for (const t of tokens) {
      const price = prices?.[t.symbol] || 0;
      const usd = t.qty * price;
      const pnlRow = pnlBySymbol[t.symbol];
      const u = unrealizedFor(pnlRow, price);
      rows.push({
        key: t.symbol,
        symbol: t.symbol,
        name: t.name || t.symbol,
        qty: t.qty,
        price,
        usd,
        chg: change24h[t.symbol],
        pnl: u,
        realized: pnlRow?.realized ?? null,
        basis: pnlRow?.basis ?? null,
        isBnb: false,
        contract: tokenMap[t.symbol]?.contract_address,
        meta: tokenMap[t.symbol],
      });
    }
    const visible = rows.filter(r => (r.usd || 0) >= dustUsd || r.isBnb);
    const hidden = rows.length - visible.length;
    const sorted = [...visible].sort((a, b) => {
      if (sortKey === 'name') return (a.name || '').localeCompare(b.name || '');
      if (sortKey === 'chg') return (b.chg || -999) - (a.chg || -999);
      if (sortKey === 'pnl') return (b.pnl || -1e99) - (a.pnl || -1e99);
      return (b.usd || 0) - (a.usd || 0);
    });
    return { rows: sorted, hidden, total: rows.length };
  }, [bnb, bnbPrice, tokens, prices, pnlBySymbol, change24h, dustUsd, sortKey, tokenMap]);

  // Focus token meta for trade panel
  const focus = useMemo(() => {
    const sym = selected || holdings.rows.find(r => !r.isBnb)?.symbol;
    if (!sym || sym === 'BNB') return null;
    const row = holdings.rows.find(r => r.symbol === sym);
    const meta = tokenMap[sym];
    return {
      symbol: sym,
      name: row?.name || meta?.name || sym,
      contract: meta?.contract_address || row?.contract,
      price: prices[sym] ?? row?.price ?? null,
      heldQty: row?.qty ?? heldQtyFocus,
    };
  }, [selected, holdings.rows, tokenMap, prices, heldQtyFocus]);

  // If focus has no held qty from wallet list, try row from tokens raw
  useEffect(() => {
    if (!focus?.symbol) return;
    const t = tokens.find(x => x.symbol === focus.symbol);
    setHeldQtyFocus(t?.qty ?? null);
  }, [focus?.symbol, tokens]);

  const portfolioDayPnl = useMemo(() => {
    // Approximate 24h portfolio move from holdings * 24h %
    let delta = 0;
    for (const r of holdings.rows) {
      if (r.chg == null || !r.usd) continue;
      // chg is % of current roughly → reverse out prior value
      const prior = r.usd / (1 + r.chg / 100);
      delta += r.usd - prior;
    }
    return delta;
  }, [holdings.rows]);

  const exportHoldings = () => {
    const lines = ['symbol,name,qty,price_usd,value_usd,chg_24h,unrealized_pnl,realized_pnl'];
    for (const r of holdings.rows) {
      lines.push([
        r.symbol, JSON.stringify(r.name || ''),
        r.qty, r.price ?? '', r.usd ?? '',
        r.chg ?? '', r.pnl ?? '', r.realized ?? '',
      ].join(','));
    }
    downloadCsv(`haven-holdings-${Date.now()}.csv`, lines);
  };

  const exportTrades = () => {
    const lines = ['time,symbol,side,status,usd,exec_price,gas_bnb,tx'];
    for (const t of allTrades) {
      lines.push([
        t.block_time ? new Date(t.block_time).toISOString() : '',
        t.symbol, t.direction, t.status,
        tradeUsd(t), t.execution_price ?? '',
        t.gas_cost_native ?? '', t.tx_hash ?? '',
      ].join(','));
    }
    downloadCsv(`haven-trades-${Date.now()}.csv`, lines);
  };

  return (
    <div className="dash-root portfolio-root">
      <div className="portfolio-head">
        <div>
          <h2 style={{ margin: 0 }}>Portfolio</h2>
          <p className="dash-muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
            Live on-chain balances (key-free) · engine trade audit · manual swaps via desktop engine
          </p>
        </div>
        <div className="portfolio-addr">
          {editing ? (
            <div className="qt-row" style={{ minWidth: 320 }}>
              <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="0x… wallet address" />
              <button className="settings-save" style={{ padding: '6px 14px' }}
                onClick={() => { setAddress(draft); setEditing(false); }}>Save</button>
            </div>
          ) : (
            <>
              <code className="wallet-addr">
                {address ? `${address.slice(0, 10)}…${address.slice(-8)}` : 'No address set'}
              </code>
              <button type="button" className="strat-edit-btn" onClick={() => { setDraft(address); setEditing(true); }}>
                {address ? 'Change' : 'Add wallet'}
              </button>
              {address && (
                <a className="strat-edit-btn" href={`https://bscscan.com/address/${address}`} target="_blank" rel="noreferrer">
                  BscScan ↗
                </a>
              )}
            </>
          )}
        </div>
      </div>

      {error && <div className="dash-error" style={{ marginBottom: 12 }}>{error}</div>}

      {/* Hero stats */}
      <div className="portfolio-stats">
        <div className="portfolio-stat primary">
          <div className="lbl">Net worth</div>
          <div className="val">{fmtUsd(stats.netWorth)}</div>
          <div className={`sub ${portfolioDayPnl >= 0 ? 'dash-green' : 'dash-red'}`}>
            ~{portfolioDayPnl >= 0 ? '+' : ''}{fmtUsd(portfolioDayPnl)} est. 24h (from holdings %Δ)
          </div>
        </div>
        <div className="portfolio-stat">
          <div className="lbl">Unrealized P/L</div>
          <div className={`val ${stats.unrealized >= 0 ? 'dash-green' : 'dash-red'}`}>
            {stats.unrealized >= 0 ? '+' : ''}{fmtUsd(stats.unrealized)}
          </div>
          <div className="sub">{stats.unrealizedPct.toFixed(2)}% of cost basis</div>
        </div>
        <div className="portfolio-stat">
          <div className="lbl">Realized P/L</div>
          <div className={`val ${stats.realized >= 0 ? 'dash-green' : 'dash-red'}`}>
            {stats.realized >= 0 ? '+' : ''}{fmtUsd(stats.realized)}
          </div>
          <div className="sub">{audit.fills} filled trades · engine-tracked</div>
        </div>
        <div className="portfolio-stat">
          <div className="lbl">Win rate (sells)</div>
          <div className="val">{audit.winRate != null ? `${audit.winRate.toFixed(1)}%` : '—'}</div>
          <div className="sub">{audit.wins}W / {audit.losses}L / {audit.flat} flat</div>
        </div>
        <div className="portfolio-stat">
          <div className="lbl">Volume 24h / 7d</div>
          <div className="val" style={{ fontSize: 18 }}>{fmtUsd(audit.vol24h)}</div>
          <div className="sub">7d {fmtUsd(audit.vol7d)} · {audit.trades24h} fills 24h</div>
        </div>
        <div className="portfolio-stat">
          <div className="lbl">Gas paid (tracked)</div>
          <div className="val" style={{ fontSize: 18 }}>
            {audit.gasUsd != null ? fmtUsd(audit.gasUsd) : '—'}
          </div>
          <div className="sub">{audit.gasBnb.toFixed(5)} BNB on filled txs</div>
        </div>
      </div>

      <div className="portfolio-grid">
        <div className="portfolio-main">
          <div className="dash-panel">
            <div className="portfolio-panel-head">
              <h3 style={{ margin: 0 }}>Holdings</h3>
              <div className="portfolio-controls">
                <label className="dust-label">
                  Hide dust under
                  <select value={dustUsd} onChange={e => setDustUsd(parseFloat(e.target.value))}>
                    <option value={0}>$0 (show all)</option>
                    <option value={1}>$1</option>
                    <option value={5}>$5</option>
                    <option value={10}>$10</option>
                    <option value={25}>$25</option>
                  </select>
                </label>
                <select value={sortKey} onChange={e => setSortKey(e.target.value)}>
                  <option value="usd">Sort: value</option>
                  <option value="name">Sort: name</option>
                  <option value="chg">Sort: 24h %</option>
                  <option value="pnl">Sort: unrealized</option>
                </select>
                <button type="button" className="strat-edit-btn" onClick={exportHoldings}>Export CSV</button>
              </div>
            </div>
            {holdings.hidden > 0 && (
              <div className="dash-muted" style={{ fontSize: 11, marginBottom: 8 }}>
                Hiding {holdings.hidden} dust position{holdings.hidden === 1 ? '' : 's'} under {fmtUsd(dustUsd)}
              </div>
            )}
            {!address ? (
              <div className="dash-muted">Set a wallet address to load on-chain balances.</div>
            ) : holdings.rows.length === 0 ? (
              <div className="dash-muted">No balances above dust threshold.</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="dash-table portfolio-table">
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Price</th>
                      <th>24h</th>
                      <th>Qty</th>
                      <th>Value</th>
                      <th>Unrealized</th>
                      <th>Realized</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.rows.map(r => {
                      const active = selected === r.symbol;
                      const chgUp = (r.chg || 0) >= 0;
                      return (
                        <tr
                          key={r.key}
                          className={active ? 'active-row' : ''}
                          onClick={() => !r.isBnb && setSelected(r.symbol)}
                          style={{ cursor: r.isBnb ? 'default' : 'pointer' }}
                        >
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span className="token-icon-placeholder" style={{
                                width: 28, height: 28, fontSize: 10,
                                background: `linear-gradient(135deg, ${tokenColor(r.contract || r.symbol, r.isBnb)} 0%, #1e1e2d 100%)`,
                              }}>
                                {(r.name || r.symbol).replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase()}
                              </span>
                              <div>
                                <div className="h-symbol">{r.name || r.symbol}</div>
                                <div className="h-sub">{r.symbol}</div>
                              </div>
                            </div>
                          </td>
                          <td className="num">{r.price != null ? `$${fmtPrice(r.price)}` : '—'}</td>
                          <td className={r.chg == null ? '' : chgUp ? 'dash-green' : 'dash-red'}>
                            {r.chg == null ? '—' : `${chgUp ? '+' : ''}${r.chg.toFixed(2)}%`}
                          </td>
                          <td className="num">{fmtQty(r.qty)}</td>
                          <td className="num"><b>{fmtUsd(r.usd)}</b></td>
                          <td className={`num ${r.pnl == null ? '' : r.pnl >= 0 ? 'dash-green' : 'dash-red'}`}>
                            {r.pnl == null ? '—' : `${r.pnl >= 0 ? '+' : ''}${fmtUsd(r.pnl)}`}
                          </td>
                          <td className={`num ${r.realized == null ? '' : r.realized >= 0 ? 'dash-green' : 'dash-red'}`}>
                            {r.realized == null ? '—' : `${r.realized >= 0 ? '+' : ''}${fmtUsd(r.realized)}`}
                          </td>
                          <td onClick={e => e.stopPropagation()}>
                            {!r.isBnb && (
                              <div style={{ display: 'flex', gap: 4 }}>
                                <button type="button" className="strat-edit-btn" onClick={() => setSelected(r.symbol)}>Swap</button>
                                <button type="button" className="strat-edit-btn" onClick={() => onOpenToken?.({ symbol: r.symbol, name: r.name })}>Page</button>
                                <button type="button" className="strat-edit-btn" onClick={() => onOpenChart?.(r.symbol, r.name)}>Chart</button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="dash-panel" style={{ marginTop: 16 }}>
            <div className="portfolio-panel-head">
              <h3 style={{ margin: 0 }}>Trade audit (engine)</h3>
              <button type="button" className="strat-edit-btn" onClick={exportTrades}>Export CSV</button>
            </div>
            <p className="dash-muted" style={{ fontSize: 11, marginTop: 0 }}>
              FILLED / PAPER / FAILED from this account’s engine history. External wallet transfers are not included in PnL.
            </p>
            <div style={{ overflowX: 'auto', maxHeight: 360 }}>
              <table className="dash-table">
                <thead>
                  <tr>
                    <th>Time</th><th>Token</th><th>Side</th><th>USD</th><th>Price</th><th>Status</th><th>Gas</th><th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {allTrades.slice(0, 200).map(t => {
                    const realTx = t.tx_hash && !String(t.tx_hash).startsWith('paper');
                    return (
                      <tr key={t.id}>
                        <td className="dash-muted">{fmtTime(t.block_time)}</td>
                        <td>{tokenLabel(t.symbol, tokenMap)}</td>
                        <td><span className={`side-pill ${t.direction === 'BUY' ? 'buy' : 'sell'}`}>{t.direction}</span></td>
                        <td className="num">{fmtUsd(tradeUsd(t))}</td>
                        <td className="num">{fmtPrice(t.execution_price || t.expected_price)}</td>
                        <td><span className={`status-pill ${t.status === 'FILLED' ? 'FILLED' : t.status === 'PAPER' ? 'PAPER' : 'other'}`}>{t.status}</span></td>
                        <td className="dash-muted">{t.gas_cost_native ? `${Number(t.gas_cost_native).toFixed(5)}` : '—'}</td>
                        <td>
                          {realTx ? (
                            <a href={`https://bscscan.com/tx/${t.tx_hash}`} target="_blank" rel="noreferrer">tx ↗</a>
                          ) : (t.tx_hash ? 'paper' : '—')}
                        </td>
                      </tr>
                    );
                  })}
                  {!allTrades.length && (
                    <tr><td colSpan={8} className="dash-muted">No engine trades yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="portfolio-side">
          <AssetAllocation wallet={wallet} prices={prices} tokenMap={tokenMap} pnlBySymbol={pnlBySymbol} />
          <div className="dash-panel" style={{ marginTop: 16 }}>
            {focus ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
                  <span className="dash-muted" style={{ fontSize: 11 }}>Swap focus</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" className="strat-edit-btn" onClick={() => onOpenToken?.({ symbol: focus.symbol, name: focus.name })}>Token page</button>
                    <button type="button" className="strat-edit-btn" onClick={() => onOpenChart?.(focus.symbol, focus.name)}>Full chart</button>
                  </div>
                </div>
                <ManualTradePanel
                  symbol={focus.symbol}
                  displayName={focus.name}
                  contract={focus.contract}
                  price={focus.price}
                  heldQty={focus.heldQty}
                  stacked
                />
              </>
            ) : (
              <div className="dash-muted" style={{ fontSize: 13 }}>
                Select a token row (or open Swap from Charts) to trade here.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
