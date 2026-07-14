import { lazy, Suspense, useState, useEffect, useRef, useCallback } from 'react'
import Screener from './components/Screener'
import Chart from './components/Chart'
import DashboardView from './components/DashboardView'
import SettingsView from './components/SettingsView'
import TokenDetailView from './components/TokenDetailView'
import StrategyDetailView from './components/StrategyDetailView'
import PortfolioView from './components/PortfolioView'
import EngineToggle from './components/EngineToggle'
import MarketTicker from './components/MarketTicker'
import HavenLogo from './components/HavenLogo'
import LegalDocView from './components/LegalDoc'
import LegalFooter from './components/LegalFooter'
import UpgradeBanner from './components/UpgradeBanner'
import { RISK_SUMMARY_SHORT } from './legal/content.js'

const StrategyWorkbench = lazy(() => import('./components/StrategyWorkbench.jsx'));
const FinderWorkbench = lazy(() => import('./components/FinderWorkbench.jsx'));
const OwnerOperations = lazy(() => import('./components/OwnerOperations.jsx'));

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const LAYOUT_NAMES_KEY = 'chartLayoutNames';

const NAV = [
  ['dashboard', 'Dashboard'],
  ['portfolio', 'Portfolio'],
  ['charts', 'Charts'],
  ['strategies', 'Strategies'],
  ['finder', 'Token Finder'],
  ['docs', 'Docs'],
  ['settings', 'Settings'],
];

function HealthDot({ status, label }) {
  const colors = { ok: '#34d399', warning: '#fbbf24', down: '#fb7185', unknown: '#2a2f42' };
  const tip = `${label}: ${status || 'unknown'}`;
  return (
    <span className="health-label" title={tip}>
      {label}
      <span style={{
        display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
        background: colors[status] || colors.unknown, marginLeft: 4,
      }} />
    </span>
  );
}

function loadLayoutNames() {
  try {
    const raw = localStorage.getItem(LAYOUT_NAMES_KEY);
    if (raw) return { 1: 'Layout 1', 2: 'Layout 2', 3: 'Layout 3', 4: 'Layout 4', 5: 'Layout 5', ...JSON.parse(raw) };
  } catch { /* */ }
  return { 1: 'Layout 1', 2: 'Layout 2', 3: 'Layout 3', 4: 'Layout 4', 5: 'Layout 5' };
}

