import { useState, useEffect } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// Compact engine pause/live toggle for the top toolbar, next to the health
// dots (visible on every tab, not just the Dashboard). Same /engine/settings
// key the old wallet app PATCHes, so both stay in sync within one poll cycle.
// Risk-limit caps live only in ⚙ Settings now — this is just the switch.
export default function EngineToggle() {
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadSettings = async () => {
    try {
      const r = await fetch(`${API_URL}/engine/settings`);
      if (r.ok) setSettings(await r.json());
    } catch { /* keep last known state; next poll retries */ }
  };

  useEffect(() => {
    loadSettings();
    const iv = setInterval(loadSettings, 10_000);
    return () => clearInterval(iv);
  }, []);

  const togglePause = async () => {
    if (!settings || busy) return;
    // Resuming can fire armed markers — confirm when leaving paused state.
    if (settings.paused) {
      const ok = window.confirm(
        'Resume the engine? Armed markers and live strategies will execute when their rules fire.');
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await fetch(`${API_URL}/engine/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: settings.paused ? 0 : 1 }),
      });
      if (r.ok) await loadSettings();
    } catch { /* button stays in last-known state on failure */ }
    setBusy(false);
  };

  const paused = !!settings?.paused;
  return (
    <button
      onClick={togglePause}
      disabled={!settings || busy}
      title={settings == null ? 'Loading engine state…'
        : paused ? 'Engine is PAUSED — markers will not execute. Click to resume.'
        : 'Engine is running — markers execute on cross. Click to pause all trading.'}
      style={{
        padding: '5px 14px', borderRadius: 9999, border: 'none', cursor: settings ? 'pointer' : 'default',
        fontWeight: 700, fontSize: 11, fontFamily: 'var(--font-display)', letterSpacing: '0.03em',
        opacity: settings == null ? 0.5 : 1,
        background: settings == null ? 'rgba(255,255,255,0.08)' : paused ? 'var(--danger-gradient)' : 'var(--success-gradient)',
        color: settings == null ? 'var(--text-muted)' : paused ? '#fff' : '#04120c',
      }}
    >
      {settings == null ? '… ENGINE' : paused ? '⏸ PAUSED' : '● LIVE'}
    </button>
  );
}
