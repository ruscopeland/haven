import { useState, useEffect } from 'react'
import Screener from './components/Screener'
import Chart from './components/Chart'
import StrategyWorkbench from './components/StrategyWorkbench'
import FinderWorkbench from './components/FinderWorkbench'
import DashboardView from './components/DashboardView'
import SettingsView from './components/SettingsView'

const API_URL = 'http://localhost:8000';

function HealthDot({ status }) {
  const colors = { ok: '#00ff88', warning: '#fbbf24', down: '#ff3366', unknown: '#2a2f42' };
  return <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: colors[status] || colors.unknown, marginLeft: 6 }} title={status} />;
}

function App() {
  const [selectedTokens, setSelectedTokens] = useState([]);
  const [activePreset, setActivePreset] = useState(null);
  const [view, setView] = useState('dashboard');   // 'dashboard' | 'charts' | 'strategies' | 'finder'
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
        <div className="preset-toolbar" style={{ display: 'flex', gap: '10px', padding: '10px', background: '#131722', borderBottom: '1px solid #2a2f42', alignItems: 'center' }}>
          <span style={{ color: '#e5e9f0', fontWeight: 'bold', fontSize: 15, marginRight: 8, whiteSpace: 'nowrap' }}>⚡ Alpha Terminal</span>
          {[['dashboard', '🏠 Dashboard'], ['charts', '📊 Charts'], ['strategies', '⚡ Strategies'], ['finder', '🔍 Token Finder'], ['settings', '⚙ Settings']].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setView(key)}
              style={{
                background: view === key ? '#3388ff' : '#2a2f42',
                color: '#fff',
                border: 'none',
                padding: '6px 16px',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: view === key ? 'bold' : 'normal',
                transition: 'background 0.2s'
              }}
            >
              {label}
            </button>
          ))}

          {view === 'charts' && (
            <>
              <span style={{ color: '#a0a5b8', fontWeight: 'bold', marginLeft: '16px' }}>Layouts:</span>
              {[1, 2, 3, 4, 5].map(num => (
                <button
                  key={num}
                  onClick={() => loadPreset(num)}
                  style={{
                    background: activePreset === num ? '#3388ff' : '#2a2f42',
                    color: '#fff',
                    border: 'none',
                    padding: '6px 12px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: activePreset === num ? 'bold' : 'normal',
                    transition: 'background 0.2s'
                  }}
                >
                  {num}
                </button>
              ))}
            </>
          )}
          <div style={{ flex: 1 }}></div>

          {/* Health indicators */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginRight: '12px', fontSize: '10px', color: '#a0a5b8' }}>
            <span>API</span><HealthDot status={signalError ? 'down' : 'ok'} />
            <span style={{ marginLeft: 8 }}>Collector</span><HealthDot status={health.collector || 'unknown'} />
            <span style={{ marginLeft: 8 }}>Engine</span><HealthDot status={health.execution_engine || 'unknown'} />
          </div>

          {view === 'charts' && (
            <button
              onClick={() => activePreset && savePreset(activePreset)}
              style={{
                background: '#00ff88',
                color: '#000',
                border: 'none',
                padding: '6px 16px',
                borderRadius: '4px',
                cursor: activePreset ? 'pointer' : 'not-allowed',
                opacity: activePreset ? 1 : 0.3,
                fontWeight: 'bold',
                transition: 'opacity 0.2s'
              }}
              disabled={!activePreset}
            >
              Save to Preset {activePreset ? activePreset : ''}
            </button>
          )}
        </div>

        {view === 'dashboard' ? (
          <DashboardView />
        ) : view === 'settings' ? (
          <SettingsView />
        ) : view === 'strategies' ? (
          <StrategyWorkbench signals={signals} />
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
