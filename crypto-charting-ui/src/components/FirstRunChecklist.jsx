// First-run onboarding checklist on the Dashboard (dismissible).
import { useEffect, useState } from 'react';
import { API_URL } from '../authFetch.js';

const LS_DISMISS = 'havenFirstRunDismissed';

export default function FirstRunChecklist({ wallet, onGoSettings, onGoStrategies }) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(LS_DISMISS) === '1');
  const [billing, setBilling] = useState(null);
  const [engine, setEngine] = useState(null);
  const [engineStatus, setEngineStatus] = useState(null);

  useEffect(() => {
    if (dismissed) return;
    let alive = true;
    const load = async () => {
      try {
        const [b, e, h] = await Promise.all([
          fetch(`${API_URL}/billing/status`).then(r => r.ok ? r.json() : null),
          fetch(`${API_URL}/engine/settings`).then(r => r.ok ? r.json() : null),
          fetch(`${API_URL}/engine/health`).then(r => r.ok ? r.json() : null),
        ]);
        if (!alive) return;
        setBilling(b);
        setEngine(e);
        setEngineStatus(h?.status || null);
      } catch { /* ignore */ }
    };
    load();
    const iv = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(iv); };
  }, [dismissed]);

  if (dismissed) return null;

  const walletOk = !!(wallet?.address);
  const engineConnected = engineStatus === 'ok';
  const engineLive = engineConnected && engine && !engine.paused;
  const botsRunning = (billing?.bots_running || 0) > 0;
  const isTrial = billing?.trial === true;

  const items = [
    { done: botsRunning, label: 'Create and run a paper or live bot', action: onGoStrategies },
    { done: walletOk, label: 'Set wallet address for portfolio display', action: onGoSettings },
    { done: engineConnected, label: 'Download & connect desktop engine (Settings)', action: onGoSettings },
    {
      done: engineLive,
      label: !engineConnected ? 'Start the desktop engine on your computer' :
        engine?.paused ? 'Engine is paused — resume when ready' : 'Engine running (not paused)',
      action: null,
    },
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
          Your seven-day trial includes both paper and live trading. Private keys stay in the desktop engine on your computer.
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
