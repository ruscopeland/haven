// Token Finder tab — author a JS ranking function, see how the ranking would
// have evolved over the selected window, and validate it against what the
// picked tokens actually did next. Sibling of StrategyWorkbench: same
// edit → debounce → re-run loop, but the dataset (/universe) is fetched ONCE
// per timeframe selection and every code/param tweak re-ranks locally.
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import {
  loadFinder, normalizeUniverse, runRanking,
  computeForwardReturns, finderQuality, FINDER_TEMPLATES,
} from '@sdk/index.js';
import RankingRiver, { QualityStrip, colorMap } from './RankingRiver';
import GuidePanel from './GuidePanel';
import AssistantPanel from './AssistantPanel';
import '../strategies.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const FINDER_INTERVALS = ['5m', '15m', '30m', '1h'];
const LOOKBACK_DAYS = [1, 2, 3, 5, 7];
const VOL_FLOORS = [
  [10_000, '$10k'], [50_000, '$50k'], [100_000, '$100k'],
  [500_000, '$500k'], [1_000_000, '$1M'],
];
const DRAFT_KEY = 'finderDraft';

const prettySymbol = (sym, name) => {
  if (!sym) return '';
  if (name && name !== sym) return name;
  return sym.replace(/^ALPHA_/, '').replace(/USDT$/, '');
};

const newDraftFromTemplate = (tpl) => ({
  id: null, name: tpl.name, code: tpl.code, interval: '15m', params: {},
});

