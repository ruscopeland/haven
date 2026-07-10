// GoPlus Security panel + attribution (required branding for API users).
// Data comes from tokens.security_json via GET /tokens/{symbol} — real scans only.

const CHAIN_ID = { ethereum: '1', bsc: '56', base: '8453' };

// Official GoPlus org avatar (public GitHub — their docs CDN blocks hotlink 403).
const GOPLUS_LOGO = 'https://avatars.githubusercontent.com/u/89799463?s=64&v=4';
const GOPLUS_HOME = 'https://gopluslabs.io/';

function reportUrl(chain, address) {
  const id = CHAIN_ID[chain] || chain;
  if (!address || !id) return GOPLUS_HOME;
  return `https://gopluslabs.io/token-security/${id}/${address}`;
}

export function GoPlusBadge({ compact = false }) {
  return (
    <a
      className={`goplus-badge${compact ? ' compact' : ''}`}
      href={GOPLUS_HOME}
      target="_blank"
      rel="noopener noreferrer"
      title="Token security data powered by GoPlus Security"
    >
      <img src={GOPLUS_LOGO} alt="GoPlus Security" width={compact ? 16 : 20} height={compact ? 16 : 20}
        onError={(e) => { e.currentTarget.style.display = 'none'; }} />
      <span>{compact ? 'GoPlus' : 'Security by GoPlus'}</span>
    </a>
  );
}

export default function GoPlusSecurity({ security, chain, address, symbol }) {
  if (!security) {
    return (
      <div className="goplus-panel">
        <div className="goplus-panel-head">
          <GoPlusBadge />
          <span className="dash-muted" style={{ fontSize: 11 }}>Not scanned yet</span>
        </div>
        <p className="dash-muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
          Haven scans liquid tokens gradually (daily budget) via GoPlus so free-tier quota is not burned.
          Results appear here after the next scan tick.
        </p>
      </div>
    );
  }

  const safe = security.safe === true;
  const critical = security.critical || [];
  const flags = security.flags || [];
  const buy = security.buy_tax != null ? `${(security.buy_tax * 100).toFixed(1)}%` : '—';
  const sell = security.sell_tax != null ? `${(security.sell_tax * 100).toFixed(1)}%` : '—';
  const scanned = security.scanned_at
    ? new Date(security.scanned_at).toLocaleString()
    : null;
  const href = reportUrl(chain, address);

  return (
    <div className={`goplus-panel${safe ? ' safe' : critical.length ? ' risk' : ''}`}>
      <div className="goplus-panel-head">
        <GoPlusBadge />
        <span className={`goplus-verdict ${safe ? 'ok' : 'bad'}`}>
          {critical.length ? 'Risk detected' : safe ? 'No critical risks' : 'See flags'}
        </span>
      </div>
      <div className="goplus-stats">
        <div><span className="lbl">Buy tax</span><b>{buy}</b></div>
        <div><span className="lbl">Sell tax</span><b>{sell}</b></div>
        <div><span className="lbl">Honeypot</span><b className={security.is_honeypot ? 'dash-red' : 'dash-green'}>
          {security.is_honeypot ? 'YES' : 'No'}
        </b></div>
        <div><span className="lbl">In DEX</span><b>{security.is_in_dex ? 'Yes' : '—'}</b></div>
      </div>
      {!!flags.length && (
        <div className="goplus-flags">
          {flags.slice(0, 12).map(f => (
            <span key={f} className={`goplus-flag${critical.includes(f) || f.startsWith('honeypot') || f.startsWith('sell_tax') || f.startsWith('buy_tax') ? ' crit' : ''}`}>
              {f}
            </span>
          ))}
        </div>
      )}
      <div className="goplus-foot">
        <a href={href} target="_blank" rel="noopener noreferrer">
          Full report on GoPlus{symbol ? ` · ${symbol}` : ''}
        </a>
        {scanned && <span className="dash-muted">Scanned {scanned}</span>}
      </div>
    </div>
  );
}
