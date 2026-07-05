import { useState, useEffect, useMemo } from 'react';
import StrategyStatusBoard from './StrategyStatusBoard';
import EngineControls from './EngineControls';
import ActivityTables from './ActivityTables';
import WalletPanel from './WalletPanel';
import PortfolioSummary from './PortfolioSummary';
import useWalletData from '../hooks/useWalletData';
import { computePnl } from '../utils/pnl';
import '../dashboard.css';

const API_URL = 'http://localhost:8000';

// Home tab. Owns the polls shared by every panel (overview 5s, token
// metadata 5min, filled trades 30s for PnL) so child panels don't
// duplicate traffic. Wallet balances come from the key-free C2 hook.
export default function DashboardView({ signals, onOpenStrategy, onOpenMarkerChart, onSelectToken }) {
  const [overview, setOverview] = useState(null);
  const [tokenMap, setTokenMap] = useState({});
  const [filledTrades, setFilledTrades] = useState([]);
  const wallet = useWalletData();

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
    const loadFilled = async () => {
      try {
        const r = await fetch(`${API_URL}/trades?status=FILLED&limit=1000`);
        if (r.ok && alive) setFilledTrades(await r.json());
      } catch { /* PnL cards show zeros until the next poll */ }
    };
    loadOverview(); loadTokens(); loadFilled();
    const a = setInterval(loadOverview, 5_000);
    const b = setInterval(loadTokens, 300_000);
    const c = setInterval(loadFilled, 30_000);
    return () => { alive = false; clearInterval(a); clearInterval(b); clearInterval(c); };
  }, []);

  const prices = overview?.token_prices || {};
  const pnlBySymbol = useMemo(() => computePnl(filledTrades), [filledTrades]);
  const lastTradeBySymbol = useMemo(() => {
    const map = {};
    for (const t of filledTrades) {
      if (!t.block_time) continue;
      if (!map[t.symbol] || t.block_time > map[t.symbol]) map[t.symbol] = t.block_time;
    }
    return map;
  }, [filledTrades]);

  return (
    <div className="dash-root">
      <PortfolioSummary
        wallet={wallet}
        prices={prices}
        tokenMap={tokenMap}
        pnlBySymbol={pnlBySymbol}
        openOrdersCount={(overview?.open_markers || []).length}
        filledCount={filledTrades.length}
      />
      <div className="dash-grid">
        <div className="dash-col">
          <WalletPanel wallet={wallet} prices={prices} tokenMap={tokenMap} signals={signals}
            pnlBySymbol={pnlBySymbol} lastTradeBySymbol={lastTradeBySymbol} onSelectToken={onSelectToken} />
          <StrategyStatusBoard prices={prices} tokenMap={tokenMap} onOpenStrategy={onOpenStrategy} />
        </div>
        <div className="dash-col">
          <EngineControls />
          <ActivityTables overview={overview} tokenMap={tokenMap} bnbPrice={wallet.bnbPrice}
            onOpenMarkerChart={onOpenMarkerChart} />
        </div>
      </div>
    </div>
  );
}
