const CMC_HOME = 'https://coinmarketcap.com/';

export function CmcBadge({ compact = false }) {
  return (
    <a
      className={`goplus-badge${compact ? ' compact' : ''}`}
      href={CMC_HOME}
      target="_blank"
      rel="noopener noreferrer"
      title="Market and token security data powered by CoinMarketCap"
    >
      <span aria-hidden="true">CMC</span>
      <span>{compact ? 'CoinMarketCap' : 'Security by CoinMarketCap'}</span>
    </a>
  );
}

export default function CmcSecurity({ security, symbol }) {
  if (!security) {
    return (
      <div className="goplus-panel">
        <div className="goplus-panel-head">
          <CmcBadge />
          <span className="dash-muted" style={{ fontSize: 11 }}>Checked before trading</span>
        </div>
        <p className="dash-muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
          Haven retrieves CoinMarketCap DEX security information on demand and caches it.
          Charting remains available when a check is incomplete.
        </p>
      </div>
    );
  }

  const safe = security.safe === true;
  const critical = security.critical || [];
  const flags = security.flags || [];
  const scanned = security.scanned_at ? new Date(security.scanned_at).toLocaleString() : null;

  return (
    <div className={`goplus-panel${safe ? ' safe' : critical.length ? ' risk' : ''}`}>
      <div className="goplus-panel-head">
        <CmcBadge />
        <span className={`goplus-verdict ${safe ? 'ok' : 'bad'}`}>
          {critical.length ? 'Risk detected — charting remains available' : safe ? 'No critical risks reported' : 'Incomplete check'}
        </span>
      </div>
      <div className="goplus-stats">
        <div><span className="lbl">Buy tax</span><b>{security.buy_tax ?? '—'}</b></div>
        <div><span className="lbl">Sell tax</span><b>{security.sell_tax ?? '—'}</b></div>
        <div><span className="lbl">Verified</span><b>{security.verified === true ? 'Yes' : security.verified === false ? 'No' : '—'}</b></div>
        <div><span className="lbl">Level</span><b>{security.security_level || '—'}</b></div>
      </div>
      {!!(critical.length || flags.length) && (
        <div className="goplus-flags">
          {[...new Set([...critical, ...flags])].slice(0, 12).map(flag => (
            <span key={flag} className={`goplus-flag${critical.includes(flag) ? ' crit' : ''}`}>{flag}</span>
          ))}
        </div>
      )}
      <div className="goplus-foot">
        <a href={CMC_HOME} target="_blank" rel="noopener noreferrer">
          CoinMarketCap methodology{symbol ? ` · ${symbol}` : ''}
        </a>
        {scanned && <span className="dash-muted">Checked {scanned}</span>}
      </div>
    </div>
  );
}
