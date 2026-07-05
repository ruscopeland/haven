import { useState, useEffect } from 'react';
import { fmtUsd, fmtQty, timeAgo, intervalToMs, tokenLabel, tradeUsd, tradeQty } from '../utils/format';

const API_URL = 'http://localhost:8000';

// Freshness of a running strategy: green if it ran within 2 bar-intervals,
// yellow within 5, red beyond that, grey if it has never run.
function freshColor(strat) {
  if (!strat.last_run_at) return '#2a2f42';
  const age = Date.now() - strat.last_run_at;
  const iv = intervalToMs(strat.interval);
  if (age < 2 * iv) return '#00ff88';
  if (age < 5 * iv) return '#fbbf24';
  return '#ff3366';
}

// PnL + positions from a strategy's trade rows (PAPER for dry, FILLED for live).
// Net PnL = sell proceeds − buy costs + open qty valued at current price.
function computeStats(trades, prices) {
  const bySymbol = {};
  let cost = 0, proceeds = 0, trades24h = 0;
  const dayAgo = Date.now() - 86_400_000;
  for (const t of trades) {
    const qty = tradeQty(t);
    const usd = tradeUsd(t);
    if (t.direction === 'BUY') cost += usd; else proceeds += usd;
    bySymbol[t.symbol] = (bySymbol[t.symbol] || 0) + (t.direction === 'BUY' ? qty : -qty);
    if ((t.block_time || 0) >= dayAgo) trades24h++;
  }
  let unrealized = 0;
  const positions = [];
  for (const [symbol, qty] of Object.entries(bySymbol)) {
    if (qty > 1e-9) {
      const value = qty * (prices?.[symbol] || 0);
      unrealized += value;
      positions.push({ symbol, qty, value });
    }
  }
  return { pnl: proceeds - cost + unrealized, positions, trades24h, count: trades.length };
}

function StrategyCard({ strat, trades, prices, finderName, tokenMap }) {
  const off = strat.mode === 'off';
  const stats = off ? null : computeStats(trades || [], prices);
  const source = strat.finder_id
    ? `🔍 ${finderName || 'finder'} · ${strat.max_positions} slot${strat.max_positions > 1 ? 's' : ''}`
    : tokenLabel(strat.symbol, tokenMap);

  return (
    <div className={`strat-card${off ? ' off' : ''}`}>
      <div className="strat-head">
        <span className="fresh-dot" style={{ background: off ? '#2a2f42' : freshColor(strat) }}
          title={off ? 'off' : `last run ${timeAgo(strat.last_run_at)}`} />
        <span className="strat-name">{strat.name}</span>
        <span className={`mode-badge ${strat.mode}`}>{strat.mode.toUpperCase()}</span>
        <span className="strat-sub">{source} · {strat.interval}</span>
        <span className="strat-sub" style={{ marginLeft: 'auto' }}>
          {off ? '' : `last run ${timeAgo(strat.last_run_at)}`}
        </span>
      </div>

      {!off && stats && (
        <div className="strat-stats">
          <span>
            <span className="lbl">Net PnL {strat.mode === 'dry' ? '(paper)' : ''}</span>
            <b className={stats.pnl >= 0 ? 'dash-green' : 'dash-red'}>{fmtUsd(stats.pnl)}</b>
          </span>
          <span>
            <span className="lbl">Open position</span>
            {stats.positions.length === 0 ? <span className="dash-muted">flat</span> :
              stats.positions.map(p => (
                <span key={p.symbol} style={{ marginRight: 10 }}>
                  {fmtQty(p.qty)} {tokenLabel(p.symbol, tokenMap)} ({fmtUsd(p.value)})
                </span>
              ))}
          </span>
          <span><span className="lbl">Trades 24h</span>{stats.trades24h}</span>
          <span><span className="lbl">Trades total</span>{stats.count}</span>
        </div>
      )}

      {strat.last_error && (
        <div className="strat-err" title={strat.last_error}>⚠ {strat.last_error}</div>
      )}
    </div>
  );
}

// B1: polls /strategies + /finders every 10s; per non-off strategy pulls its
// trade rows (PAPER for dry, FILLED for live). Prices/tokenMap come from the
// DashboardView's shared overview poll so this component adds no extra
// overview traffic.
export default function StrategyStatusBoard({ prices, tokenMap }) {
  const [strats, setStrats] = useState([]);
  const [finders, setFinders] = useState([]);
  const [tradeMap, setTradeMap] = useState({});
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [sRes, fRes] = await Promise.all([
          fetch(`${API_URL}/strategies`), fetch(`${API_URL}/finders`),
        ]);
        if (!sRes.ok || !fRes.ok) throw new Error('API error');
        const sData = await sRes.json();
        const fData = await fRes.json();
        const trades = {};
        await Promise.all(sData.filter(s => s.mode !== 'off').map(async s => {
          const status = s.mode === 'live' ? 'FILLED' : 'PAPER';
          const r = await fetch(`${API_URL}/trades?strategy_id=${s.id}&status=${status}&limit=500`);
          trades[s.id] = r.ok ? await r.json() : [];
        }));
        if (!alive) return;
        setStrats(sData); setFinders(fData); setTradeMap(trades); setError(null);
      } catch (e) {
        if (alive) setError(String(e.message || e));
      }
    };
    load();
    const iv = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const finderNames = Object.fromEntries(finders.map(f => [f.id, f.name]));
  const running = strats.filter(s => s.mode !== 'off');
  const idle = strats.filter(s => s.mode === 'off');

  return (
    <div className="dash-panel">
      <h3>Strategies</h3>
      {error && <div className="dash-error">Failed to load strategies: {error}</div>}
      {!error && strats.length === 0 && (
        <div className="dash-muted" style={{ fontSize: 12 }}>
          No strategies yet — create one in the ⚡ Strategies tab.
        </div>
      )}
      {[...running, ...idle].map(s => (
        <StrategyCard key={s.id} strat={s} trades={tradeMap[s.id]} prices={prices}
          finderName={finderNames[s.finder_id]} tokenMap={tokenMap} />
      ))}
    </div>
  );
}