const fmtScore = (v) => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toPrecision(3));
const fmtVol = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}k`);

export default function FinderWorkbench() {
  const [list, setList] = useState([]);
  const [draft, setDraft] = useState(() => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) return JSON.parse(saved);
    } catch { /* corrupted draft — start fresh */ }
    return newDraftFromTemplate(FINDER_TEMPLATES[0]);
  });
  const [dirty, setDirty] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [showGuide, setShowGuide] = useState(false);

  // Dataset controls (each change refetches /universe once).
  const [lookbackDays, setLookbackDays] = useState(3);
  const [minVol, setMinVol] = useState(100_000);
  const [topN, setTopN] = useState(5);
  const [horizon, setHorizon] = useState(8);       // forward-return bars

  const [universe, setUniverse] = useState(null);
  const [uniLoading, setUniLoading] = useState(false);
  const [uniError, setUniError] = useState(null);
  const [result, setResult] = useState(null);      // { rankings, quality, fwd, error }
  const [pinnedGi, setPinnedGi] = useState(null);
  const universeCache = useRef(new Map());         // key → { normalized, at }

  const { finder: parsedFinder, error: codeError } = useMemo(
    () => loadFinder(draft.code), [draft.code]);
  const paramDefaults = parsedFinder?.params || {};

  // ── Saved finders list ───────────────────────────────────────────────────
  const fetchList = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/finders`);
      if (res.ok) setList(await res.json());
    } catch { /* API down — health dot already shows it */ }
  }, []);

  useEffect(() => {
    fetchList();
    const t = setInterval(fetchList, 10000);
    return () => clearInterval(t);
  }, [fetchList]);

  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* full */ }
  }, [draft]);

  const patchDraft = (patch) => { setDraft(d => ({ ...d, ...patch })); setDirty(true); };

  const selectFinder = async (id) => {
    try {
      const res = await fetch(`${API_URL}/finders/${id}`);
      if (!res.ok) return;
      const f = await res.json();
      let params = {};
      try { params = JSON.parse(f.params_json || '{}'); } catch { /* legacy */ }
      setDraft({ id: f.id, name: f.name, code: f.code, interval: f.interval, params });
      setDirty(false);
    } catch (err) { console.error('Failed to load finder', err); }
  };

  const saveDraft = async () => {
    const body = {
      name: draft.name,
      code: draft.code,
      interval: draft.interval,
      params_json: JSON.stringify(draft.params || {}),
    };
    try {
      const res = draft.id
        ? await fetch(`${API_URL}/finders/${draft.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch(`${API_URL}/finders`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      const f = await res.json();
      setDraft(d => ({ ...d, id: f.id }));
      setDirty(false);
      setSaveMsg('Saved ✓');
      setTimeout(() => setSaveMsg(''), 2000);
      fetchList();
    } catch (err) {
      setSaveMsg(`Save failed: ${err.message}`);
    }
  };

  const deleteFinder = async () => {
    if (!draft.id) return;
    if (!window.confirm(`Delete finder "${draft.name}"?`)) return;
    try {
      const res = await fetch(`${API_URL}/finders/${draft.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const detail = (await res.json()).detail || res.statusText;
        setSaveMsg(`Delete failed: ${detail}`);   // 409 while strategies use it
        return;
      }
      setDraft(d => ({ ...d, id: null }));
      fetchList();
    } catch (err) { console.error('Failed to delete finder', err); }
  };

  // ── Universe fetch (once per timeframe selection) ────────────────────────
  useEffect(() => {
    let cancelled = false;
    const key = `${draft.interval}|${lookbackDays}|${minVol}`;
    const cached = universeCache.current.get(key);
    if (cached && Date.now() - cached.at < 60_000) {
      setUniverse(cached.normalized);
      return;
    }
    (async () => {
      setUniLoading(true);
      setUniError(null);
      try {
        const startMs = Date.now() - lookbackDays * 24 * 3600 * 1000;
        const res = await fetch(
          `${API_URL}/universe?interval=${draft.interval}&start_ms=${startMs}&min_vol_24h=${minVol}`);
        if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
        const normalized = normalizeUniverse(await res.json());
        if (cancelled) return;
        universeCache.current.set(key, { normalized, at: Date.now() });
        setUniverse(normalized);
      } catch (err) {
        if (!cancelled) { setUniverse(null); setUniError(err.message); }
      } finally {
        if (!cancelled) setUniLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [draft.interval, lookbackDays, minVol]);

  // ── Debounced local re-rank (no refetch) ─────────────────────────────────
  const paramsKey = JSON.stringify(draft.params);
  useEffect(() => {
    if (!universe || codeError) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const ranked = runRanking({ code: draft.code, universe, params: draft.params });
      if (cancelled) return;
      const fwd = computeForwardReturns(universe, horizon);
      const quality = finderQuality(ranked.rankings, fwd, topN);
      setResult({ rankings: ranked.rankings, logs: ranked.logs, error: ranked.error, fwd, quality });
      setPinnedGi(p => (p != null && p < ranked.rankings.length ? p : null));
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [universe, draft.code, paramsKey, topN, horizon, codeError]);

  // ── Derived view data ────────────────────────────────────────────────────
  const nameOf = useMemo(() => {
    const names = new Map((universe?.tokens || []).map(t => [t.symbol, t.name]));
    return (sym) => prettySymbol(sym, names.get(sym));
  }, [universe]);

  const metaOf = useMemo(() => {
    const m = new Map((universe?.tokens || []).map(t => [t.symbol, t]));
    return (sym) => m.get(sym);
  }, [universe]);

  const lastRankedGi = useMemo(() => {
    const r = result?.rankings || [];
    for (let gi = r.length - 1; gi >= 0; gi--) if (r[gi]) return gi;
    return null;
  }, [result]);

  const tableGi = pinnedGi ?? lastRankedGi;
  const tableRows = tableGi != null ? (result?.rankings[tableGi] || []).slice(0, 30) : [];
  const riverColors = useMemo(
    () => (result ? colorMap(result.rankings, topN) : new Map()),
    [result, topN]);

  const selectedRow = useMemo(() => list.find(f => f.id === draft.id) || null, [list, draft.id]);

  return (
    <div className="workbench">
      {/* ── Left: list + config + editor ── */}
      <div className="wb-left">
        <div className="wb-list-header">
          <span className="wb-title">Token Finders</span>
          <select
            className="wb-select"
            value=""
            onChange={(e) => {
              const tpl = FINDER_TEMPLATES[parseInt(e.target.value, 10)];
              if (tpl) { setDraft(newDraftFromTemplate(tpl)); setDirty(true); }
            }}
          >
            <option value="">+ New from template…</option>
            {FINDER_TEMPLATES.map((t, i) => <option key={t.name} value={i}>{t.name}</option>)}
          </select>
        </div>

        <div className="wb-list">
          {list.map(f => (
            <div
              key={f.id}
              className={`wb-list-item ${f.id === draft.id ? 'active' : ''}`}
              onClick={() => selectFinder(f.id)}
            >
              <div className="wb-list-main">
                <span className="wb-list-name">{f.name}</span>
                <span className="wb-list-sub">{f.interval}</span>
              </div>
              <div className="wb-list-badges">
                {f.last_error && <span className="wb-err-dot" title={f.last_error}>●</span>}
              </div>
            </div>
          ))}
          {list.length === 0 && <div className="bt-muted wb-list-empty">No saved finders yet</div>}
        </div>

        <div className="wb-config">
          <input
            className="wb-input wb-name"
            value={draft.name}
            onChange={(e) => patchDraft({ name: e.target.value })}
            placeholder="Finder name"
          />
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
          {draft.id && <button className="wb-btn wb-delete" onClick={deleteFinder}>Delete</button>}
          <button className="wb-btn wb-guide" onClick={() => setShowGuide(true)}>📖 Guide</button>
          <span className="wb-save-msg">{saveMsg}</span>
        </div>

        <AssistantPanel
          mode="finder"
          code={draft.code}
          onInsertCode={(code) => patchDraft({ code })}
        />
      </div>

      {/* ── Right: ranking river + quality + pinned table ── */}
      <div className="wb-right">
        <div className="wb-chart-bar">
          <span className="wb-title">
            Ranking — {universe ? `${universe.tokens.length} tokens` : '…'}
            {uniLoading ? ' (loading data…)' : ''}
          </span>
          <div style={{ flex: 1 }} />
          <label className="wb-mini-label">interval
            <select className="wb-select wb-mini-select" value={draft.interval}
                    onChange={(e) => patchDraft({ interval: e.target.value })}>
              {FINDER_INTERVALS.map(iv => <option key={iv} value={iv}>{iv}</option>)}
            </select>
          </label>
          <label className="wb-mini-label">lookback
            <select className="wb-select wb-mini-select" value={lookbackDays}
                    onChange={(e) => setLookbackDays(parseInt(e.target.value, 10))}>
              {LOOKBACK_DAYS.map(d => <option key={d} value={d}>{d}d</option>)}
            </select>
          </label>
          <label className="wb-mini-label">min 24h vol
            <select className="wb-select wb-mini-select" value={minVol}
                    onChange={(e) => setMinVol(parseInt(e.target.value, 10))}>
              {VOL_FLOORS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </label>
          <label className="wb-mini-label">top
            <select className="wb-select wb-mini-select" value={topN}
                    onChange={(e) => setTopN(parseInt(e.target.value, 10))}>
              {[3, 5, 8, 10].map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label className="wb-mini-label">fwd horizon
            <select className="wb-select wb-mini-select" value={horizon}
                    onChange={(e) => setHorizon(parseInt(e.target.value, 10))}>
              {[4, 8, 16, 24, 48].map(v => <option key={v} value={v}>{v} bars</option>)}
            </select>
          </label>
        </div>

        <div className="fw-body">
          {uniError && <div className="bt-error">⚠ universe: {uniError}</div>}
          {result?.error && <div className="bt-error">⚠ finder: {result.error}</div>}

          <div className="bt-section-title fw-river-title">
            Top-{topN} ranking over time — click to pin a moment
            {pinnedGi != null && (
              <button className="fw-unpin" onClick={() => setPinnedGi(null)}>follow latest ✕</button>
            )}
          </div>
          <RankingRiver
            rankings={result?.rankings || []}
            times={universe?.times || []}
            topN={topN}
            pinnedGi={pinnedGi}
            onPin={setPinnedGi}
            displayName={nameOf}
          />

          <div className="bt-section-title">
            Finder quality — avg forward return of top-{topN} picks vs universe median ({horizon} bars ahead)
          </div>
          <QualityStrip
            quality={result?.quality}
            times={universe?.times || []}
            horizonLabel={`+${horizon} bars`}
          />

          <div className="bt-section-title">
            Ranking at {tableGi != null && universe
              ? new Date(universe.times[tableGi] * 1000).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
              : '—'}
            {pinnedGi != null ? ' (pinned)' : ' (latest)'}
            {selectedRow?.last_error && (
              <span className="bt-error wb-inline-err"> evaluator error: {selectedRow.last_error}</span>
            )}
          </div>
          <div className="fw-table">
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Token</th><th>Score</th>
                  <th>Fwd {horizon} bars</th><th>24h vol</th><th>24h %</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r, k) => {
                  const fwdV = result?.fwd?.bySymbol.get(r.symbol)?.[tableGi];
                  const meta = metaOf(r.symbol);
                  return (
                    <tr key={r.symbol}>
                      <td>
                        <span className="fw-rank-dot" style={{ background: riverColors.get(r.symbol) || '#2a2f42' }} />
                        {k + 1}
                      </td>
                      <td>{nameOf(r.symbol)}</td>
                      <td>{fmtScore(r.score)}</td>
                      <td className={fwdV > 0 ? 'stat-pos' : fwdV < 0 ? 'stat-neg' : ''}>
                        {fwdV == null ? '—' : `${fwdV >= 0 ? '+' : ''}${fwdV.toFixed(2)}%`}
                      </td>
                      <td>{meta ? fmtVol(meta.volume24h) : '—'}</td>
                      <td className={meta?.priceChange24h > 0 ? 'stat-pos' : meta?.priceChange24h < 0 ? 'stat-neg' : ''}>
                        {meta ? `${meta.priceChange24h.toFixed(1)}%` : '—'}
                      </td>
                    </tr>
                  );
                })}
                {tableRows.length === 0 && (
                  <tr><td colSpan={6} className="bt-muted">
                    {uniLoading ? 'Loading universe…' : 'No tokens ranked at this time'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {showGuide && (
        <GuidePanel
          section="finder-contract"
          onClose={() => setShowGuide(false)}
          onInsert={(code) => { patchDraft({ code }); setShowGuide(false); }}
        />
      )}
    </div>
  );
}
