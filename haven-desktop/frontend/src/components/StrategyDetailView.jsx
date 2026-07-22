import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import StrategyTradeChart from './StrategyTradeChart';
import EquityChart from './EquityChart';
import computePerformance from '../utils/strategyPerf';
import { fmtUsd, fmtQty, fmtPrice, fmtTime, timeAgo, intervalToMs, tokenLabel } from '../utils/format';
import '../strategy-detail.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// Human labels for the marker type behind a fill.
const REASONS = {
  STRAT_BUY: 'signal', STRAT_SELL: 'signal', TP: 'take profit', SL: 'stop loss',
  BUY_GRID: 'grid buy', SELL_GRID: 'grid sell', DCA_ENTRY: 'DCA', ALERT: 'alert',
};

// Freshness of the runner: green if it ran within 2 bar-intervals, yellow
// within 5, red beyond, grey if never (same scale as the Dashboard cards).
function freshColor(strat) {
  if (!strat?.last_run_at) return '#2a2f42';
  const age = Date.now() - strat.last_run_at;
  const iv = intervalToMs(strat.interval);
  if (age < 2 * iv) return '#00ff88';
  if (age < 5 * iv) return '#fbbf24';
  return '#ff3366';
}

const pnlClass = (v) => (v > 0 ? 'dash-green' : v < 0 ? 'dash-red' : '');
const fmtPf = (v) => (v == null ? '—' : v === Infinity ? '∞' : v.toFixed(2));

function Kpi({ label, value, sub, cls = '' }) {
  return (
    <div className="sd-kpi">
      <div className="sd-kpi-label">{label}</div>
      <div className={`sd-kpi-value ${cls}`}>{value}</div>
      {sub != null && <div className="sd-kpi-sub">{sub}</div>}
    </div>
  );
}

