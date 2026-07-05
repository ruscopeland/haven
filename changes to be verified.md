# Changes to be Verified

> ⚠️ **Only Fable 5 may verify changes in this file.** Do not check a verification box
> yourself — leave it unchecked until Fable 5 has reviewed and confirmed the change, then
> Fable 5 will tick the box.

> 📝 **How to add an entry:** Add a new `##` section **above** older entries (newest first).
> The header must be the change's title followed by `&nbsp; [ ] Verified by Fable 5`
> (unchecked). Under it, add a **Description** paragraph explaining what the change does and
> why. Then add one `###` subsection per changed file, named with its path, containing a
> ` ```diff ` code block with the actual added/removed lines (not a prose summary). Do not
> check the verification box yourself, and do not add a "verification performed" note —
> only Fable 5 records verification.

---

## Clicking a strategy card on the Dashboard opens it in the Strategies tab &nbsp; [ ] Verified by Fable 5

**Description:** Previously, the "Strategies" panel on the Dashboard tab only showed a
read-only status card per strategy (name, mode, PnL, positions). There was no way to jump
from a card to that strategy's full editor/backtest view — you had to switch to the
Strategies tab and manually find it in the dropdown list. Now clicking a strategy card on
the Dashboard navigates to the Strategies tab with that exact strategy already loaded.

### `crypto-charting-ui/src/App.jsx`

```diff
   const [selectedTokens, setSelectedTokens] = useState([]);
   const [activePreset, setActivePreset] = useState(null);
   const [view, setView] = useState('dashboard');   // 'dashboard' | 'charts' | 'strategies' | 'finder'
+  const [selectedStrategyId, setSelectedStrategyId] = useState(null);
   const [signals, setSignals] = useState([]);
   const [sortBy, setSortBy] = useState("flow_15m");
   const [health, setHealth] = useState({ collector: 'unknown', execution_engine: 'unknown' });
@@
         {view === 'dashboard' ? (
-          <DashboardView />
+          <DashboardView onOpenStrategy={(id) => { setSelectedStrategyId(id); setView('strategies'); }} />
         ) : view === 'settings' ? (
           <SettingsView />
         ) : view === 'strategies' ? (
-          <StrategyWorkbench signals={signals} />
+          <StrategyWorkbench signals={signals} initialSelectId={selectedStrategyId} />
         ) : view === 'finder' ? (
           <FinderWorkbench />
         ) : (
```

### `crypto-charting-ui/src/components/DashboardView.jsx`

```diff
 // Home tab. Owns the two polls shared by every panel (overview 5s, token
 // metadata 5min) so child panels don't duplicate traffic.
-export default function DashboardView() {
+export default function DashboardView({ onOpenStrategy }) {
   const [overview, setOverview] = useState(null);
   const [tokenMap, setTokenMap] = useState({});
@@
   return (
     <div className="dash-root">
       <div className="dash-col">
-        <StrategyStatusBoard prices={prices} tokenMap={tokenMap} />
+        <StrategyStatusBoard prices={prices} tokenMap={tokenMap} onOpenStrategy={onOpenStrategy} />
         <ActivityTables overview={overview} tokenMap={tokenMap} />
       </div>
       <div className="dash-col">
```

### `crypto-charting-ui/src/components/StrategyStatusBoard.jsx`

```diff
-function StrategyCard({ strat, trades, prices, finderName, tokenMap }) {
+function StrategyCard({ strat, trades, prices, finderName, tokenMap, onOpenStrategy }) {
   const off = strat.mode === 'off';
   const stats = off ? null : computeStats(trades || [], prices);
   const source = strat.finder_id
@@
     : tokenLabel(strat.symbol, tokenMap);
 
   return (
-    <div className={`strat-card${off ? ' off' : ''}`}>
+    <div
+      className={`strat-card${off ? ' off' : ''}`}
+      onClick={() => onOpenStrategy?.(strat.id)}
+      style={{ cursor: onOpenStrategy ? 'pointer' : undefined }}
+      title="Open in Strategies tab"
+    >
       <div className="strat-head">
         <span className="fresh-dot" style={{ background: off ? '#2a2f42' : freshColor(strat) }}
           title={off ? 'off' : `last run ${timeAgo(strat.last_run_at)}`} />
@@
 // trade rows (PAPER for dry, FILLED for live). Prices/tokenMap come from the
 // DashboardView's shared overview poll so this component adds no extra
 // overview traffic.
-export default function StrategyStatusBoard({ prices, tokenMap }) {
+export default function StrategyStatusBoard({ prices, tokenMap, onOpenStrategy }) {
   const [strats, setStrats] = useState([]);
   const [finders, setFinders] = useState([]);
   const [tradeMap, setTradeMap] = useState({});
@@
       {[...running, ...idle].map(s => (
         <StrategyCard key={s.id} strat={s} trades={tradeMap[s.id]} prices={prices}
-          finderName={finderNames[s.finder_id]} tokenMap={tokenMap} />
+          finderName={finderNames[s.finder_id]} tokenMap={tokenMap} onOpenStrategy={onOpenStrategy} />
       ))}
     </div>
   );
```

### `crypto-charting-ui/src/components/StrategyWorkbench.jsx`

```diff
-export default function StrategyWorkbench({ signals = [] }) {
+export default function StrategyWorkbench({ signals = [], initialSelectId = null }) {
   const [list, setList] = useState([]);
   const [draft, setDraft] = useState(() => {
     try {
@@
     } catch (err) { console.error('Failed to load strategy', err); }
   };
 
+  // Deep-link from the Dashboard's strategy cards: open a specific strategy
+  // once its row is available in the polled list. Applied once per id so the
+  // 10s list poll doesn't keep re-selecting over the user's own navigation.
+  const appliedSelectId = useRef(null);
+  useEffect(() => {
+    if (initialSelectId == null || initialSelectId === appliedSelectId.current) return;
+    if (!list.some(s => s.id === initialSelectId)) return;
+    appliedSelectId.current = initialSelectId;
+    selectStrategy(initialSelectId);
+  }, [initialSelectId, list]);
+
   const saveDraft = async () => {
     const body = {
       name: draft.name,
```
