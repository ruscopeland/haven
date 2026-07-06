import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import {
  loadStrategy, runBacktest, runPortfolioBacktest, normalizeUniverse, TEMPLATES,
} from '@sdk/index.js';
import BacktestChart from './BacktestChart';
import BacktestResults from './BacktestResults';
import SlotTimeline from './SlotTimeline';
import GuidePanel from './GuidePanel';
import AssistantPanel from './AssistantPanel';
import '../strategies.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const INTERVAL_SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
// Finder-bound (portfolio) backtests rank on /universe data, which only
// exists at these intervals — the API resamples the collector's 1m buckets.
const PORTFOLIO_INTERVALS = ['5m', '15m', '30m', '1h'];
const DRAFT_KEY = 'strategyDraft';

// Human-readable ticker: prefer the collector's display name ("BSB (Block
// Street)"), else strip the ALPHA_ prefix and USDT suffix off the raw symbol.
const prettySymbol = (sym, name) => {
  if (!sym) return '';
  if (name && name !== sym) return name;
  return sym.replace(/^ALPHA_/, '').replace(/USDT$/, '');
};

const newDraftFromTemplate = (tpl, symbol) => ({
  id: null,
  name: tpl.name,
  code: tpl.code,
  symbol: symbol || '',
  interval: '5m',
  params: {},
  finderId: null,          // Token Finder dynamic selection (null = fixed symbol)
  maxPositions: 1,
  switchMarginPct: 10,
});

