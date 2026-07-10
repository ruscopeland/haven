// First-run onboarding checklist on the Dashboard (dismissible).
import { useEffect, useState } from 'react';
import { API_URL } from '../authFetch.js';

const LS_DISMISS = 'havenFirstRunDismissed';

export default function FirstRunChecklist({ wallet, onGoSettings, onGoStrategies }) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(LS_DISMISS) === '1');
  const [billing, setBilling] = useState(null);
  const [engine, setEngine] = useState(null);

  useEffect(() => {
    if (dismissed) return;
    let alive = true;
    const load = async () => {
      try {
        const [b, e] = await Promise.all([
          fetch(`${API_URL}/billing/status`).then(r => r.ok ? r.json() : null),
          fetch(`${API_URL}/engine/settings`).then(r => r.ok ? r.json() : null),
        ]);
        if (!alive) return;
        setBilling(b);
        setEngine(e);
      } catch { /* ignore */ }
    };
    load();
    const iv = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(iv); };
  }, [dismissed]);

  if (dismissed) return null;

  const walletOk = !!(wallet?.address);
  const engineOk = engine != null; // settings reachable
  const engineLive = engine && !engine.paused;
  const botsRunning = (billing?.bots_running || 0) > 0;
  const isTrial = billing?.trial || billing?.plan === 'paper';

  const items = [
    { done: walletOk, label: 'Set wallet address (Dashboard → Token Assets)', action: null },
    { done: engineOk, label: 'Connect desktop engine (Settings → Engine)', action: onGoSettings },
    { done: engineLive, label: engine?.paused ? 'Engine is paused — resume when ready' : 'Engine running (not paused)', action: null },
    { done: botsRunning, label: isTrial ? 'Deploy a paper (DRY) bot' : 'Deploy a paper or live bot', action: onGoStrategies },
  ];

  const allDone = items.every(i => i.done);
  if (allDone) return null;

  return (
    <div className="first-run">
      <h3>Get set up</h3>
      <ul className="first-run-list">
        {items.map((it, i) => (
          <li key={i}>
            <span className={it.done ? 'done' : 'todo'}>{it.done ? '✓' : '○'}</span>
            <span>
              {it.label}
              {!it.done && it.action && (
                <>
                  {' · '}
                  <button type="button" className="app-breadcrumb" style={{ display: 'inline' }}
                    onClick={it.action}>Go</button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      {isTrial && (
        <p className="dash-muted" style={{ fontSize: 11, marginTop: 10 }}>
          You are on a paper trial — LIVE trading unlocks when you subscribe.
        </p>
      )}
      <button type="button" className="first-run-dismiss"
        onClick={() => {
          localStorage.setItem(LS_DISMISS, '1');
          setDismissed(true);
        }}>
        Dismiss checklist
      </button>
    </div>
  );
}
