// Dashboard "needs attention" strip — engine paused, bot errors, missing wallet.
import { useEffect, useState } from 'react';
import { API_URL } from '../authFetch.js';

export default function AttentionStrip({ wallet, strategies = [] }) {
  const [engine, setEngine] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`${API_URL}/engine/settings`);
        if (r.ok && alive) setEngine(await r.json());
      } catch { /* ignore */ }
    };
    load();
    const iv = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const chips = [];
  if (!wallet?.address) {
    chips.push({ kind: 'warn', text: 'No wallet address set' });
  }
  if (engine?.paused) {
    chips.push({ kind: 'danger', text: 'Engine paused — markers will not execute' });
  }
  for (const s of strategies) {
    if (s.last_error && s.mode !== 'off') {
      chips.push({
        kind: 'danger',
        text: `${s.name}: ${String(s.last_error).slice(0, 80)}`,
      });
    }
  }

  if (!chips.length) return null;
  const danger = chips.some(c => c.kind === 'danger');

  return (
    <div className={`attention-strip${danger ? ' danger' : ''}`}>
      <strong style={{ marginRight: 4 }}>Needs attention</strong>
      {chips.map((c, i) => (
        <span className="attention-chip" key={i} title={c.text}>{c.text}</span>
      ))}
    </div>
  );
}
