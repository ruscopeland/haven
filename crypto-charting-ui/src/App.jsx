import { useState, useEffect, useRef } from 'react'
import Screener from './components/Screener'
import Chart from './components/Chart'
import StrategyWorkbench from './components/StrategyWorkbench'
import FinderWorkbench from './components/FinderWorkbench'
import DashboardView from './components/DashboardView'
import SettingsView from './components/SettingsView'
import TokenDetailView from './components/TokenDetailView'
import EngineToggle from './components/EngineToggle'

const API_URL = 'http://localhost:8000';

function HealthDot({ status }) {
  const colors = { ok: '#00ff88', warning: '#fbbf24', down: '#ff3366', unknown: '#2a2f42' };
  return <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: colors[status] || colors.unknown, marginLeft: 6 }} title={status} />;
}

function App() {
  const [selectedTokens, setSelectedTokens] = useState([]);
  const [activePreset, setActivePreset] = useState(null);
  const [view, setView] = useState('dashboard');   // 'dashboard' | 'token' | 'charts' | 'strategies' | 'finder' | 'settings'
  const [selectedStrategyId, setSelectedStrategyId] = useState(null);
  const [pageToken, setPageToken] = useState(null); // {symbol, name} for the token detail page
  // Marker-deep-link: a one-off chart view that isn't part of any saved
  // preset. `savedChartsRef` holds whatever was on the Charts page before we
  // jumped there, so leaving the temp view restores it exactly.
  const [tempChartActive, setTempChartActive] = useState(false);
  const savedChartsRef = useRef(null);
  const [signals, setSignals] = useState([]);
  const [sortBy, setSortBy] = useState("flow_15m");
  const [health, setHealth] = useState({ collector: 'unknown', execution_engine: 'unknown' });
  const [signalError, setSignalError] = useState(false);

  // Load presets from local storage
  const [presets, setPresets] = useState(() => {
    const saved = localStorage.getItem('chartPresets');
    if (saved) return JSON.parse(saved);
    return { 1: [], 2: [], 3: [], 4: [], 5: [] };
  });

  // Health check polling
  // Accept token from wallet app via URL param
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

  const fetchHealth = async () => {
    try {
      const res = await fetch(`${API_URL}/health`);
      const data = await res.json();
      const statuses = {};
      Object.entries(data).forEach(([k, v]) => { statuses[k] = v.status; });
      setHealth(prev => ({ ...prev, ...statuses }));
    } catch {
      setHealth({ collector: 'unknown', execution_engine: 'unknown' });
    }
  };

  const fetchSignals = async () => {
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
  };

  useEffect(() => {
    fetchHealth();
    fetchSignals();
    const healthInterval = setInterval(fetchHealth, 15000);
    const pollInterval = setInterval(fetchSignals, 15000);
    return () => { clearInterval(healthInterval); clearInterval(pollInterval); };
  }, [sortBy]);

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

  // All navigation goes through here so leaving Charts while a marker's
  // one-off chart is showing restores whatever was there before it opened.
  const navigate = (key) => {
    if (tempChartActive && key !== 'charts') {
      const saved = savedChartsRef.current;
      savedChartsRef.current = null;
      setTempChartActive(false);
      setSelectedTokens(saved?.selectedTokens || []);
      setActivePreset(saved?.activePreset ?? null);
    }
    setView(key);
  };

  // Token detail page (from a Dashboard holdings row) — an in-app page, not
  // a separate browser tab like the old wallet app used to open.
  const openTokenPage = (t) => {
    setPageToken(t);
    navigate('token');
  };

  // Marker deep-link: show only that marker's token on the Charts page,
  // without disturbing the preset/tokens the user had open there.
  const openMarkerChart = (symbol, name) => {
    if (!tempChartActive) {
      savedChartsRef.current = { selectedTokens, activePreset };
      setTempChartActive(true);
    }
    setSelectedTokens([{ symbol, name: name || symbol, priceChange24h: 0, interval: '5m' }]);
    setActivePreset(null);
    setView('charts');
  };

  const count = selectedTokens.length;
  let cols = 1;
  let rows = 1;

  if (count > 0) {
    cols = Math.ceil(Math.sqrt(count * 1.5)); 
    rows = Math.ceil(count / cols);
  }

  return (
    <div className="app-container">
      {view === 'charts' && (
        <Screener
          onToggle={toggleToken}
          selectedTokens={selectedTokens}
          signals={signals}
          sortBy={sortBy}
          setSortBy={setSortBy}
        />
      )}

      <div className="main-content" style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
        <div className="preset-toolbar" style={{ display: 'flex', gap: '10px', padding: '10px 16px', background: 'rgba(13, 20, 38, 0.75)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--border-glass)', alignItems: 'center' }}>
          <span className="logo-title" style={{ marginRight: 8 }}>⚡ Alpha Terminal</span>
          {[['dashboard', '🏠 Dashboard'], ['charts', '📊 Charts'], ['strategies', '⚡ Strategies'], ['finder', '🔍 Token Finder'], ['settings', '⚙ Settings']].map(([key, label]) => {
            const active = view === key || (view === 'token' && key === 'dashboard');
            return (
              <button key={key} onClick={() => navigate(key)} className={`nav-tab${active ? ' active' : ''}`}>
                {label}
              </button>
            );
          })}

          {view === 'charts' && (
            <>
              <span style={{ color: 'var(--text-muted)', fontWeight: 'bold', marginLeft: '16px', fontSize: 12 }}>Layouts:</span>
              {[1, 2, 3, 4, 5].map(num => (
                <button
                  key={num}
                  onClick={() => loadPreset(num)}
                  className={`nav-tab${activePreset === num ? ' active' : ''}`}
                  style={{ padding: '7px 12px' }}
                >
                  {num}
                </button>
              ))}
            </>
          )}
          <div style={{ flex: 1 }}></div>

          {/* Health indicators */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginRight: '12px', fontSize: '10px', color: 'var(--text-muted)' }}>
            <span>API</span><HealthDot status={signalError ? 'down' : 'ok'} />
            <span style={{ marginLeft: 8 }}>Collector</span><HealthDot status={health.collector || 'unknown'} />
            <span style={{ marginLeft: 8 }}>Engine</span><HealthDot status={health.execution_engine || 'unknown'} />
          </div>

          <EngineToggle />

          {view === 'charts' && (
            <button
              onClick={() => activePreset && savePreset(activePreset)}
              style={{
                background: 'var(--success-gradient)',
                color: '#04120c',
                border: 'none',
                padding: '7px 16px',
                borderRadius: '9999px',
                cursor: activePreset ? 'pointer' : 'not-allowed',
                opacity: activePreset ? 1 : 0.3,
                fontWeight: 'bold',
                fontSize: 13,
                fontFamily: 'var(--font-display)',
                transition: 'opacity 0.2s'
              }}
              disabled={!activePreset}
            >
              Save to Preset {activePreset ? activePreset : ''}
            </button>
          )}
        </div>

        {view === 'dashboard' ? (
          <DashboardView
            signals={signals}
            onOpenStrategy={(id) => { setSelectedStrategyId(id); navigate('strategies'); }}
            onOpenMarkerChart={openMarkerChart}
            onSelectToken={openTokenPage}
          />
        ) : view === 'token' && pageToken ? (
          <TokenDetailView
            symbol={pageToken.symbol}
            name={pageToken.name}
            signals={signals}
            onBack={() => navigate('dashboard')}
          />
        ) : view === 'settings' ? (
          <SettingsView />
        ) : view === 'strategies' ? (
          <StrategyWorkbench signals={signals} initialSelectId={selectedStrategyId} />
        ) : view === 'finder' ? (
          <FinderWorkbench />
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
              <div style={{ margin: 'auto', color: '#a0a5b8', fontSize: '1.2rem' }}>
                Select a token from the screener or load a preset
              </div>
            ) : (
              selectedTokens.map(token => (
                <Chart
                  key={token.symbol}
                  token={token}
                  onClose={() => toggleToken(token)}
                  onIntervalChange={(newInterval) => updateTokenInterval(token.symbol, newInterval)}
                  signals={signals}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default App