export default function StrategyWorkbench({ signals = [], initialSelectId = null, onOpenStrategyPage = null }) {
  const [list, setList] = useState([]);
  const [draft, setDraft] = useState(() => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      // Merge over template defaults: drafts saved before the Token Finder
      // fields existed would otherwise load with maxPositions undefined.
      if (saved) return { ...newDraftFromTemplate(TEMPLATES[0], ''), ...JSON.parse(saved) };
    } catch { /* corrupted draft — start fresh */ }
    return newDraftFromTemplate(TEMPLATES[0], '');
  });
  const [dirty, setDirty] = useState(false);
  const [btResult, setBtResult] = useState(null);
  const [btLoading, setBtLoading] = useState(false);
  const [flowInfo, setFlowInfo] = useState(null);
  const [feePct, setFeePct] = useState('0.25');
  const [slippagePct, setSlippagePct] = useState('0.1');
  const [showEquity, setShowEquity] = useState(true);
  const [bars, setBars] = useState(null);
  const [saveMsg, setSaveMsg] = useState('');
  const [activity, setActivity] = useState([]);
  const [finders, setFinders] = useState([]);
  const [pfUniverse, setPfUniverse] = useState(null);   // normalized universe of the last portfolio run
  const [showGuide, setShowGuide] = useState(false);
  const dataCache = useRef(new Map());   // `${symbol}|${interval}` → { bars, flowRows, at }
  const universeCache = useRef(new Map()); // `${interval}` → { normalized, at }
  const finderCache = useRef(new Map());   // finderId → { code, params, updatedAt }

  const isPortfolio = !!draft.finderId;

  // The saved row backing the current draft (for mode/status badges).
  const selectedRow = useMemo(() => list.find(s => s.id === draft.id) || null, [list, draft.id]);

  // Strategy defaults drive the params form; re-parsed as the code changes.
  const { strategy: parsedStrategy, error: codeError } = useMemo(
    () => loadStrategy(draft.code), [draft.code]);
  const paramDefaults = parsedStrategy?.params || {};

  // ── Strategy list (poll for runner status updates) ─────────────────────
  const fetchList = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/strategies`);
      if (res.ok) setList(await res.json());
    } catch { /* API down — health dot already shows it */ }
    try {
      const res = await fetch(`${API_URL}/finders`);
      if (res.ok) setFinders(await res.json());
    } catch { /* ditto */ }
  }, []);

  useEffect(() => {
    fetchList();
    const t = setInterval(fetchList, 10000);
    return () => clearInterval(t);
  }, [fetchList]);

  // Default the draft symbol to the top screener token once signals arrive.
  useEffect(() => {
    if (!draft.symbol && signals.length > 0) {
      setDraft(d => (d.symbol ? d : { ...d, symbol: signals[0].symbol }));
    }
  }, [signals, draft.symbol]);

  // Unsaved-draft cache — survives tab switches and reloads.
  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* full */ }
  }, [draft]);

  const patchDraft = (patch) => { setDraft(d => ({ ...d, ...patch })); setDirty(true); };

  // ── CRUD ────────────────────────────────────────────────────────────────
  const selectStrategy = async (id) => {
    try {
      const res = await fetch(`${API_URL}/strategies/${id}`);
      if (!res.ok) return;
      const s = await res.json();
      let params = {};
      try { params = JSON.parse(s.params_json || '{}'); } catch { /* legacy */ }
      setDraft({
        id: s.id, name: s.name, code: s.code, symbol: s.symbol, interval: s.interval, params,
        finderId: s.finder_id || null,
        maxPositions: s.max_positions ?? 1,
        switchMarginPct: s.switch_margin_pct ?? 10,
      });
      setDirty(false);
    } catch (err) { console.error('Failed to load strategy', err); }
  };

  // Deep-link from the Dashboard's strategy cards: open a specific strategy
  // once its row is available in the polled list. Applied once per id so the
  // 10s list poll doesn't keep re-selecting over the user's own navigation.
  const appliedSelectId = useRef(null);
  useEffect(() => {
    if (initialSelectId == null || initialSelectId === appliedSelectId.current) return;
    if (!list.some(s => s.id === initialSelectId)) return;
    appliedSelectId.current = initialSelectId;
    selectStrategy(initialSelectId);
  }, [initialSelectId, list]);

  const saveDraft = async () => {
    const body = {
      name: draft.name,
      code: draft.code,
      // '' + finder_id means dynamic selection server-side; PATCH needs the
      // explicit clear flag to detach a finder.
      symbol: draft.finderId ? '' : draft.symbol,
      interval: draft.interval,
      params_json: JSON.stringify(draft.params || {}),
      max_positions: parseInt(draft.maxPositions, 10) || 1,
      switch_margin_pct: parseFloat(draft.switchMarginPct) || 0,
      ...(draft.finderId ? { finder_id: draft.finderId } : {}),
      ...(draft.id && !draft.finderId ? { clear_finder: true } : {}),
    };
    try {
      const res = draft.id
        ? await fetch(`${API_URL}/strategies/${draft.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch(`${API_URL}/strategies`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      const s = await res.json();
      setDraft(d => ({ ...d, id: s.id }));
      setDirty(false);
      setSaveMsg('Saved ✓');
      setTimeout(() => setSaveMsg(''), 2000);
      fetchList();
    } catch (err) {
      setSaveMsg(`Save failed: ${err.message}`);
    }
  };

  const deleteStrategy = async () => {
    if (!draft.id) return;
    if (!window.confirm(`Delete strategy "${draft.name}"? Any queued markers it posted are removed too.`)) return;
    try {
      await fetch(`${API_URL}/strategies/${draft.id}`, { method: 'DELETE' });
      setDraft(d => ({ ...d, id: null }));
      fetchList();
    } catch (err) { console.error('Failed to delete strategy', err); }
  };

  const setMode = async (mode) => {
    if (!draft.id) return;
    if (dirty && mode !== 'off') {
      window.alert('Save the strategy first — the runner executes the SAVED code, not this draft.');
      return;
    }
    if (mode === 'live') {
      const usd = draft.params.usd ?? paramDefaults.usd;
      const target = draft.finderId
        ? `the Token Finder's top picks (up to ${draft.maxPositions} slots)`
        : draft.symbol;
      const ok = window.confirm(
        `Run "${draft.name}" LIVE on ${target}?\n\n` +
        `• Signals become REAL on-chain swaps via the marker engine${usd ? ` (~$${usd} per signal)` : ''}.\n` +
        `• Engine risk limits still apply: max trade USD, daily cap, price-impact guard, pause flag.\n` +
        `• Flip back to DRY or OFF here at any time.`);
      if (!ok) return;
    }
    try {
      const res = await fetch(`${API_URL}/strategies/${draft.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (res.ok) {
        fetchList();
      } else {
        // e.g. the bot limit (409) or a trial trying to go LIVE (403) — the
        // server's detail is written for humans, show it as-is.
        const d = await res.json().catch(() => ({}));
        window.alert(d.detail || `Could not change mode (HTTP ${res.status}).`);
      }
    } catch (err) { console.error('Failed to set mode', err); }
  };

  // ── Live/dry activity for the selected saved strategy ───────────────────
  useEffect(() => {
    if (!draft.id || !selectedRow || selectedRow.mode === 'off') { setActivity([]); return; }
    let stop = false;
    const poll = async () => {
      try {
        const status = selectedRow.mode === 'dry' ? 'PAPER' : 'FILLED';
        const res = await fetch(`${API_URL}/trades?strategy_id=${draft.id}&status=${status}&limit=20`);
        if (res.ok && !stop) setActivity(await res.json());
      } catch { /* transient */ }
    };
    poll();
    const t = setInterval(poll, 10000);
    return () => { stop = true; clearInterval(t); };
  }, [draft.id, selectedRow?.mode]);

  // ── Debounced backtest loop ─────────────────────────────────────────────
  const paramsKey = JSON.stringify(draft.params);
  // Re-run the portfolio backtest when the attached finder's DEFINITION
  // changes (updated_at), not on every 10s list poll.
  const finderVersion = finders.find(f => f.id === draft.finderId)?.updated_at ?? null;
  useEffect(() => {
    if (!draft.code) return;
    if (!isPortfolio && !draft.symbol) return;
    if (codeError) return;                       // editor shows the error inline
    let cancelled = false;

    const timer = setTimeout(async () => {
      setBtLoading(true);

      // ── Portfolio path: finder-selected tokens over /universe data ──────
      if (isPortfolio) {
        try {
          if (!PORTFOLIO_INTERVALS.includes(draft.interval)) {
            setBtResult({ trades: [], equity: [], pending: [], logs: [], stats: null,
              error: `finder-bound strategies need a ${PORTFOLIO_INTERVALS.join('/')} interval (universe data is resampled 1m buckets)` });
            setBars(null); setPfUniverse(null);
            return;
          }
          // Finder definition (cached on id + updated_at).
          const row = finders.find(f => f.id === draft.finderId);
          let fdef = finderCache.current.get(draft.finderId);
          if (!fdef || (row && row.updated_at !== fdef.updatedAt)) {
            const res = await fetch(`${API_URL}/finders/${draft.finderId}`);
            if (!res.ok) throw new Error('finder not found — was it deleted?');
            const f = await res.json();
            let fparams = {};
            try { fparams = JSON.parse(f.params_json || '{}'); } catch { /* legacy */ }
            fdef = { code: f.code, params: fparams, updatedAt: f.updated_at };
            finderCache.current.set(draft.finderId, fdef);
          }
          // Universe: same ~500-bar window a single-symbol backtest sees.
          let cached = universeCache.current.get(draft.interval);
          if (!cached || Date.now() - cached.at > 60_000) {
            const startMs = Date.now() - 500 * INTERVAL_SEC[draft.interval] * 1000;
            const res = await fetch(`${API_URL}/universe?interval=${draft.interval}&start_ms=${startMs}&min_vol_24h=50000`);
            if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
            cached = { normalized: normalizeUniverse(await res.json()), at: Date.now() };
            universeCache.current.set(draft.interval, cached);
          }
          if (cancelled) return;

          const result = runPortfolioBacktest({
            strategyCode: draft.code,
            finderCode: fdef.code,
            universe: cached.normalized,
            maxPositions: parseInt(draft.maxPositions, 10) || 1,
            switchMarginPct: parseFloat(draft.switchMarginPct) || 0,
            params: draft.params,
            finderParams: fdef.params,
            feePct: parseFloat(feePct) || 0,
            slippagePct: parseFloat(slippagePct) || 0,
          });
          if (cancelled) return;
          setBars(null);
          setPfUniverse(cached.normalized);
          setBtResult(result);
          setFlowInfo(null);
        } catch (err) {
          if (!cancelled) setBtResult({ trades: [], equity: [], pending: [], logs: [], stats: null, error: err.message });
        } finally {
          if (!cancelled) setBtLoading(false);
        }
        return;
      }

      // ── Single-symbol path (unchanged) ───────────────────────────────────
      try {
        const key = `${draft.symbol}|${draft.interval}`;
        const needsFlow = /ctx\.flow/.test(draft.code);
        let cached = dataCache.current.get(key);
        if (!cached || Date.now() - cached.at > 60_000 || (needsFlow && !cached.flowRows)) {
          const [klinesRes, flowRes] = await Promise.all([
            fetch(`${API_URL}/klines/${draft.symbol}?interval=${draft.interval}&limit=500`),
            needsFlow ? fetch(`${API_URL}/flow/${draft.symbol}?limit=10080`) : Promise.resolve(null),
          ]);
          const klines = await klinesRes.json();
          const fetchedBars = (klines.data || []).map(d => ({
            time: d[0] / 1000,
            open: parseFloat(d[1]), high: parseFloat(d[2]),
            low: parseFloat(d[3]), close: parseFloat(d[4]),
            volume: parseFloat(d[5]),
          }));
          const flowRows = flowRes ? (await flowRes.json()).data : null;
          cached = { bars: fetchedBars, flowRows, at: Date.now() };
          dataCache.current.set(key, cached);
        }
        if (cancelled) return;
        if (cached.bars.length === 0) {
          setBtResult({ trades: [], equity: [], pending: [], logs: [], stats: null, error: 'no kline data for this symbol' });
          setBars(null);
          return;
        }

        const result = runBacktest({
          code: draft.code,
          bars: cached.bars,
          flowRows: needsFlow ? cached.flowRows : null,
          params: draft.params,
          feePct: parseFloat(feePct) || 0,
          slippagePct: parseFloat(slippagePct) || 0,
          intervalSec: INTERVAL_SEC[draft.interval] || 300,
        });
        if (cancelled) return;
        setBars(cached.bars);
        setBtResult(result);
        if (needsFlow && cached.flowRows) {
          setFlowInfo({
            used: true,
            covered: flowCoverageOf(cached.flowRows, cached.bars, INTERVAL_SEC[draft.interval] || 300),
            total: cached.bars.length,
          });
        } else {
          setFlowInfo(null);
        }
      } catch (err) {
        if (!cancelled) setBtResult({ trades: [], equity: [], pending: [], logs: [], stats: null, error: err.message });
      } finally {
        if (!cancelled) setBtLoading(false);
      }
    }, 600);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [draft.code, draft.symbol, draft.interval, paramsKey, feePct, slippagePct, codeError,
      isPortfolio, draft.finderId, draft.maxPositions, draft.switchMarginPct, finderVersion]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render ──────────────────────────────────────────────────────────────
  const symbolOptions = useMemo(() => {
    const set = new Map(signals.map(s => [s.symbol, s.name || s.symbol]));
    if (draft.symbol && !set.has(draft.symbol)) set.set(draft.symbol, draft.symbol);
    return [...set.entries()];
  }, [signals, draft.symbol]);

  // symbol → friendly ticker, for the backtest title.
  const symbolName = useMemo(() => {
    const names = new Map(signals.map(s => [s.symbol, s.name]));
    return (sym) => prettySymbol(sym, names.get(sym));
  }, [signals]);

  return (
    <div className="workbench">
      {/* ── Left: list + config + editor ── */}
      <div className="wb-left">
        <div className="wb-list-header">
          <span className="wb-title">Strategies</span>
          <select
            className="wb-select"
            value=""
            onChange={(e) => {
              const tpl = TEMPLATES[parseInt(e.target.value, 10)];
              if (tpl) { setDraft(newDraftFromTemplate(tpl, draft.symbol)); setDirty(true); }
            }}
          >
            <option value="">+ New from template…</option>
            {TEMPLATES.map((t, i) => <option key={t.name} value={i}>{t.name}</option>)}
          </select>
        </div>

        <div className="wb-list">
          {list.map(s => (
            <div
              key={s.id}
              className={`wb-list-item ${s.id === draft.id ? 'active' : ''}`}
              onClick={() => selectStrategy(s.id)}
            >
              <div className="wb-list-main">
                <span className="wb-list-name">{s.name}</span>
                <span className="wb-list-sub">
                  {s.finder_id
                    ? `🔍 ${finders.find(f => f.id === s.finder_id)?.name || 'finder'} ×${s.max_positions || 1}`
                    : s.symbol.replace('USDT', '')} · {s.interval}
                </span>
              </div>
              <div className="wb-list-badges">
                {s.last_error && <span className="wb-err-dot" title={s.last_error}>●</span>}
                <span className={`wb-mode-badge mode-${s.mode}`}>{s.mode.toUpperCase()}</span>
              </div>
            </div>
          ))}
          {list.length === 0 && <div className="bt-muted wb-list-empty">No saved strategies yet</div>}
        </div>

        <div className="wb-config">
          <input
            className="wb-input wb-name"
            value={draft.name}
            onChange={(e) => patchDraft({ name: e.target.value })}
            placeholder="Strategy name"
          />
          <div className="wb-config-row">
            <select
              className="wb-select"
              value={draft.finderId || ''}
              title="Token selection: one fixed symbol, or a Token Finder ranking"
              onChange={(e) => {
                const id = e.target.value || null;
                patchDraft({
                  finderId: id,
                  // Finder-bound backtests need a universe-capable interval.
                  interval: id && !PORTFOLIO_INTERVALS.includes(draft.interval) ? '15m' : draft.interval,
                });
              }}
            >
              <option value="">Fixed symbol</option>
              {finders.map(f => <option key={f.id} value={f.id}>🔍 {f.name}</option>)}
            </select>
            {!isPortfolio && (
              <select className="wb-select" value={draft.symbol} onChange={(e) => patchDraft({ symbol: e.target.value })}>
                {symbolOptions.map(([sym, name]) => (
                  <option key={sym} value={sym}>{prettySymbol(sym, name)}</option>
                ))}
              </select>
            )}
            <select className="wb-select wb-interval" value={draft.interval} onChange={(e) => patchDraft({ interval: e.target.value })}>
              {(isPortfolio ? PORTFOLIO_INTERVALS : INTERVALS).map(iv => <option key={iv} value={iv}>{iv}</option>)}
            </select>
          </div>
          {isPortfolio && (
            <div className="wb-config-row">
              <label className="wb-mini-label">max positions
                <input className="wb-input wb-mini" type="number" min="1" max="10" step="1"
                       value={draft.maxPositions}
                       onChange={(e) => patchDraft({ maxPositions: e.target.value })} />
              </label>
              <label className="wb-mini-label" title="A flat slot only switches token when the challenger's score beats the current one by this margin">
                switch margin %
                <input className="wb-input wb-mini" type="number" min="0" max="100" step="1"
                       value={draft.switchMarginPct}
                       onChange={(e) => patchDraft({ switchMarginPct: e.target.value })} />
              </label>
            </div>
          )}

          {Object.keys(paramDefaults).length > 0 && (
            <div className="wb-params">
              {Object.entries(paramDefaults).map(([k, def]) => (
                <label key={k} className="wb-param">
                  <span>{k}</span>
                  <input
                    className="wb-input"
                    type={typeof def === 'number' ? 'number' : 'text'}
                    step="any"
                    value={draft.params[k] ?? def}
                    onChange={(e) => patchDraft({ params: { ...draft.params, [k]: e.target.value } })}
                  />
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="wb-editor">
          <CodeMirror
            value={draft.code}
            height="100%"
            theme="dark"
            extensions={[javascript()]}
            onChange={(val) => patchDraft({ code: val })}
            basicSetup={{ lineNumbers: true, foldGutter: false }}
          />
        </div>
        {codeError && <div className="bt-error wb-code-error">⚠ {codeError}</div>}

        <div className="wb-actions">
          <button className="wb-btn wb-save" onClick={saveDraft}>
            {draft.id ? 'Save' : 'Save as new'}{dirty ? ' *' : ''}
          </button>
          {draft.id && <button className="wb-btn wb-delete" onClick={deleteStrategy}>Delete</button>}
          <button className="wb-btn wb-guide" onClick={() => setShowGuide(true)}>📖 Guide</button>
          {draft.id && onOpenStrategyPage && (
            <button className="wb-btn wb-guide" title="How is this bot doing? Stats, equity, every fill on a chart."
              onClick={() => onOpenStrategyPage(draft.id)}>
              📊 Performance
            </button>
          )}
          <span className="wb-save-msg">{saveMsg}</span>
          <div style={{ flex: 1 }} />
          {draft.id && selectedRow && (
            <div className="wb-mode-toggle">
              {['off', 'dry', 'live'].map(m => (
                <button
                  key={m}
                  className={`wb-mode-btn mode-${m} ${selectedRow.mode === m ? 'active' : ''}`}
                  onClick={() => setMode(m)}
                >
                  {m.toUpperCase()}
                </button>
              ))}
            </div>
          )}
        </div>

        <AssistantPanel
          mode="strategy"
          code={draft.code}
          onInsertCode={(code) => patchDraft({ code })}
        />
      </div>

      {/* ── Right: chart + results ── */}
      <div className="wb-right">
        <div className="wb-chart-bar">
          <span className="wb-title">
            {isPortfolio
              ? `Portfolio backtest — 🔍 ${finders.find(f => f.id === draft.finderId)?.name || 'finder'} × ${draft.maxPositions} slots, ${draft.interval}`
              : `Backtest — ${draft.symbol ? symbolName(draft.symbol) : '…'} ${draft.interval}`}
            {btLoading ? ' (running…)' : ''}
          </span>
          <span className="wb-legend">
            <span className="wb-leg"><span className="wb-leg-mark" style={{ color: '#00ff88' }}>▲</span> buy</span>
            <span className="wb-leg"><span className="wb-leg-mark" style={{ color: '#ff3366' }}>▼</span> sell</span>
            {showEquity && !isPortfolio && (
              <span className="wb-leg"><span className="wb-leg-line" style={{ background: '#3388ff' }} /> equity (cumulative PnL)</span>
            )}
          </span>
          <div style={{ flex: 1 }} />
          <label className="wb-mini-label">fee %
            <input className="wb-input wb-mini" type="number" step="0.05" value={feePct} onChange={e => setFeePct(e.target.value)} />
          </label>
          <label className="wb-mini-label">slip %
            <input className="wb-input wb-mini" type="number" step="0.05" value={slippagePct} onChange={e => setSlippagePct(e.target.value)} />
          </label>
          <label className="wb-mini-label wb-equity-toggle">
            <input type="checkbox" checked={showEquity} onChange={e => setShowEquity(e.target.checked)} /> equity
          </label>
        </div>

        <div className="wb-chart">
          {isPortfolio ? (
            <div className="pf-timeline">
              <SlotTimeline
                slotTimeline={btResult?.slotTimeline || []}
                trades={btResult?.trades || []}
                equity={btResult?.equity || []}
                times={pfUniverse?.times || []}
                maxPositions={parseInt(draft.maxPositions, 10) || 1}
                displayName={(sym) => {
                  const t = pfUniverse?.tokens.find(t => t.symbol === sym);
                  return prettySymbol(sym, t?.name);
                }}
              />
            </div>
          ) : (
            <BacktestChart
              bars={bars}
              trades={btResult?.trades}
              equity={btResult?.equity}
              showEquity={showEquity}
              loading={btLoading && !bars}
            />
          )}
        </div>

        <BacktestResults result={btResult} flowInfo={flowInfo} />

        {draft.id && selectedRow && selectedRow.mode !== 'off' && (
          <div className="wb-activity">
            <div className="bt-section-title">
              {selectedRow.mode === 'dry' ? 'Paper trades' : 'Live fills'} ({activity.length})
              {selectedRow.last_error && <span className="bt-error wb-inline-err"> runner error: {selectedRow.last_error}</span>}
            </div>
            <table>
              <thead><tr><th>Time</th><th>Token</th><th>Side</th><th>Price</th><th>In</th><th>Out</th></tr></thead>
              <tbody>
                {activity.map(t => (
                  <tr key={t.id}>
                    <td>{new Date(t.block_time).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{symbolName(t.symbol)}</td>
                    <td className={t.direction === 'BUY' ? 'stat-pos' : 'stat-neg'}>{t.direction}</td>
                    <td>{t.execution_price}</td>
                    <td>{t.amount_in}</td>
                    <td>{t.amount_out}</td>
                  </tr>
                ))}
                {activity.length === 0 && <tr><td colSpan={6} className="bt-muted">No {selectedRow.mode === 'dry' ? 'paper trades' : 'fills'} yet</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showGuide && (
        <GuidePanel
          section="strategy-contract"
          onClose={() => setShowGuide(false)}
          onInsert={(code) => { patchDraft({ code }); setShowGuide(false); }}
        />
      )}
    </div>
  );
}

// Bars whose window overlaps at least one 1m flow bucket.
function flowCoverageOf(flowRows, bars, intervalSec) {
  if (!flowRows || flowRows.length === 0) return 0;
  const firstMs = flowRows[0][0];
  const lastMs = flowRows[flowRows.length - 1][0] + 60_000;
  return bars.filter(b => b.time * 1000 + intervalSec * 1000 > firstMs && b.time * 1000 < lastMs).length;
}
