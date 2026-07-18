// Elevated-risk banner: always allow charting; warn clearly before any trade.
// Data from the server-side Binance Alpha security summary.

export default function RiskTradeBanner({ policy, security, contract, chain, symbol }) {
  if (!policy || policy.mode === 'clear') return null;

  const warnings = policy.warnings || [];
  const critical = policy.critical || security?.critical || [];
  const probe = policy.recommend_probe_usd ?? 1;
  const explorer = chain === 'ethereum'
    ? `https://etherscan.io/token/${contract}`
    : chain === 'base'
      ? `https://basescan.org/token/${contract}`
      : contract
        ? `https://bscscan.com/token/${contract}`
        : null;

  return (
    <div className="risk-trade-banner" role="alert">
      <div className="risk-trade-banner-head">
        <span className="risk-trade-banner-tag">ELEVATED RISK</span>
        <span className="risk-trade-banner-title">
          Chart available — trading is not recommended without verification
        </span>
      </div>
      {!!critical.length && (
        <div className="risk-trade-banner-flags">
          {critical.map(c => (
            <span key={c} className="risk-flag crit">{c}</span>
          ))}
        </div>
      )}
      <ul className="risk-trade-banner-list">
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
        <li>
          Recommended first trade size: about <b>${Number(probe).toFixed(0)}</b> only.
          A successful small buy does <b>not</b> mean the next trade is safe — the
          token creator can still blacklist your wallet or block sells on a larger purchase.
        </li>
        <li>
          Manually verify the contract address
          {contract ? (
            <> (<code className="risk-contract">{contract}</code>
              {explorer && (
                <> · <a href={explorer} target="_blank" rel="noopener noreferrer">explorer ↗</a></>
              )}
              )</>
          ) : null}
          {' '}before proceeding. You have been warned.
        </li>
      </ul>
      {symbol && (
        <div className="risk-trade-banner-foot">
          Token: <b>{symbol}</b> · Security data via Binance Alpha when available · Not investment advice
        </div>
      )}
    </div>
  );
}