function App() {
  const [selectedTokens, setSelectedTokens] = useState([]);
  const [activePreset, setActivePreset] = useState(null);
  const [view, setView] = useState('dashboard');
  const [selectedStrategyId, setSelectedStrategyId] = useState(null);
  const [pageToken, setPageToken] = useState(null);
  const [pageStrategyId, setPageStrategyId] = useState(null);
  const [portfolioFocus, setPortfolioFocus] = useState(null); // symbol for swap focus
  const [tempChartActive, setTempChartActive] = useState(false);
  const savedChartsRef = useRef(null);
  const [signals, setSignals] = useState([]);
  const [sortBy, setSortBy] = useState("vol_24h");
  const [health, setHealth] = useState({ market_data: 'unknown', execution_engine: 'unknown' });
  const [signalError, setSignalError] = useState(false);
  const [layoutNames, setLayoutNames] = useState(loadLayoutNames);
  const [gridMode, setGridMode] = useState(null); // null = auto, or 1/2/4/6
  const [legalDoc, setLegalDoc] = useState(null); // terms | privacy | risk | null (docs is a main view)
  const [ownerAccess, setOwnerAccess] = useState(false);

  const [presets, setPresets] = useState(() => {
    const saved = localStorage.getItem('chartPresets');
    if (saved) return JSON.parse(saved);
    return { 1: [], 2: [], 3: [], 4: [], 5: [] };
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get('token');
    if (tokenParam) {
      const [symbol, ...nameParts] = tokenParam.split('|');
      const name = nameParts.join('|') || symbol.replace('USDT', '');
      setSelectedTokens(prev => {
        const exists = prev.find(t => t.symbol === symbol);
        if (exists) return prev;
        return [...prev, { symbol, name, priceChange24h: 0, interval: '5m' }];
      });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch(`${API_URL}/owner/overview`)
      .then(r => { if (active && r.ok) setOwnerAccess(true); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const fetchHealth = useCallback(async () => {
    try {
      const [res, engineRes] = await Promise.all([
        fetch(`${API_URL}/health`), fetch(`${API_URL}/engine/health`),
      ]);
      const data = await res.json();
      const statuses = {};
      Object.entries(data).forEach(([k, v]) => { statuses[k] = v.status; });
      if (engineRes.ok) statuses.execution_engine = (await engineRes.json()).status;
      setHealth(prev => ({ ...prev, ...statuses }));
    } catch {
      setHealth({ market_data: 'unknown', execution_engine: 'unknown' });
    }
  }, []);

  const fetchSignals = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/signals?limit=400&sort_by=${sortBy}`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setSignals(data);
      setSignalError(false);
    } catch (err) {
      console.error("Failed to fetch signals", err);
      setSignalError(true);
    }
  }, [sortBy]);

  useEffect(() => {
    fetchHealth();
    fetchSignals();
    const healthInterval = setInterval(fetchHealth, 15000);
    const pollInterval = setInterval(fetchSignals, 15000);
    return () => { clearInterval(healthInterval); clearInterval(pollInterval); };
  }, [fetchHealth, fetchSignals]);

  const toggleToken = (tokenObj) => {
    setSelectedTokens((prev) => {
      const exists = prev.find(t => t.symbol === tokenObj.symbol);
      if (exists) {
        return prev.filter(t => t.symbol !== tokenObj.symbol);
      } else {
        return [...prev, { ...tokenObj, interval: '5m' }];
      }
    });
  };

  const updateTokenInterval = (symbol, interval) => {
    setSelectedTokens(prev => prev.map(t => t.symbol === symbol ? { ...t, interval } : t));
  };

  const savePreset = (num) => {
    const newPresets = { ...presets, [num]: selectedTokens };
    setPresets(newPresets);
    localStorage.setItem('chartPresets', JSON.stringify(newPresets));
    setActivePreset(num);
  };

  const loadPreset = (num) => {
    if (presets[num]) {
      setSelectedTokens(presets[num]);
      setActivePreset(num);
    }
  };

  const renameLayout = (num) => {
    const current = layoutNames[num] || `Layout ${num}`;
    const name = window.prompt('Layout name', current);
    if (!name || !name.trim()) return;
    const next = { ...layoutNames, [num]: name.trim().slice(0, 24) };
    setLayoutNames(next);
    localStorage.setItem(LAYOUT_NAMES_KEY, JSON.stringify(next));
  };

  const navigate = (key) => {
    if (tempChartActive && key !== 'charts') {
      const saved = savedChartsRef.current;
      savedChartsRef.current = null;
      setTempChartActive(false);
      setSelectedTokens(saved?.selectedTokens || []);
      setActivePreset(saved?.activePreset ?? null);
    }
    // Nav always resets nested legal docs; openLegalPage uses setView only.
    setLegalDoc(null);
    setView(key);
  };

  const openLegalPage = (k) => {
    setLegalDoc(k === 'docs' ? null : k);
    setView('docs');
  };

  const openTokenPage = (t) => {
    setPageToken(t);
    navigate('token');
  };

  const openStrategyPage = (id) => {
    setPageStrategyId(id);
    navigate('strategy');
  };

  const openStrategyEditor = (id) => {
    setSelectedStrategyId(id);
    navigate('strategies');
  };

  // Portfolio with optional token pre-selected for manual swap (from Charts).
  const openPortfolioSwap = (symbol, name) => {
    setPortfolioFocus(symbol || null);
    if (symbol) setPageToken({ symbol, name: name || symbol });
    navigate('portfolio');
  };

  // Full Charts tab for one token (from token page / portfolio).
  const openFullChart = (symbol, name) => {
    if (!tempChartActive) {
      savedChartsRef.current = { selectedTokens, activePreset };
      setTempChartActive(true);
    }
    setSelectedTokens([{ symbol, name: name || symbol, priceChange24h: 0, interval: '5m' }]);
    setActivePreset(null);
    setView('charts');
  };

  const openMarkerChart = (symbol, name) => {
    openFullChart(symbol, name);
  };

  const openTopFlow = () => {
    const top = signals.slice(0, 4).map(s => ({
      symbol: s.symbol,
      name: s.name || s.symbol,
      priceChange24h: s.price_change_24h,
      interval: '5m',
    }));
    if (top.length) {
      setSelectedTokens(top);
      setActivePreset(null);
    }
  };

  const count = selectedTokens.length;
  let cols = 1;
  let rows = 1;
  if (gridMode === 1) { cols = 1; rows = Math.max(1, count); }
  else if (gridMode === 2) { cols = 2; rows = Math.ceil(Math.max(1, count) / 2); }
  else if (gridMode === 4) { cols = 2; rows = 2; }
  else if (gridMode === 6) { cols = 3; rows = 2; }
  else if (count > 0) {
    cols = Math.ceil(Math.sqrt(count * 1.5));
    rows = Math.ceil(count / cols);
  }

  const detailActive = view === 'token' || view === 'strategy';

  return (
    <div className="app-container" style={{ flexDirection: 'column' }}>
      {/* App-wide market ticker (same real /public feed as landing) */}
      <div className="app-ticker-bar">
        <MarketTicker />
      </div>

      {/* Nav tabs span full width so opening Charts never shifts them. */}
      <div className="preset-toolbar" style={{
        display: 'flex', gap: '8px', padding: '10px 16px',
        background: 'rgba(13, 20, 38, 0.75)', backdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--border-glass)', alignItems: 'center', flexWrap: 'wrap',
        flexShrink: 0,
      }}>
        <HavenLogo size={26} />
        {[...NAV, ...(ownerAccess ? [['owner', 'Owner Ops']] : [])].map(([key, label]) => {
          const active = view === key
            || (view === 'token' && (key === 'dashboard' || key === 'portfolio'))
            || (view === 'strategy' && key === 'dashboard');
          return (
            <button key={key} onClick={() => navigate(key)} className={`nav-tab${active ? ' active' : ''}`}>
              {label}
            </button>
          );
        })}

        {detailActive && (
          <span className="app-breadcrumb">
            <button type="button" onClick={() => navigate(view === 'token' ? 'portfolio' : 'dashboard')}>
              {view === 'token' ? 'Portfolio' : 'Dashboard'}
            </button>
            {' › '}
            {view === 'token' && (pageToken?.name || pageToken?.symbol)}
            {view === 'strategy' && 'Strategy'}
          </span>
        )}

        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginRight: 8 }}>
          <HealthDot label="API" status={signalError ? 'down' : 'ok'} />
          <HealthDot label="Market feed" status={health.market_data || 'unknown'} />
          <HealthDot label="Engine" status={health.execution_engine || 'unknown'} />
        </div>

        <EngineToggle />
      </div>

      <UpgradeBanner onOpenSettings={() => navigate('settings')} />

      {/* Below tabs: screener (charts only) sits beside page content, top-aligned with layouts row */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {view === 'charts' && (
        <Screener
          onToggle={toggleToken}
          selectedTokens={selectedTokens}
          signals={signals}
          sortBy={sortBy}
          setSortBy={setSortBy}
        />
      )}

      <div className="main-content" style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', minWidth: 0 }}>
        {view === 'charts' && (
          <div className="charts-toolbar">
            <span style={{ color: 'var(--text-muted)', fontWeight: 600, fontSize: 11 }}>Layouts</span>
            {[1, 2, 3, 4, 5].map(num => (
              <button
                key={num}
                onClick={() => loadPreset(num)}
                onDoubleClick={() => renameLayout(num)}
                className={`nav-tab${activePreset === num ? ' active' : ''}`}
                style={{ padding: '5px 10px', fontSize: 12 }}
                title={`${layoutNames[num]} — double-click to rename · ${presets[num]?.length || 0} charts`}
              >
                {layoutNames[num]}
              </button>
            ))}
            <button
              className="btn-secondary"
              style={{ padding: '5px 12px', fontSize: 12 }}
              disabled={!activePreset}
              onClick={() => activePreset && savePreset(activePreset)}
              title={activePreset ? `Save current charts to ${layoutNames[activePreset]}` : 'Select a layout slot first'}
            >
              Save layout
            </button>
            <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 8 }}>Grid</span>
            {[null, 1, 2, 4, 6].map(g => (
              <button
                key={String(g)}
                className={`nav-tab${gridMode === g ? ' active' : ''}`}
                style={{ padding: '5px 10px', fontSize: 12 }}
                onClick={() => setGridMode(g)}
              >
                {g == null ? 'Auto' : g}
              </button>
            ))}
            {count > 0 && (
              <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 'auto' }}>
                {count} chart{count === 1 ? '' : 's'} open
              </span>
            )}
          </div>
        )}

        <Suspense fallback={<div className="charts-empty" aria-busy="true">Loading…</div>}>
        {view === 'dashboard' ? (
          <DashboardView
            signals={signals}
            onOpenStrategy={openStrategyPage}
            onOpenStrategyEditor={openStrategyEditor}
            onOpenMarkerChart={openMarkerChart}
            onSelectToken={openTokenPage}
            onGoSettings={() => navigate('settings')}
            onGoStrategies={() => navigate('strategies')}
          />
        ) : view === 'portfolio' ? (
          <PortfolioView
            signals={signals}
            focusSymbol={portfolioFocus}
            onOpenToken={openTokenPage}
            onOpenChart={openFullChart}
          />
        ) : view === 'token' && pageToken ? (
          <TokenDetailView
            symbol={pageToken.symbol}
            name={pageToken.name}
            signals={signals}
            onBack={() => navigate('portfolio')}
            onOpenChart={openFullChart}
            onOpenPortfolio={openPortfolioSwap}
          />
        ) : view === 'strategy' && pageStrategyId ? (
          <StrategyDetailView
            strategyId={pageStrategyId}
            onBack={() => navigate('dashboard')}
            onEdit={openStrategyEditor}
          />
        ) : view === 'settings' ? (
          <SettingsView onOpenLegal={openLegalPage} />
        ) : view === 'docs' ? (
          <LegalDocView
            docKey={legalDoc || 'docs'}
            onBack={() => {
              if (legalDoc) setLegalDoc(null);
              else navigate('dashboard');
            }}
          />
        ) : view === 'strategies' ? (
          <StrategyWorkbench signals={signals} initialSelectId={selectedStrategyId}
            onOpenStrategyPage={openStrategyPage} />
        ) : view === 'finder' ? (
          <FinderWorkbench />
        ) : view === 'owner' ? (
          <OwnerOperations />
        ) : (
          <div
            className="charts-grid"
            style={{
              flex: 1,
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
              overflow: 'hidden'
            }}
          >
            {count === 0 ? (
              <div className="charts-empty">
                <h3>No charts open</h3>
                <p>Select tokens from the screener, load a saved layout, or open the most active markets.</p>
                <div className="charts-empty-actions">
                  <button className="btn-primary" style={{ padding: '8px 14px', fontSize: 13 }}
                    onClick={() => loadPreset(1)} disabled={!presets[1]?.length}>
                    Load {layoutNames[1]}
                  </button>
                  <button className="btn-secondary" style={{ padding: '8px 14px', fontSize: 13 }}
                    onClick={openTopFlow} disabled={!signals.length}>
                    Open top volume
                  </button>
                </div>
              </div>
            ) : (
              selectedTokens.map(token => (
                <Chart
                  key={token.symbol}
                  token={token}
                  onClose={() => toggleToken(token)}
                  onIntervalChange={(newInterval) => updateTokenInterval(token.symbol, newInterval)}
                  signals={signals}
                  onOpenSwap={openPortfolioSwap}
                  onOpenToken={openTokenPage}
                />
              ))
            )}
          </div>
        )}
        </Suspense>

        {view !== 'charts' && (
          <div className="app-legal-bar">
            <span className="app-legal-strip">{RISK_SUMMARY_SHORT}</span>
            <LegalFooter
              showStrip={false}
              onOpen={openLegalPage}
            />
          </div>
        )}
      </div>
      </div>
    </div>
  )
}

export default App