// The per-strategy performance page ("bot page"): everything about how one
// running strategy is doing — stats, equity, every fill on a price chart,
// open orders — with the paper and live records kept in their own sections.
export default function StrategyDetailView({ strategyId, onBack, onEdit }) {
  const [perf, setPerf] = useState(null);
  const [err, setErr] = useState(null);
  const [tokenMap, setTokenMap] = useState({});
  const [kind, setKind] = useState(null);          // 'paper' | 'live' (null until auto-picked)
  const [selectedTradeId, setSelectedTradeId] = useState(null);
  const [chartSymbol, setChartSymbol] = useState(null);
  const [bnbPrice, setBnbPrice] = useState(null);
  const [showFailed, setShowFailed] = useState(false);
  const kindPicked = useRef(false);
  // Once the user opens the archive view, every subsequent poll includes the
  // archived rows (a ref so loadPerf stays stable and the poll isn't reset).
  const includeArchived = useRef(false);

  // ── Data polls ───────────────────────────────────────────────────────────
  const loadPerf = useCallback(async () => {
    try {
      const arch = includeArchived.current ? '?archived=1' : '';
      const r = await fetch(`${API_URL}/strategies/${strategyId}/performance${arch}`);
      if (!r.ok) throw new Error(r.status === 404
        ? 'Strategy not found — it may have been deleted (or the API server is running an older build and needs a restart).'
        : (await r.json()).detail || r.statusText);
      setPerf(await r.json());
      setErr(null);
    } catch (e) {
      setErr(String(e.message || e));
    }
  }, [strategyId]);

  useEffect(() => {
    kindPicked.current = false;
    includeArchived.current = false;
    setPerf(null); setErr(null); setKind(null);
    setSelectedTradeId(null); setChartSymbol(null);
    loadPerf();
    const t = setInterval(loadPerf, 10_000);
    return () => clearInterval(t);
  }, [loadPerf]);

  useEffect(() => {
    let alive = true;
    fetch(`${API_URL}/tokens?limit=500`)
      .then(r => r.ok ? r.json() : [])
      .then(list => { if (alive) setTokenMap(Object.fromEntries(list.map(t => [t.symbol, t]))); })
      .catch(() => {});
    // BNB price for the gas-fee USD estimate (live fills only).
    fetch(`${API_URL}/market/prices?symbols=BNB`)
      .then(r => r.json())
      .then(j => {
        const price = Number(j.prices?.BNB?.price || 0);
        if (alive && price > 0) setBnbPrice(price);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const strat = perf?.strategy;

  // Default section: whatever the bot is doing right now.
  useEffect(() => {
    if (!perf || kindPicked.current) return;
    kindPicked.current = true;
    if (perf.strategy.mode === 'live') setKind('live');
    else if (perf.strategy.mode === 'dry') setKind('paper');
    else setKind((perf.live || []).length > 0 ? 'live' : 'paper');
  }, [perf]);

  const trades = useMemo(() => (
    kind === 'live' ? perf?.live
      : kind === 'archive' ? perf?.paper_archived
        : perf?.paper
  ) || [], [perf, kind]);
  const calc = useMemo(() => computePerformance(trades, perf?.token_prices || {}), [trades, perf]);

  // Chart symbol: fixed strategies always chart their symbol; portfolio
  // strategies follow the most recent fill until the user picks a chip/trade.
  const defaultSymbol = useMemo(() => {
    if (!perf) return null;
    if (perf.strategy.symbol) return perf.strategy.symbol;
    if (trades.length > 0) return trades[trades.length - 1].symbol;
    if (calc.openPositions.length > 0) return calc.openPositions[0].symbol;
    return null;
  }, [perf, trades, calc]);
  const shownSymbol = chartSymbol || defaultSymbol;

  const chartTrades = useMemo(
    () => calc.rows.filter(t => t.symbol === shownSymbol),
    [calc, shownSymbol]);
  const shownAvgCost = calc.openPositions.find(p => p.symbol === shownSymbol)?.avgCost || 0;

  const selectTrade = (t) => {
    if (t.symbol !== shownSymbol) setChartSymbol(t.symbol);
    setSelectedTradeId(t.id);
  };

  const switchKind = (k) => {
    if (k === kind) return;
    if (k === 'archive' && !includeArchived.current) {
      includeArchived.current = true;   // polls now fetch the archived rows too
      loadPerf();
    }
    setKind(k);
    setSelectedTradeId(null);
    setChartSymbol(null);
  };

  // ── Manage: reset the dry run / delete the bot (owner asks, 2026-07-06) ──
  const resetDry = async () => {
    const n = (perf?.paper || []).length;
    const ok = window.confirm(
      `Reset the dry run for "${strat.name}"?\n\n` +
      `Deletes ${n} paper trade${n === 1 ? '' : 's'} so the paper stats start from zero. ` +
      `Archived dry runs (from before going LIVE) are kept. This cannot be undone.`);
    if (!ok) return;
    try {
      const r = await fetch(`${API_URL}/strategies/${strategyId}/reset_dry`, { method: 'POST' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        window.alert(d.detail || `Could not reset (HTTP ${r.status}${r.status === 404
          ? ' — the API server may be running an older build and need a restart' : ''}).`);
        return;
      }
      setSelectedTradeId(null);
      loadPerf();
    } catch (e) { window.alert(`Could not reset: ${e.message || e}`); }
  };

  const deleteBot = async () => {
    const ok = window.confirm(
      `Delete "${strat.name}" completely?\n\n` +
      `Removes the strategy, its paper + archived + failed records, and any queued markers. ` +
      `Real on-chain fills stay in your wallet's trade history.\n\nThis cannot be undone.`);
    if (!ok) return;
    try {
      const r = await fetch(`${API_URL}/strategies/${strategyId}`, { method: 'DELETE' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        window.alert(d.detail || `Could not delete (HTTP ${r.status}).`);
        return;
      }
      onBack?.();
    } catch (e) { window.alert(`Could not delete: ${e.message || e}`); }
  };

  // ── Mode toggle (same semantics as the workbench, incl. the LIVE gate) ──
  const setMode = async (mode) => {
    if (!strat || mode === strat.mode) return;
    if (mode === 'live') {
      const target = strat.finder_id
        ? `the Token Finder's top picks (up to ${strat.max_positions} slots)`
        : tokenLabel(strat.symbol, tokenMap);
      const ok = window.confirm(
        `Run "${strat.name}" LIVE on ${target}?\n\n` +
        `• Signals become REAL on-chain swaps via the marker engine.\n` +
        `• Engine risk limits still apply: max trade USD, daily cap, price-impact guard, pause flag.\n` +
        `• Your current dry-run record is archived (viewable under 📦 Archive) so live stats start clean.\n` +
        `• Flip back to DRY or OFF here at any time.`);
      if (!ok) return;
    }
    try {
      if (mode === 'live' && strat.live_approved_version !== strat.code_version) {
        const currentRes = await fetch(`${API_URL}/strategies/${strategyId}`);
        if (!currentRes.ok) throw new Error('Could not load the current code for approval.');
        const current = await currentRes.json();
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(current.code));
        const codeHash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
        const approvalRes = await fetch(`${API_URL}/strategies/${strategyId}/approve-live`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: current.code_version, code_hash: codeHash }),
        });
        if (!approvalRes.ok) {
          const detail = await approvalRes.json().catch(() => ({}));
          throw new Error(detail.detail || 'The current code version could not be approved.');
        }
      }
      const res = await fetch(`${API_URL}/strategies/${strategyId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        window.alert(d.detail || `Could not change mode (HTTP ${res.status}).`);
        return;
      }
      loadPerf();
    } catch (e) {
      window.alert(`Could not change mode: ${e.message || e}`);
    }
  };

  // ── Loading / error shells ───────────────────────────────────────────────
  if (err && !perf) {
    return (
      <div className="sd-root">
        <div className="sd-topbar"><button className="sd-back" onClick={onBack}>← Dashboard</button></div>
        <div className="dash-panel"><div className="dash-error">⚠ {err}</div></div>
      </div>
    );
  }
  if (!perf || kind == null) {
    return (
      <div className="sd-root">
        <div className="sd-topbar"><button className="sd-back" onClick={onBack}>← Dashboard</button></div>
        <div className="dash-panel dash-muted">Loading strategy…</div>
      </div>
    );
  }

  const s = calc.stats;
  const isPortfolio = !!strat.finder_id;
  const source = isPortfolio
    ? `🔍 ${perf.finder_name || 'finder'} · ${strat.max_positions} slot${strat.max_positions > 1 ? 's' : ''}`
    : tokenLabel(strat.symbol, tokenMap);
  const openMarkers = perf.open_markers || [];
  const failed = perf.failed || [];
  const symbolChips = isPortfolio
    ? [...new Set([...calc.bySymbol.map(b => b.symbol), ...(shownSymbol ? [shownSymbol] : [])])]
    : [];
  const feeSub = bnbPrice && s.feesBnb > 0 ? `≈ ${fmtUsd(s.feesBnb * bnbPrice)}` : null;

  return (
    <div className="sd-root">
      {/* ── Header ── */}
      <div className="sd-topbar">
        <button className="sd-back" onClick={onBack}>← Dashboard</button>
        <span className="fresh-dot" style={{ background: freshColor(strat) }}
          title={strat.last_run_at ? `last run ${timeAgo(strat.last_run_at)}` : 'never ran'} />
        <h2 className="sd-title">{strat.name}</h2>
        <span className={`mode-badge ${strat.mode}`}>{strat.mode.toUpperCase()}</span>
        <span className="sd-sub">{source} · {strat.interval}</span>
        <span className="sd-sub sd-lastrun">
          {strat.mode !== 'off' ? `last run ${timeAgo(strat.last_run_at)}` : 'stopped'}
        </span>
        <div className="sd-spacer" />
        <div className="sd-mode-toggle">
          {['off', 'dry', 'live'].map(m => (
            <button key={m}
              className={`sd-mode-btn mode-${m} ${strat.mode === m ? 'active' : ''}`}
              onClick={() => setMode(m)}>
              {m.toUpperCase()}
            </button>
          ))}
        </div>
        <button className="sd-edit" onClick={() => onEdit?.(strategyId)} title="Open in the Strategies workbench">
          ✎ Edit strategy
        </button>
      </div>

      {strat.last_error && (
        <div className="sd-error-banner" title={strat.last_error}>
          ⚠ Runner error: {strat.last_error}
        </div>
      )}

      {/* ── Paper / Live / Archive sections ── */}
      <div className="sd-kind-row">
        <div className="sd-kind-toggle">
          <button className={`sd-kind-btn ${kind === 'paper' ? 'active' : ''}`} onClick={() => switchKind('paper')}>
            📝 Paper run <span className="sd-kind-count">{(perf.paper || []).length}</span>
          </button>
          <button className={`sd-kind-btn ${kind === 'live' ? 'active' : ''}`} onClick={() => switchKind('live')}>
            ⛓ Live run <span className="sd-kind-count">{(perf.live || []).length}</span>
          </button>
          {(perf.paper_archived_count || 0) > 0 && (
            <button className={`sd-kind-btn ${kind === 'archive' ? 'active' : ''}`} onClick={() => switchKind('archive')}>
              📦 Archive <span className="sd-kind-count">{perf.paper_archived_count}</span>
            </button>
          )}
        </div>
        <span className="sd-kind-note">
          {kind === 'paper'
            ? 'Simulated fills recorded by the runner in DRY mode — no real funds.'
            : kind === 'archive'
              ? 'Dry runs archived when this bot went LIVE — kept for reference, separate from current stats.'
              : 'Real on-chain fills executed by the engine in LIVE mode.'}
        </span>
        <div className="sd-spacer" />
        {kind === 'paper' && (perf.paper || []).length > 0 && (
          <button className="sd-manage-btn" onClick={resetDry}
            title="Delete this bot's current paper trades so the dry-run stats start from zero (archived runs are kept)">
            🧹 Reset dry run
          </button>
        )}
        <button className="sd-manage-btn danger" onClick={deleteBot}
          title="Remove this strategy and its paper/archived/failed records — real on-chain fills stay in your trade history">
          🗑 Delete bot
        </button>
      </div>

      {/* ── KPIs ── */}
      <div className="sd-kpis">
        <Kpi label={`Net PnL ${kind === 'paper' ? '(paper)' : kind === 'archive' ? '(archived)' : ''}`}
          value={fmtUsd(s.netPnl)} cls={pnlClass(s.netPnl)}
          sub={`realized ${fmtUsd(s.realized)} · unrealized ${fmtUsd(s.unrealized)}`} />
        <Kpi label="Win rate" value={s.winRate == null ? '—' : `${s.winRate.toFixed(0)}%`}
          sub={s.closes > 0 ? `${s.wins} wins · ${s.losses} losses` : 'no closed trades yet'} />
        <Kpi label="Profit factor" value={fmtPf(s.profitFactor)}
          sub={s.avgWin != null || s.avgLoss != null
            ? `avg win ${fmtUsd(s.avgWin)} · avg loss ${fmtUsd(s.avgLoss)}` : null} />
        <Kpi label="Trades" value={s.nTrades} sub={`${s.tradesToday} in the last 24h`} />
        <Kpi label="Max drawdown" value={fmtUsd(s.maxDrawdown)} cls={s.maxDrawdown > 0 ? 'dash-red' : ''}
          sub="on realized PnL" />
        <Kpi label="Open exposure" value={fmtUsd(s.openValue)}
          sub={calc.openPositions.length === 0 ? 'flat' : `${calc.openPositions.length} position${calc.openPositions.length > 1 ? 's' : ''}`} />
        <Kpi label="Volume traded" value={fmtUsd(s.volumeUsd)}
          sub={`${fmtUsd(s.totalBuyUsd)} bought · ${fmtUsd(s.totalSellUsd)} sold`} />
        {kind === 'live' && (
          <Kpi label="Gas fees" value={s.feesBnb > 0 ? `${s.feesBnb.toFixed(5)} BNB` : '—'} sub={feeSub} />
        )}
      </div>

      {/* ── Main grid ── */}
      <div className="sd-grid">
        <div className="sd-col-main">
          <div className="dash-panel sd-chart-panel">
            <div className="sd-panel-head">
              <h3>Price & fills {shownSymbol ? `— ${tokenLabel(shownSymbol, tokenMap)} · ${strat.interval}` : ''}</h3>
              {symbolChips.length > 1 && (
                <div className="sd-symbol-chips">
                  {symbolChips.map(sym => (
                    <button key={sym}
                      className={`sd-chip ${sym === shownSymbol ? 'active' : ''}`}
                      onClick={() => { setChartSymbol(sym); setSelectedTradeId(null); }}>
                      {tokenLabel(sym, tokenMap)}
                    </button>
                  ))}
                </div>
              )}
              <span className="sd-panel-hint">click a trade below to see it on the chart</span>
            </div>
            {shownSymbol ? (
              <StrategyTradeChart
                symbol={shownSymbol}
                interval={strat.interval}
                trades={chartTrades}
                selectedTradeId={selectedTradeId}
                avgCost={shownAvgCost}
              />
            ) : (
              <div className="sd-chart-placeholder">
                No {kind === 'live' ? 'live' : 'paper'} fills yet — the chart appears with the first trade.
              </div>
            )}
          </div>

          <div className="dash-panel">
            <div className="sd-panel-head">
              <h3>Trade history <span className="dash-muted">({calc.rows.length})</span></h3>
            </div>
            <div className="sd-table-scroll">
              <table className="dash-table sd-trades-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    {isPortfolio && <th>Token</th>}
                    <th>Side</th><th>Price</th><th>Qty</th><th>USD</th><th>PnL</th><th>Reason</th>
                    {kind === 'live' && <th>Tx</th>}
                  </tr>
                </thead>
                <tbody>
                  {calc.rows.slice().reverse().map(t => {
                  const timeMs = t.time || t.block_time;
                  const sideStr = (t.side || t.direction || '').toUpperCase();
                  const execPx = t.price || t.execution_price || t.expected_price;
                  return (
                    <tr key={t.id}
                      className={`sd-trade-row ${t.id === selectedTradeId ? 'selected' : ''}`}
                      onClick={() => selectTrade(t)}
                      title="Show this trade on the chart">
                      <td>{fmtTime(timeMs)}</td>
                      {isPortfolio && <td>{tokenLabel(t.symbol, tokenMap)}</td>}
                      <td><span className={`side-pill ${sideStr === 'BUY' ? 'buy' : 'sell'}`}>{sideStr}</span></td>
                      <td>{fmtPrice(execPx)}</td>
                      <td>{fmtQty(t.qty)}</td>
                      <td>{fmtUsd(t.usd)}</td>
                      <td className={pnlClass(t.pnl)}>{t.pnl == null ? '' : fmtUsd(t.pnl)}</td>
                      <td className="sd-reason" title={t.reason_label || ''}>
                        {REASONS[t.reason] || t.reason || '—'}
                      </td>
                      {kind === 'live' && (
                        <td onClick={e => e.stopPropagation()}>
                          {t.tx_hash && !t.tx_hash.startsWith('paper-') && (
                            <a href={t.tx_hash.length > 66 ? `https://explorer.cow.fi/bsc/orders/${t.tx_hash}` : `https://bscscan.com/tx/${t.tx_hash}`} target="_blank"
                              rel="noopener noreferrer" className="sd-tx-link">↗</a>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
                  {calc.rows.length === 0 && (
                    <tr><td colSpan={isPortfolio ? 9 : 8} className="dash-muted sd-empty-cell">
                      {kind === 'paper'
                        ? 'No paper trades yet. Deploy the strategy in DRY mode and leave it running — it trades on closed bars.'
                        : kind === 'archive'
                          ? 'Loading archived dry runs…'
                          : 'No live fills yet. Signals only execute while the strategy is LIVE and the engine is running with a key.'}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {kind === 'live' && failed.length > 0 && (
              <div className="sd-failed">
                <button className="sd-failed-toggle" onClick={() => setShowFailed(v => !v)}>
                  {showFailed ? '▾' : '▸'} Failed executions ({failed.length})
                </button>
                {showFailed && (
                  <table className="dash-table">
                    <thead><tr><th>Time</th><th>Token</th><th>Side</th><th>Expected price</th><th>Reason</th></tr></thead>
                    <tbody>
                      {failed.slice().reverse().map(t => (
                        <tr key={t.id}>
                          <td>{fmtTime(t.block_time)}</td>
                          <td>{tokenLabel(t.symbol, tokenMap)}</td>
                          <td><span className={`side-pill ${t.direction === 'BUY' ? 'buy' : 'sell'}`}>{t.direction}</span></td>
                          <td>{fmtPrice(t.expected_price)}</td>
                          <td className="sd-reason">{REASONS[t.reason] || t.reason || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="sd-col-side">
          <div className="dash-panel">
            <div className="sd-panel-head"><h3>Equity — realized PnL</h3></div>
            <EquityChart points={calc.equity} />
          </div>

          <div className="dash-panel">
            <div className="sd-panel-head"><h3>Open position{calc.openPositions.length > 1 ? 's' : ''}</h3></div>
            {calc.openPositions.length === 0 ? (
              <div className="dash-muted sd-side-empty">Flat — nothing held right now.</div>
            ) : calc.openPositions.map(p => (
              <div key={p.symbol} className="sd-pos-row">
                <div className="sd-pos-head">
                  <b>{tokenLabel(p.symbol, tokenMap)}</b>
                  <span className={pnlClass(p.unrealized)}>{fmtUsd(p.unrealized)}</span>
                </div>
                <div className="sd-pos-sub">
                  {fmtQty(p.qty)} @ avg {fmtPrice(p.avgCost)} · now {fmtPrice(p.price)} · worth {fmtUsd(p.value)}
                </div>
              </div>
            ))}
          </div>

          <div className="dash-panel">
            <div className="sd-panel-head"><h3>Open orders <span className="dash-muted">({openMarkers.length})</span></h3></div>
            {openMarkers.length === 0 ? (
              <div className="dash-muted sd-side-empty">No queued signals or bracket legs.</div>
            ) : openMarkers.map(m => {
              let usd = null;
              try { usd = JSON.parse(m.metadata_json || '{}').usd; } catch { /* legacy metadata */ }
              return (
                <div key={m.id} className="sd-pos-row">
                  <div className="sd-pos-head">
                    <b>{tokenLabel(m.symbol, tokenMap)}</b>
                    <span className="sd-order-type">{REASONS[m.marker_type] || m.marker_type}</span>
                  </div>
                  <div className="sd-pos-sub">
                    @ {fmtPrice(m.price)} · {m.direction || 'cross'}
                    {usd ? ` · ${fmtUsd(usd)}` : ''} · placed {timeAgo(m.created_at)}
                  </div>
                </div>
              );
            })}
          </div>

          {isPortfolio && calc.bySymbol.length > 0 && (
            <div className="dash-panel">
              <div className="sd-panel-head"><h3>By token</h3></div>
              <table className="dash-table">
                <thead><tr><th>Token</th><th>Trades</th><th>Realized</th><th>Unrealized</th></tr></thead>
                <tbody>
                  {calc.bySymbol.map(b => (
                    <tr key={b.symbol} className="sd-trade-row"
                      onClick={() => { setChartSymbol(b.symbol); setSelectedTradeId(null); }}
                      title="Show this token's chart">
                      <td>{tokenLabel(b.symbol, tokenMap)}</td>
                      <td>{b.trades}</td>
                      <td className={pnlClass(b.realized)}>{fmtUsd(b.realized)}</td>
                      <td className={pnlClass(b.unrealized)}>{b.openQty > 0 ? fmtUsd(b.unrealized) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="dash-panel">
            <div className="sd-panel-head"><h3>About this bot</h3></div>
            <div className="sd-about">
              <div><span>Token source</span><b>{source}</b></div>
              <div><span>Interval</span><b>{strat.interval}</b></div>
              <div><span>First {kind} trade</span><b>{s.firstTradeAt ? fmtTime(s.firstTradeAt) : '—'}</b></div>
              <div><span>Last {kind} trade</span><b>{s.lastTradeAt ? fmtTime(s.lastTradeAt) : '—'}</b></div>
              <div><span>Created</span><b>{fmtTime(strat.created_at)}</b></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
