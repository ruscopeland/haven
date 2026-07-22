import { useState, useEffect, useMemo } from 'react';
import StrategyStatusBoard from './StrategyStatusBoard';
import ActivityTables from './ActivityTables';
import WalletPanel from './WalletPanel';
import PortfolioSummary from './PortfolioSummary';
import AssetAllocation from './AssetAllocation';
import AttentionStrip from './AttentionStrip';
import { computePnl } from '../utils/pnl';
import '../dashboard.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// Home tab. Owns the polls shared by every panel (overview 5s, token
// metadata 5min, filled trades 30s for PnL) so child panels don't
// duplicate traffic. Wallet balances come from the key-free C2 hook.
export default function DashboardView({
  wallet,
  signals, onOpenStrategy, onOpenStrategyEditor, onOpenMarkerChart, onSelectToken,
  onGoSettings, onGoStrategies, onGoWallet,
}) {
  const [overview, setOverview] = useState(null);
  const [tokenMap, setTokenMap] = useState({});
  const [filledTrades, setFilledTrades] = useState([]);
  const [strats, setStrats] = useState([]);

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
    const loadStrats = async () => {
      try {
        const r = await fetch(`${API_URL}/strategies`);
        if (r.ok && alive) setStrats(await r.json());
      } catch { /* attention strip degrades */ }
    };
    loadOverview(); loadTokens(); loadFilled(); loadStrats();
    const a = setInterval(loadOverview, 5_000);
    const b = setInterval(loadTokens, 300_000);
    const c = setInterval(loadFilled, 30_000);
    const d = setInterval(loadStrats, 10_000);
    return () => { alive = false; clearInterval(a); clearInterval(b); clearInterval(c); clearInterval(d); };
  }, []);

  const prices = { ...(overview?.token_prices || {}), ...(wallet.tokenPrices || {}) };
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
      <AttentionStrip wallet={wallet} strategies={strats} />
      <div className="dash-grid">
        <div className="dash-col">
          <PortfolioSummary
            wallet={wallet}
            prices={prices}
            tokenMap={tokenMap}
            pnlBySymbol={pnlBySymbol}
            openOrdersCount={(overview?.open_markers || []).length}
            filledCount={filledTrades.length}
          />
          <StrategyStatusBoard prices={prices} tokenMap={tokenMap} onOpenStrategy={onOpenStrategy}
            onOpenEditor={onOpenStrategyEditor} />
          <WalletPanel wallet={wallet} prices={prices} tokenMap={tokenMap} signals={signals}
            pnlBySymbol={pnlBySymbol} lastTradeBySymbol={lastTradeBySymbol} onSelectToken={onSelectToken} onGoWallet={onGoWallet} />
        </div>
        <div className="dash-col">
          <AssetAllocation wallet={wallet} prices={prices} tokenMap={tokenMap} pnlBySymbol={pnlBySymbol} />
          <ActivityTables overview={overview} tokenMap={tokenMap} bnbPrice={wallet.bnbPrice}
            onOpenMarkerChart={onOpenMarkerChart} />
        </div>
      </div>
    </div>
  );
}
