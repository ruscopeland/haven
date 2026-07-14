// Mid-cap movers — real /public/movers (ranks ~100–200) with logos + sparklines.
import { useEffect, useState } from 'react';
import { API_URL } from '../authFetch.js';
import Sparkline, { TokenLogo } from './Sparkline.jsx';

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtMcap(n) {
  if (!n) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${(n / 1e3).toFixed(0)}K`;
}

export default function LandingMovers() {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`${API_URL}/public/movers?band_start=100&band_end=200&limit=12`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (alive) { setRows(data); setErr(''); }
      } catch (e) {
        if (alive) setErr(e.message || 'Failed to load movers');
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const iv = setInterval(load, 45_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  return (
    <section className="landing-movers">
      <div className="landing-movers-head">
        <h2>Mid-cap movers</h2>
        <p>Live 24h changes among tokens roughly ranked 100–200 by market cap — not mega-caps, not dust.</p>
      </div>
      {loading && <div className="landing-movers-empty">Loading live market data…</div>}
      {!loading && err && (
        <div className="landing-movers-empty">Could not load movers ({err}). Collector or API may be offline.</div>
      )}
      {!loading && !err && !rows.length && (
        <div className="landing-movers-empty">
          No mid-cap movers with quality data right now. Market-cap ranking refreshes periodically from live feeds.
        </div>
      )}
      {!!rows.length && (
        <div className="landing-movers-grid">
          {rows.map(t => {
            const up = (t.price_change_24h || 0) >= 0;
            return (
              <div className="landing-mover-card" key={t.symbol}>
                <div className="landing-mover-top">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <TokenLogo url={t.logo_url} label={t.display} size={22} />
                    <span className="landing-mover-sym">{t.display}</span>
                  </span>
                  {t.alpha_rank != null && <span className="landing-mover-rank">#{t.alpha_rank}</span>}
                </div>
                <div className={`landing-mover-chg ${up ? 'up' : 'down'}`}>{fmtPct(t.price_change_24h)}</div>
                <Sparkline points={t.sparkline} up={up} width={100} height={28} />
                <div className="landing-mover-meta" style={{ marginTop: 8 }}>
                  <span>{fmtMcap(t.market_cap)} mcap</span>
                  {t.chain && <span className="landing-mover-chain">{t.chain}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
