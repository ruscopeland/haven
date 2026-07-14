const ALPHA_HOME = 'https://www.binance.com/en/alpha';

export function AlphaBadge({ compact = false }) {
  return <a className={`goplus-badge${compact ? ' compact' : ''}`} href={ALPHA_HOME} target="_blank" rel="noopener noreferrer" title="Binance Alpha market data">
    <span aria-hidden="true">α</span><span>{compact ? 'Binance Alpha' : 'Binance Alpha market data'}</span>
  </a>;
}

export default function AlphaRisk({ security, symbol }) {
  const critical = security?.critical || [];
  const listed = security?.safe === true && security?.verified === true;
  return <div className={`goplus-panel${listed ? '' : ' risk'}`}>
    <div className="goplus-panel-head"><AlphaBadge /><span className={`goplus-verdict ${listed ? 'good' : 'bad'}`}>{listed ? 'Listed and tradeable' : 'Unavailable for trading'}</span></div>
    <p className="dash-muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
      {listed
        ? 'This contract and market are listed in the current Binance Alpha BSC catalogue. Engine price-impact, size, daily-cap, and pause controls still apply.'
        : 'This token is not a verified current Binance Alpha BSC catalogue entry, so trading is unavailable.'}
    </p>
    {critical.length > 0 && <div className="goplus-flags">{critical.map(flag => <span key={flag} className="goplus-flag crit">{flag}</span>)}</div>}
    <div className="goplus-foot"><a href={ALPHA_HOME} target="_blank" rel="noopener noreferrer">Binance Alpha{symbol ? ` · ${symbol}` : ''}</a></div>
  </div>;
}
