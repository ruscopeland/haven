// Token Finder tab — author a JS ranking function, see how the ranking would
// have evolved over the selected window, and validate it against what the
// picked tokens actually did next. Sibling of StrategyWorkbench: same
// edit → debounce → re-run loop, but the dataset (/universe) is fetched ONCE
// per timeframe selection and every code/param tweak re-ranks locally.
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import {
  normalizeUniverse, FINDER_TEMPLATES,
} from '../sdk/index.js';
import { runStrategyWorker } from '../workers/strategyWorkerClient.js';
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
  return sym.replace(/_\d+_bsc$/, '');
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
  const [showCodeEditor, setShowCodeEditor] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [saveDialogError, setSaveDialogError] = useState('');
  const codeDialogRef = useRef(null);
  const saveDialogRef = useRef(null);

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

  const [validation, setValidation] = useState({ error: null, params: {} });
  useEffect(() => {
    let active = true;
    runStrategyWorker('validateFinder', { code: draft.code }, 2_000)
      .then(value => { if (active) setValidation(value); })
      .catch(error => { if (active) setValidation({ error: error.message, params: {} }); });
    return () => { active = false; };
  }, [draft.code]);
  const codeError = validation.error;
  const paramDefaults = validation.params || {};

  // ── Saved finders list ───────────────────────────────────────────────────
  const fetchList = useCallback(async () => {
    try {
      // A save is followed by this read; force a fresh list so the new finder
      // is immediately available when the Strategy editor is opened.
      const res = await fetch(`${API_URL}/finders`, { cache: 'no-store' });
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

  const draftBody = () => ({
      name: draft.name,
      code: draft.code,
      interval: draft.interval,
      params_json: JSON.stringify(draft.params || {}),
    });

  const saveDraft = async () => {
    const body = draftBody();
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
      return true;
    } catch (err) {
      const message = `Save failed: ${err.message}`;
      setSaveMsg(message);
      setSaveDialogError(message);
      return false;
    }
  };

  const saveFinderAs = async (name) => {
    try {
      const res = await fetch(`${API_URL}/finders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draftBody(), name }),
      });
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      const f = await res.json();
      setDraft(d => ({ ...d, id: f.id, name: f.name }));
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
      const saved = await saveFinderAs(name);
      if (saved) setShowSaveDialog(false);
    } finally {
      setSavePending(false);
    }
  };

  const overwriteSavedFinder = () => {
    saveDraft().then((saved) => { if (saved) setShowSaveDialog(false); });
  };

  const saveCodeAndClose = () => {
    setShowCodeEditor(false);
    openSaveDialog();
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
  useEffect(() => {
    if (!universe || codeError) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const ranked = await runStrategyWorker('finderAnalysis', {
        code: draft.code, universe, params: draft.params, horizon, topN,
      });
      if (cancelled) return;
      setResult({
        rankings: ranked.rankings, logs: ranked.logs, error: ranked.error,
        fwd: ranked.fwd, quality: ranked.quality,
      });
      setPinnedGi(p => (p != null && p < ranked.rankings.length ? p : null));
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [universe, draft.code, draft.params, topN, horizon, codeError]);

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

  const selectedRow = list.find(f => f.id === draft.id) || null;

  const selectedFinderKey = draft.id
    ? `saved:${draft.id}`
    : (() => {
        const templateIndex = FINDER_TEMPLATES.findIndex(t => t.name === draft.name && t.code === draft.code);
        return templateIndex >= 0 ? `template:${templateIndex}` : 'draft';
      })();

  const selectFinderFromMenu = (value) => {
    if (value.startsWith('saved:')) {
      selectFinder(value.slice('saved:'.length));
      return;
    }
    if (value.startsWith('template:')) {
      const template = FINDER_TEMPLATES[parseInt(value.slice('template:'.length), 10)];
      if (template) { setDraft(newDraftFromTemplate(template)); setDirty(true); }
    }
  };

  return (
    <div className="workbench">
      {/* ── Left: list + config + editor ── */}
      <div className="wb-left">
        <div className="wb-list-header">
          <span className="wb-title">Token Finders</span>
          <select
            className="wb-select"
            aria-label="Select a token finder"
            value={selectedFinderKey}
            onChange={(e) => selectFinderFromMenu(e.target.value)}
          >
            {selectedFinderKey === 'draft' && <option value="draft">Current unsaved finder</option>}
            <optgroup label="Built-in token finders">
              {FINDER_TEMPLATES.map((t, i) => <option key={t.name} value={`template:${i}`}>{t.name}</option>)}
            </optgroup>
            <optgroup label="Saved token finders">
              {list.map(f => <option key={f.id} value={`saved:${f.id}`}>{f.name}</option>)}
            </optgroup>
          </select>
        </div>

        <div className="wb-config">
          <div className="wb-name-row">
            <input
              className="wb-input wb-name"
              value={draft.name}
              onChange={(e) => patchDraft({ name: e.target.value })}
              placeholder="Token Finder name"
              aria-label="Token Finder name"
            />
            <button type="button" className="wb-btn wb-save" disabled={!dirty} onClick={openSaveDialog}>Save</button>
          </div>
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
            <div className="wb-title">Advanced token finder editor</div>
            <div className="bt-muted">Advanced token finder editor, used for editing the token finder at the code level, for users who like coding. If coding is not your thing, you can get the same results by telling the LLM below and it will do the coding for you.</div>
          </div>
          <button type="button" className="wb-btn wb-save" onClick={() => setShowCodeEditor(true)}>Advanced token finder editor</button>
        </div>
        {codeError && <div className="bt-error wb-code-error">⚠ {codeError}</div>}

        <div className="wb-actions">
          {draft.id && <button className="wb-btn wb-delete" onClick={deleteFinder}>Delete</button>}
          <span className="wb-save-msg">{saveMsg}</span>
        </div>

        <AssistantPanel
          mode="finder"
          code={draft.code}
          onInsertCode={(code, name) => patchDraft({ code, ...(name ? { name } : {}) })}
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

      <dialog
        ref={codeDialogRef}
        className="wb-code-dialog"
        aria-labelledby="finder-code-editor-title"
        onClose={() => setShowCodeEditor(false)}
      >
        <div className="wb-code-dialog-header">
          <div>
            <h2 id="finder-code-editor-title">Token Finder code</h2>
            <p className="bt-muted">Changes update this Token Finder draft. Save to apply them to the saved Token Finder.</p>
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
        aria-labelledby="save-finder-title"
        onClose={() => { setShowSaveDialog(false); setConfirmOverwrite(false); }}
      >
        <div className="wb-code-dialog-header">
          <h2 id="save-finder-title">{confirmOverwrite ? 'Overwrite saved Token Finder?' : 'Save Token Finder as'}</h2>
          <button type="button" className="wb-btn wb-guide" onClick={() => setShowSaveDialog(false)}>Close</button>
        </div>
        {confirmOverwrite ? (
          <div className="wb-save-dialog-body">
            <p>This will replace the saved Token Finder named <strong>{selectedRow?.name}</strong>.</p>
            <div className="wb-code-dialog-actions">
              <button type="button" className="wb-btn wb-guide" onClick={() => setConfirmOverwrite(false)}>No</button>
              <button type="button" className="wb-btn wb-save" onClick={overwriteSavedFinder}>Yes, overwrite</button>
            </div>
          </div>
        ) : (
          <form className="wb-save-dialog-body" onSubmit={(event) => { event.preventDefault(); submitSaveName(); }}>
            <label className="wb-save-name-label">Token Finder name
              <input name="finderName" className="wb-input" value={saveName} onChange={(e) => setSaveName(e.target.value)} autoFocus required />
            </label>
            <p className="bt-muted">Change the name to save these settings to a new Token Finder file, or leave the name as is to overwrite the existing one. Your saved Token Finder allowance depends on your current tier.</p>
            {saveDialogError && <div className="bt-error wb-save-dialog-error" role="alert">{saveDialogError}</div>}
            <div className="wb-code-dialog-actions">
              <button type="button" className="wb-btn wb-guide" disabled={savePending} onClick={() => setShowSaveDialog(false)}>Cancel</button>
              <button type="submit" className="wb-btn wb-save" disabled={savePending || !saveName.trim()}>{savePending ? 'Saving…' : 'Continue'}</button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}
