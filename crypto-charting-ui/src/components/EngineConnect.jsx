// Settings → Connect your engine. Generates a one-time connection key the user
// pastes into the downloaded desktop engine, lists/revokes existing keys, and
// downloads the engine zip (fetched with the auth interceptor, then saved).
import { useEffect, useState } from 'react';
import { API_URL } from '../authFetch.js';

export default function EngineConnect() {
  const [keys, setKeys] = useState([]);
  const [fresh, setFresh] = useState(null);     // {api_key} shown once, right after creation
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () => fetch(`${API_URL}/engine/keys`).then(r => r.json())
    .then(d => setKeys(Array.isArray(d) ? d : [])).catch(() => {});
  useEffect(() => { load(); }, []);

  const generate = async () => {
    setBusy(true); setErr(''); setFresh(null);
    try {
      const r = await fetch(`${API_URL}/engine/keys`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'My engine' }),
      });
      if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
      setFresh(await r.json());
      load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const revoke = async (id) => {
    await fetch(`${API_URL}/engine/keys/${id}`, { method: 'DELETE' }).catch(() => {});
    load();
  };

  const downloadEngine = async () => {
    setErr('');
    try {
      const r = await fetch(`${API_URL}/engine/download`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'haven-engine.zip'; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setErr(`Download failed: ${e.message}`); }
  };

  return (
    <div className="settings-root" style={{ marginBottom: 24 }}>
      <h2 style={{ color: '#e5e9f0', marginTop: 0 }}>🖥️ Connect your engine</h2>
      <p className="dash-muted" style={{ fontSize: 12, marginBottom: 16 }}>
        Live trading runs from a small app on your own computer, so your wallet key
        never leaves your machine. Download it, generate a connection key, and paste
        the key into the app's setup.
      </p>

      <ol className="engine-steps">
        <li>
          <button className="settings-save" onClick={downloadEngine}>⬇ Download the engine (.zip)</button>
        </li>
        <li>
          <button className="settings-save" disabled={busy} onClick={generate}>
            {busy ? 'Generating…' : '🔑 Generate a connection key'}
          </button>
        </li>
      </ol>

      {fresh && (
        <div className="key-reveal">
          <div className="dash-muted" style={{ fontSize: 11, marginBottom: 4 }}>
            Copy this now — it is shown only once:
          </div>
          <code className="key-value">{fresh.api_key}</code>
          <button className="btn-ghost" onClick={() => navigator.clipboard?.writeText(fresh.api_key)}>Copy</button>
        </div>
      )}

      {keys.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="dash-muted" style={{ fontSize: 11, marginBottom: 6 }}>Active keys</div>
          {keys.map(k => (
            <div key={k.id} className="key-row">
              <span>{k.label}</span>
              <span className="dash-muted" style={{ fontSize: 11 }}>
                {k.last_used_at ? `last used ${new Date(k.last_used_at).toLocaleString()}` : 'never used'}
              </span>
              <button className="btn-ghost" onClick={() => revoke(k.id)}>Revoke</button>
            </div>
          ))}
        </div>
      )}
      {err && <div className="dash-error" style={{ marginTop: 10, fontSize: 12 }}>{err}</div>}
    </div>
  );
}
