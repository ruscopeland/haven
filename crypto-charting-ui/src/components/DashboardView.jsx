import { useState, useEffect } from 'react';
import StrategyStatusBoard from './StrategyStatusBoard';
import EngineControls from './EngineControls';
import ActivityTables from './ActivityTables';
import WalletPanel from './WalletPanel';
import QuickTrade from './QuickTrade';
import '../dashboard.css';

const API_URL = 'http://localhost:8000';

// Home tab. Owns the two polls shared by every panel (overview 5s, token
// metadata 5min) so child panels don't duplicate traffic.
export default function DashboardView({ onOpenStrategy }) {
  const [overview, setOverview] = useState(null);
  const [tokenMap, setTokenMap] = useState({});

  useEffect(() => {
    let alive = true;
    const loadOverview = async () => {
      try {
        const r = await fetch(`${API_URL}/dashboard/overview`);
        if (r.ok && alive) setOverview(await r.json());
      } catch { /* panel-level errors are surfaced by children */ }
    };
    const loadTokens = async () => {
      try {
        const r = await fetch(`${API_URL}/tokens?limit=500`);
        if (!r.ok || !alive) return;
        const list = await r.json();
        setTokenMap(Object.fromEntries(list.map(t => [t.symbol, t])));
      } catch { /* names fall back to raw symbols */ }
    };
    loadOverview(); loadTokens();
    const a = setInterval(loadOverview, 5_000);
    const b = setInterval(loadTokens, 300_000);
    return () => { alive = false; clearInterval(a); clearInterval(b); };
  }, []);

  const prices = overview?.token_prices || {};

  return (
    <div className="dash-root">
      <div className="dash-col">
        <StrategyStatusBoard prices={prices} tokenMap={tokenMap} onOpenStrategy={onOpenStrategy} />
        <ActivityTables overview={overview} tokenMap={tokenMap} />
      </div>
      <div className="dash-col">
        <EngineControls />
        <WalletPanel prices={prices} tokenMap={tokenMap} />
        <QuickTrade tokenMap={tokenMap} prices={prices} />
      </div>
    </div>
  );
}
