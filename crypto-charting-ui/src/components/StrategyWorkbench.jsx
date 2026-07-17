import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import {
  normalizeUniverse, TEMPLATES,
} from '@sdk/index.js';
import { runStrategyWorker } from '../workers/strategyWorkerClient.js';
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
// is available at these intervals from the server-side Binance Alpha candle cache.
const PORTFOLIO_INTERVALS = ['5m', '15m', '30m', '1h'];
const DRAFT_KEY = 'strategyDraft';

// Human-readable ticker: prefer the Binance Alpha display name ("BSB (Block
// Street)"), else strip Haven's internal Binance Alpha-id/chain suffix.
const prettySymbol = (sym, name) => {
  if (!sym) return '';
  if (name && name !== sym) return name;
  return sym.replace(/_\d+_bsc$/, '');
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
  const [feePct, setFeePct] = useState('0.25');
  const [slippagePct, setSlippagePct] = useState('0.1');
  const [showEquity, setShowEquity] = useState(true);
  const [bars, setBars] = useState(null);
  const [saveMsg, setSaveMsg] = useState('');
  const [activity, setActivity] = useState([]);
  const [finders, setFinders] = useState([]);
  const [finderLoadError, setFinderLoadError] = useState('');
  const [pfUniverse, setPfUniverse] = useState(null);   // normalized universe of the last portfolio run
  const [showGuide, setShowGuide] = useState(false);
  const [showSlots, setShowSlots] = useState(false);    // "bot slots full" dialog (deploy hit a 409)
  const [showCodeEditor, setShowCodeEditor] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [saveDialogError, setSaveDialogError] = useState('');
  const codeDialogRef = useRef(null);
  const saveDialogRef = useRef(null);
  const dataCache = useRef(new Map());   // `${symbol}|${interval}` → { bars, at }
  const universeCache = useRef(new Map()); // `${interval}` → { normalized, at }
  const finderCache = useRef(new Map());   // finderId → { code, params, updatedAt }

  const isPortfolio = !!draft.finderId;

  // The saved row backing the current draft (for mode/status badges).
  const selectedRow = useMemo(() => list.find(s => s.id === draft.id) || null, [list, draft.id]);

  // Strategy defaults drive the params form; re-parsed as the code changes.
  const [validation, setValidation] = useState({ error: null, params: {} });
  useEffect(() => {
    let active = true;
    runStrategyWorker('validateStrategy', { code: draft.code }, 2_000)
      .then(result => { if (active) setValidation(result); })
      .catch(error => { if (active) setValidation({ error: error.message, params: {} }); });
    return () => { active = false; };
  }, [draft.code]);
  const codeError = validation.error;
  const paramDefaults = validation.params || {};

  // ── Strategy list (poll for runner status updates) ─────────────────────
  const fetchList = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/strategies`);
      if (res.ok) setList(await res.json());
    } catch { /* API down — health dot already shows it */ }
    try {
      // Finders are saved in a separate tab. Do not let a cached empty list
      // hide a finder that was just created when this editor opens.
      const res = await fetch(`${API_URL}/finders`, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.statusText);
      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error('unexpected response');
      setFinders(rows);
      setFinderLoadError('');
    } catch {
      setFinderLoadError('Could not load saved Token Finders. Refresh and try again.');
    }
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

  useEffect(() => {
    const dialog = codeDialogRef.current;
    if (!dialog) return;
    if (showCodeEditor && !dialog.open) dialog.showModal();
    if (!showCodeEditor && dialog.open) dialog.close();
  }, [showCodeEditor]);

  useEffect(() => {
    const dialog = saveDialogRef.current;
    if (!dialog) return;
    if (showSaveDialog && !dialog.open) dialog.showModal();
    if (!showSaveDialog && dialog.open) dialog.close();
  }, [showSaveDialog]);

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

  // The saved shape of the current editor contents. switch_margin_pct has no
  // UI field anymore (owner decision 2026-07-06) — it rides along at the
  // loaded row's value or the default 10; it only affects which token a FLAT
  // slot picks next, never an open position.
  const draftBody = () => {
    const margin = parseFloat(draft.switchMarginPct);
    return {
      name: draft.name,
      code: draft.code,
      // '' + finder_id means dynamic selection server-side.
      symbol: draft.finderId ? '' : draft.symbol,
      interval: draft.interval,
      params_json: JSON.stringify(draft.params || {}),
      max_positions: parseInt(draft.maxPositions, 10) || 1,
      switch_margin_pct: Number.isFinite(margin) ? margin : 10,
      ...(draft.finderId ? { finder_id: draft.finderId } : {}),
    };
  };

  const saveDraft = async () => {
    // Overwriting a RUNNING strategy hot-reloads the deployed bot with the new
    // definition — never do that silently.
    if (draft.id && selectedRow && selectedRow.mode !== 'off') {
      const ok = window.confirm(
        `"${selectedRow.name}" is deployed (${selectedRow.mode.toUpperCase()}) — saving updates ` +
        `the running bot with this new definition (it restarts and re-warms from history).\n\n` +
        `OK = update the running bot.\nCancel = go back (use "Save as copy" to keep it untouched).`);
      if (!ok) return false;
    }
    const body = {
      ...draftBody(),
      // PATCH needs the explicit clear flag to detach a finder.
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
      return true;
    } catch (err) {
      const message = `Save failed: ${err.message}`;
      setSaveMsg(message);
      setSaveDialogError(message);
      return false;
    }
  };

  const saveCodeAndClose = () => {
    setShowCodeEditor(false);
    openSaveDialog();
  };

  const saveDraftAs = async (name) => {
    try {
      const res = await fetch(`${API_URL}/strategies`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draftBody(), name }),
      });
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      const s = await res.json();
      setDraft(d => ({ ...d, id: s.id, name: s.name }));
      setDirty(false);
      setSaveMsg('Saved ✓');
      setTimeout(() => setSaveMsg(''), 2000);
      fetchList();
      return true;
    } catch (err) {
      const message = `Save failed: ${err.message}`;
      setSaveMsg(message);
      setSaveDialogError(message);
      return false;
    }
  };

  const openSaveDialog = () => {
    setSaveName(draft.name);
    setConfirmOverwrite(false);
    setSaveDialogError('');
    setShowSaveDialog(true);
  };

  const submitSaveName = async () => {
    const name = saveName.trim();
    if (!name || savePending) return;
    if (draft.id && name === selectedRow?.name) {
      setConfirmOverwrite(true);
      return;
    }
    setSaveDialogError('');
    setSavePending(true);
    try {
      const saved = await saveDraftAs(name);
      if (saved) setShowSaveDialog(false);
    } finally {
      setSavePending(false);
    }
  };

  const overwriteSavedStrategy = () => {
    saveDraft().then((saved) => { if (saved) setShowSaveDialog(false); });
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

  // Deploy = arm in DRY (paper) mode. LIVE can only be armed from the bot's
  // Performance page (owner decision 2026-07-06) — the workbench never
  // touches real funds.
  const armDry = async () => {
    if (!draft.id) return;
    if (dirty) {
      window.alert('Save the strategy first — the runner executes the SAVED code, not this draft.');
      return;
    }
    try {
      const res = await fetch(`${API_URL}/strategies/${draft.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'dry' }),
      });
      if (res.ok) { fetchList(); return; }
      if (res.status === 409) { setShowSlots(true); return; }  // bot slots full → offer to stop one
      const d = await res.json().catch(() => ({}));
      window.alert(d.detail || `Could not deploy (HTTP ${res.status}).`);
    } catch (err) { console.error('Failed to deploy', err); }
  };

  const stopStrategy = async (id) => {
    try {
      const res = await fetch(`${API_URL}/strategies/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'off' }),
      });
      if (res.ok) fetchList();
    } catch (err) { console.error('Failed to stop strategy', err); }
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
  }, [draft.id, selectedRow]);

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

          const result = await runStrategyWorker('portfolioBacktest', {
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
        let cached = dataCache.current.get(key);
        if (!cached || Date.now() - cached.at > 60_000) {
          const klinesRes = await fetch(`${API_URL}/klines/${draft.symbol}?interval=${draft.interval}&limit=500`);
          const klines = await klinesRes.json();
          const fetchedBars = (klines.data || []).map(d => ({
            time: d[0] / 1000,
            open: parseFloat(d[1]), high: parseFloat(d[2]),
            low: parseFloat(d[3]), close: parseFloat(d[4]),
            volume: parseFloat(d[5]),
          }));
          cached = { bars: fetchedBars, at: Date.now() };
          dataCache.current.set(key, cached);
        }
        if (cancelled) return;
        if (cached.bars.length === 0) {
          setBtResult({ trades: [], equity: [], pending: [], logs: [], stats: null, error: 'no kline data for this symbol' });
          setBars(null);
          return;
        }

        const result = await runStrategyWorker('backtest', {
          code: draft.code,
          bars: cached.bars,
          params: draft.params,
          feePct: parseFloat(feePct) || 0,
          slippagePct: parseFloat(slippagePct) || 0,
          intervalSec: INTERVAL_SEC[draft.interval] || 300,
        });
        if (cancelled) return;
        setBars(cached.bars);
        setBtResult(result);
      } catch (err) {
        if (!cancelled) setBtResult({ trades: [], equity: [], pending: [], logs: [], stats: null, error: err.message });
      } finally {
        if (!cancelled) setBtLoading(false);
      }
    }, 600);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [draft.code, draft.symbol, draft.interval, draft.params, paramsKey, feePct, slippagePct, codeError,
      isPortfolio, draft.finderId, draft.maxPositions, draft.switchMarginPct, finderVersion, finders]);

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

  const selectedStrategyKey = draft.id
    ? `saved:${draft.id}`
    : (() => {
        const templateIndex = TEMPLATES.findIndex(t => t.name === draft.name && t.code === draft.code);
        return templateIndex >= 0 ? `template:${templateIndex}` : 'draft';
      })();

  const selectStrategyFromMenu = (value) => {
    if (value.startsWith('saved:')) {
      selectStrategy(value.slice('saved:'.length));
      return;
    }
    if (value.startsWith('template:')) {
      const template = TEMPLATES[parseInt(value.slice('template:'.length), 10)];
      if (template) { setDraft(newDraftFromTemplate(template, draft.symbol)); setDirty(true); }
    }
  };

  return (
    <div className="workbench">
      {/* ── Left: list + config + editor ── */}
      <div className="wb-left">
        <div className="wb-list-header">
          <span className="wb-title">Strategies</span>
          <select
            className="wb-select"
            aria-label="Select a strategy"
            value={selectedStrategyKey}
            onChange={(e) => selectStrategyFromMenu(e.target.value)}
          >
            {selectedStrategyKey === 'draft' && <option value="draft">Current unsaved draft</option>}
            <optgroup label="Built-in strategies">
              {TEMPLATES.map((t, i) => <option key={t.name} value={`template:${i}`}>{t.name}</option>)}
            </optgroup>
            <optgroup label="Saved strategies">
              {list.map(s => <option key={s.id} value={`saved:${s.id}`}>{s.name}</option>)}
            </optgroup>
          </select>
        </div>

        <div className="wb-config">
          <div className="wb-editing-note">
            {draft.id ? (
              <>Editing saved strategy
                {selectedRow && selectedRow.mode !== 'off' && (
                  <b className={`wb-running-tag mode-${selectedRow.mode}`}> — deployed {selectedRow.mode.toUpperCase()}</b>
                )}
              </>
            ) : (
              <b className="wb-new-tag">New draft — not saved yet</b>
            )}
          </div>
          <div className="wb-name-row">
            <input
              className="wb-input wb-name"
              value={draft.name}
              onChange={(e) => patchDraft({ name: e.target.value })}
              placeholder="Strategy name"
              aria-label="Strategy name"
            />
            <button type="button" className="wb-btn wb-save" disabled={!dirty} onClick={openSaveDialog}>Save</button>
          </div>
          <div className="wb-config-row">
            <select
              className="wb-select"
              value={draft.finderId || ''}
              title="Token selection: one fixed symbol, or a Token Finder ranking"
              onChange={(e) => {
                const id = e.target.value || null;
                // A fixed-symbol backtest can have an error (for example no
                // candles). It is not meaningful for a finder-bound portfolio
                // and must not remain on screen while its universe loads.
                setBtResult(null);
                setBars(null);
                setPfUniverse(null);
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
          {finderLoadError && <div className="bt-error">⚠ {finderLoadError}</div>}
          {isPortfolio && (
            <div className="wb-config-row">
              <label className="wb-mini-label">max positions
                <input className="wb-input wb-mini" type="number" min="1" max="10" step="1"
                       value={draft.maxPositions}
                       onChange={(e) => patchDraft({ maxPositions: e.target.value })} />
              </label>
              {/* switch margin % field removed 2026-07-06 (owner decision): the
                  hysteresis keeps its default internally — a slot holding a
                  position is never closed by a rebind; only FLAT slots pick a
                  new token, after the previous trade closed. */}
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

        <div className="wb-code-launch">
          <div>
            <div className="wb-title">Advanced strategy editor</div>
            <div className="bt-muted">Advanced strategy editor, used for editing the strategy at the code level, for users who like coding. If coding is not your thing, you can get the same results by telling the LLM below and it will do the coding for you.</div>
          </div>
          <button type="button" className="wb-btn wb-save" onClick={() => setShowCodeEditor(true)}>Advanced strategy editor</button>
        </div>
        {codeError && <div className="bt-error wb-code-error">⚠ {codeError}</div>}

        <div className="wb-actions">
          {draft.id && <button className="wb-btn wb-delete" onClick={deleteStrategy}>Delete</button>}
          {draft.id && onOpenStrategyPage && (
            <button className="wb-btn wb-guide" title="How is this bot doing? Stats, equity, every fill on a chart — and the LIVE switch."
              onClick={() => onOpenStrategyPage(draft.id)}>
              Performance
            </button>
          )}
          <span className="wb-save-msg">{saveMsg}</span>
          <div style={{ flex: 1 }} />
          {draft.id && selectedRow && (selectedRow.mode === 'off' ? (
            <button className="wb-btn wb-deploy"
              title="Start this bot in DRY (paper) mode — simulated fills, no real funds. Go LIVE from its Performance page."
              onClick={armDry}>
              ▶ Deploy (paper)
            </button>
          ) : (
            <>
              <span className={`wb-mode-badge mode-${selectedRow.mode}`}>{selectedRow.mode.toUpperCase()}</span>
              <button className="wb-btn wb-stop" title="Stop this bot (it keeps its stats and can be redeployed any time)"
                onClick={() => stopStrategy(draft.id)}>
                ⏹ Stop
              </button>
            </>
          ))}
        </div>

        <AssistantPanel
          mode="strategy"
          code={draft.code}
          onInsertCode={(code, name) => patchDraft({ code, ...(name ? { name } : {}) })}
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

        <BacktestResults result={btResult} />

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

      <dialog
        ref={codeDialogRef}
        className="wb-code-dialog"
        aria-labelledby="strategy-code-editor-title"
        onClose={() => setShowCodeEditor(false)}
      >
        <div className="wb-code-dialog-header">
          <div>
            <h2 id="strategy-code-editor-title">Strategy code</h2>
            <p className="bt-muted">Changes update this strategy draft. Save to apply them to the saved strategy.</p>
          </div>
          <div className="wb-code-dialog-header-actions">
            <button type="button" className="wb-btn wb-guide" onClick={() => { setShowCodeEditor(false); setShowGuide(true); }}>Guide</button>
            <button type="button" className="wb-btn wb-guide" onClick={() => setShowCodeEditor(false)}>Close</button>
          </div>
        </div>
        <div className="wb-code-dialog-editor">
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
        <div className="wb-code-dialog-actions">
          <button type="button" className="wb-btn wb-guide" onClick={() => setShowCodeEditor(false)}>Cancel</button>
          <button type="button" className="wb-btn wb-save" onClick={saveCodeAndClose}>Save &amp; close</button>
        </div>
      </dialog>

      <dialog
        ref={saveDialogRef}
        className="wb-save-dialog"
        aria-labelledby="save-strategy-title"
        onClose={() => { setShowSaveDialog(false); setConfirmOverwrite(false); }}
      >
        <div className="wb-code-dialog-header">
          <h2 id="save-strategy-title">{confirmOverwrite ? 'Overwrite saved strategy?' : 'Save strategy as'}</h2>
          <button type="button" className="wb-btn wb-guide" onClick={() => setShowSaveDialog(false)}>Close</button>
        </div>
        {confirmOverwrite ? (
          <div className="wb-save-dialog-body">
            <p>This will replace the saved strategy named <strong>{selectedRow?.name}</strong>.</p>
            <div className="wb-code-dialog-actions">
              <button type="button" className="wb-btn wb-guide" onClick={() => setConfirmOverwrite(false)}>No</button>
              <button type="button" className="wb-btn wb-save" onClick={overwriteSavedStrategy}>Yes, overwrite</button>
            </div>
          </div>
        ) : (
          <form className="wb-save-dialog-body" onSubmit={(event) => { event.preventDefault(); submitSaveName(); }}>
            <label className="wb-save-name-label">Strategy name
              <input name="strategyName" className="wb-input" value={saveName} onChange={(e) => setSaveName(e.target.value)} autoFocus required />
            </label>
            <p className="bt-muted">Change the name to save these settings to a new strategy file, or leave the name as is to overwrite the existing one. You are allowed 5 saved strategies on your current tier.</p>
            {saveDialogError && <div className="bt-error wb-save-dialog-error" role="alert">{saveDialogError}</div>}
            <div className="wb-code-dialog-actions">
              <button type="button" className="wb-btn wb-guide" disabled={savePending} onClick={() => setShowSaveDialog(false)}>Cancel</button>
              <button type="submit" className="wb-btn wb-save" disabled={savePending || !saveName.trim()}>{savePending ? 'Saving…' : 'Continue'}</button>
            </div>
          </form>
        )}
      </dialog>

      {/* Deploy hit the plan's bot-slot cap (409): show what's running and let
          the user free a slot without leaving the page. Stopped bots keep
          their stats and can be redeployed any time. */}
      {showSlots && (
        <div className="wb-modal-backdrop" onClick={() => setShowSlots(false)}>
          <div className="wb-modal" onClick={(e) => e.stopPropagation()}>
            <h3>All bot slots are in use</h3>
            <p className="bt-muted wb-modal-text">
              Your plan's running-bot slots are full. Stop one of these bots to free a
              slot, then deploy again. Stopped bots keep all their stats and can be
              redeployed whenever you want.
            </p>
            <div className="wb-modal-list">
              {list.filter(s => s.mode !== 'off').map(s => (
                <div key={s.id} className="wb-modal-row">
                  <div className="wb-list-main">
                    <span className="wb-list-name">{s.name}</span>
                    <span className="wb-list-sub">
                      {s.finder_id
                        ? `🔍 ${finders.find(f => f.id === s.finder_id)?.name || 'finder'} ×${s.max_positions || 1}`
                        : s.symbol.replace('USDT', '')} · {s.interval}
                    </span>
                  </div>
                  <span className={`wb-mode-badge mode-${s.mode}`}>{s.mode.toUpperCase()}</span>
                  <button className="wb-btn wb-stop" onClick={() => stopStrategy(s.id)}>⏹ Stop</button>
                </div>
              ))}
              {list.filter(s => s.mode !== 'off').length === 0 && (
                <div className="bt-muted">Nothing is running now — a slot is free.</div>
              )}
            </div>
            <div className="wb-modal-actions">
              <button className="wb-btn wb-deploy" onClick={() => { setShowSlots(false); armDry(); }}>
                ▶ Deploy again
              </button>
              <button className="wb-btn" onClick={() => setShowSlots(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
