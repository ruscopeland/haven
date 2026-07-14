const ALPHA_HOME = 'https://www.binance.com/en/alpha';

export function AlphaBadge({ compact = false }) {
  return <a className={`goplus-badge${compact ? ' compact' : ''}`} href={ALPHA_HOME} target="_blank" rel="noopener noreferrer" title="Binance Alpha market data">
    <span aria-hidden="true">α</span><span>{compact ? 'Binance Alpha' : 'Binance Alpha market data'}</span>
  </a>;
}

export default function AlphaRisk({ security, symbol }) {
  const critical = security?.critical || ['security_audit_unavailable'];
  return <div className="goplus-panel risk">
    <div className="goplus-panel-head"><AlphaBadge /><span className="goplus-verdict bad">Manual-risk review required</span></div>
    <p className="dash-muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
      Binance Alpha confirms the listed contract and market data, but does not provide a contract-security audit. Charts remain available; automated trades stay blocked and manual trades require verification and acknowledgement.
    </p>
    <div className="goplus-flags">{critical.map(flag => <span key={flag} className="goplus-flag crit">{flag}</span>)}</div>
    <div className="goplus-foot"><a href={ALPHA_HOME} target="_blank" rel="noopener noreferrer">Binance Alpha{symbol ? ` · ${symbol}` : ''}</a></div>
  </div>;
}
