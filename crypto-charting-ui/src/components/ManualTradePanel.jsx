// Key-free manual BUY/SELL via the marker engine (same path as TokenDetailView).
// Private key never enters the browser — engine executes OpenOcean swaps.
//
// Risk policy: chart always OK. Elevated-risk tokens require:
//   1) manual contract verification checkbox
//   2) "I have been warned" acknowledgment
//   3) recommend small probe first; larger size needs extra ack
import { useEffect, useState } from 'react';
import { fmtUsd, fmtQty, fmtPrice } from '../utils/format';
import { fetchSwapPreview, ENGINE_SLIPPAGE_PCT } from '../utils/quote';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const DEFAULT_PROBE = 1;

export default function ManualTradePanel({
  symbol,
  displayName,
  contract,
  price,
  heldQty,
  stacked = false, // true = buy above sell (narrow column)
}) {
  const [side, setSide] = useState(null);
  const [buyUsd, setBuyUsd] = useState('');
  const [sellUsd, setSellUsd] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [quote, setQuote] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteErr, setQuoteErr] = useState(null);
  const [maxImpact, setMaxImpact] = useState(null);
  const [, setTick] = useState(0);

  // Security / risk ack state
  const [sec, setSec] = useState(null);
  const [policy, setPolicy] = useState(null);
  const [contractVerified, setContractVerified] = useState(false);
  const [riskWarned, setRiskWarned] = useState(false);
  const [largeAck, setLargeAck] = useState(false);

  const buyNum = parseFloat(buyUsd);
  const sellNum = parseFloat(sellUsd);
  const heldUsd = heldQty != null && price ? heldQty * price : null;
  const tradeable = !!contract;
  const confirmUsd = side === 'BUY' ? buyNum : sellNum;
  const elevated = policy?.mode === 'elevated_risk';
  const probeUsd = policy?.recommend_probe_usd ?? DEFAULT_PROBE;
  const needsLargeAck = elevated && confirmUsd > probeUsd;

  useEffect(() => {
    if (!quote) return undefined;
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, [quote]);

  // Reset trade state when symbol changes; load security policy
  useEffect(() => {
    setSide(null); setQuote(null); setQuoteErr(null); setBuyUsd(''); setSellUsd(''); setMsg(null);
    setContractVerified(false); setRiskWarned(false); setLargeAck(false);
    setSec(null); setPolicy(null);
    if (!symbol) return undefined;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/security/check/${encodeURIComponent(symbol)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: false }),
        });
        const data = res.ok ? await res.json() : null;
        if (!alive || !data) return;
        setSec(data);
        setPolicy(data.trade_policy || null);
      } catch { /* panel still usable; send() rechecks */ }
    })();
    return () => { alive = false; };
  }, [symbol]);

  const closeConfirm = () => { setSide(null); setQuote(null); setQuoteErr(null); setQuoting(false); };

  const getQuote = async (dir, usdNum) => {
    setQuoting(true); setQuote(null); setQuoteErr(null); setMsg(null);
    try {
      const s = await (await fetch(`${API_URL}/engine/settings`)).json();
      if (s.paused) {
        setQuoteErr({ text: 'Engine is PAUSED — resume it from the top toolbar first.', fatal: true });
        setQuoting(false); return;
      }
      setMaxImpact(s.max_price_impact_pct);
      const q = await fetchSwapPreview({ side: dir, usd: usdNum, contract, marketPrice: price, heldQty });
      setQuote(q);
    } catch (e) {
      setQuoteErr({ text: `Quote preview unavailable: ${e.message || e}`, fatal: false });
    }
    setQuoting(false);
  };

  const startConfirm = (dir) => {
    setSide(dir);
    getQuote(dir, dir === 'BUY' ? buyNum : sellNum);
  };

  const riskGateOk = () => {
    if (!elevated) return true;
    if (!contractVerified || !riskWarned) return false;
    if (needsLargeAck && !largeAck) return false;
    return true;
  };

  const send = async (dir, usdNum) => {
    setBusy(true); setMsg(null);
    try {
      // Refresh the CMC security gate — chart stays open when risk is elevated.
      const secRes = await fetch(`${API_URL}/security/check/${encodeURIComponent(symbol)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: false }),
      });
      const secNow = secRes.ok ? await secRes.json() : null;
      if (secNow?.trade_policy) setPolicy(secNow.trade_policy);
      if (secNow) setSec(secNow);

      const pol = secNow?.trade_policy;
      const isElevated = pol?.mode === 'elevated_risk'
        || secNow?.blocked
        || (secNow?.critical && secNow.critical.length)
        || secNow?.safe !== true;

      if (isElevated) {
        if (!contractVerified || !riskWarned) {
          setMsg({
            kind: 'err',
            text: 'Elevated risk — verify the contract address and acknowledge the warnings before trading.',
          });
          setBusy(false); return;
        }
        const probe = pol?.recommend_probe_usd ?? DEFAULT_PROBE;
        if (usdNum > probe && !largeAck) {
          setMsg({
            kind: 'err',
            text: `Size above recommended probe ($${probe}). Start small, or confirm the larger-size warning.`,
          });
          setBusy(false); return;
        }
      } else if (!secRes.ok || !secNow || secNow.safe !== true) {
        // Incomplete / hard infrastructure failure — still refuse without clear safe
        const why = (secNow?.critical || secNow?.flags || [secNow?.message || `HTTP ${secRes.status}`]).join(', ');
        setMsg({
          kind: 'err',
          text: `Security check incomplete for ${displayName}: ${why}.`,
        });
        closeConfirm(); setBusy(false); return;
      }

      const s = await (await fetch(`${API_URL}/engine/settings`)).json();
      if (s.paused) {
        setMsg({ kind: 'err', text: 'Engine is PAUSED — resume it first.' });
        closeConfirm(); setBusy(false); return;
      }

      const metadata = {
        usd: usdNum,
        tag: 'manual',
      };
      if (isElevated) {
        metadata.risk_ack = true;
        metadata.contract_verified = true;
        metadata.risk_warned = true;
        if (usdNum > (pol?.recommend_probe_usd ?? DEFAULT_PROBE)) {
          metadata.risk_ack_large = true;
        }
      }

      const r = await fetch(`${API_URL}/markers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          price: price || 0,
          marker_type: dir === 'BUY' ? 'STRAT_BUY' : 'STRAT_SELL',
          direction: 'cross',
          label: `Manual ${dir} $${usdNum}`,
          metadata_json: JSON.stringify(metadata),
        }),
      });
      if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
      setMsg({
        kind: 'ok',
        text: `${dir} $${usdNum} of ${displayName} sent to the engine.`
          + (isElevated
            ? ' Risk override logged — fills are not guaranteed; creator may still block sells.'
            : ' Fill appears in history when executed.'),
      });
      if (dir === 'BUY') setBuyUsd(''); else setSellUsd('');
      closeConfirm();
    } catch (e) {
      setMsg({ kind: 'err', text: `Order failed: ${e.message || e}` });
      closeConfirm();
    }
    setBusy(false);
  };

  const applyProbe = () => {
    setBuyUsd(String(probeUsd));
    setLargeAck(false);
    closeConfirm();
    setMsg(null);
  };

  return (
    <div className={`manual-trade${stacked ? ' stacked' : ''}`}>
      <h3 style={{ margin: '0 0 6px', fontSize: 15 }}>Trade {displayName}</h3>
      <p className="qt-note" style={{ marginTop: 0, marginBottom: 12 }}>
        Engine → OpenOcean on BSC. Key stays on your machine. Impact / size / daily guards apply.
        Unexecuted orders cancel after 120s if the engine is offline.
        Not financial advice — you authorize every size and token.
      </p>

      {elevated && (
        <div className="manual-risk-box">
          <b>Elevated risk — chart OK, trade only if you insist</b>
          <ul>
            {(policy?.warnings || []).slice(0, 4).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
            <li>
              Start with a small probe (~${Number(probeUsd).toFixed(0)}). The creator can still
              blacklist your wallet on the next try or a larger purchase.
            </li>
            <li>
              Manually verify contract{' '}
              <code style={{ fontSize: 11 }}>{contract}</code>
              {' '}before proceeding. You have been warned.
            </li>
          </ul>
          <button type="button" className="btn-secondary" style={{ fontSize: 12, marginBottom: 8 }}
            onClick={applyProbe}>
            Use recommended probe ${Number(probeUsd).toFixed(0)}
          </button>
          <label className="manual-risk-check">
            <input
              type="checkbox"
              checked={contractVerified}
              onChange={e => setContractVerified(e.target.checked)}
            />
            I manually verified this contract address on the explorer
          </label>
          <label className="manual-risk-check">
            <input
              type="checkbox"
              checked={riskWarned}
              onChange={e => setRiskWarned(e.target.checked)}
            />
            I understand the risks and have been warned (honeypot / tax / blacklist possible)
          </label>
          {needsLargeAck && (
            <label className="manual-risk-check warn">
              <input
                type="checkbox"
                checked={largeAck}
                onChange={e => setLargeAck(e.target.checked)}
              />
              Size is above ~${Number(probeUsd).toFixed(0)} — I accept extra risk of creator
              blacklist or failed sells on this larger amount
            </label>
          )}
        </div>
      )}

      <div className="trade-line" style={{ maxWidth: '100%' }}>
        <span className="l">Market (CoinMarketCap)</span>
        <span className="v">{price ? `$${fmtPrice(price)}` : '…'}</span>
      </div>
      <div className="trade-line" style={{ maxWidth: '100%' }}>
        <span className="l">You hold</span>
        <span className="v">{heldQty != null ? `${fmtQty(heldQty)} (${heldUsd != null ? fmtUsd(heldUsd) : '—'})` : '—'}</span>
      </div>

      {!tradeable ? (
        <div className="dash-error">No contract on file — cannot swap this symbol.</div>
      ) : (
        <div className={`trade-cards${stacked ? ' stacked' : ''}`}>
          <div className="trade-box">
            <div className="head"><span>BUY</span><span className="badge badge-gain">engine</span></div>
            <div className="qt-row">
              <input type="number" min="1" step="1" placeholder="USD amount" value={buyUsd}
                onChange={e => { setBuyUsd(e.target.value); closeConfirm(); setMsg(null); setLargeAck(false); }} />
            </div>
            <button className="trade-send buy"
              disabled={!(buyNum > 0) || !price || busy || quoting || (elevated && !riskGateOk())}
              onClick={() => startConfirm('BUY')}>
              {quoting && side === 'BUY' ? 'Quoting…' : `Quote buy ${buyNum > 0 ? `$${buyNum}` : ''}`}
            </button>
          </div>
          <div className="trade-box">
            <div className="head"><span>SELL</span><span className="badge badge-loss">engine</span></div>
            <div className="qt-row">
              <input type="number" min="1" step="1" placeholder="USD amount" value={sellUsd}
                onChange={e => { setSellUsd(e.target.value); closeConfirm(); setMsg(null); setLargeAck(false); }} />
              {heldUsd != null && heldUsd > 0 && (
                <button className="btn-secondary" style={{ padding: '6px 12px', fontSize: 12 }}
                  onClick={() => { setSellUsd(String(Math.floor(heldUsd * 100) / 100)); closeConfirm(); }}>Max</button>
              )}
            </div>
            <button className="trade-send sell"
              disabled={!(sellNum > 0) || !price || busy || quoting || (elevated && !riskGateOk())}
              onClick={() => startConfirm('SELL')}>
              {quoting && side === 'SELL' ? 'Quoting…' : `Quote sell ${sellNum > 0 ? `$${sellNum}` : ''}`}
            </button>
          </div>
        </div>
      )}

      {elevated && !riskGateOk() && tradeable && (
        <div className="dash-muted" style={{ marginTop: 8, fontSize: 12 }}>
          Check the verification / warning boxes above to enable quoting on this risky token.
          {sec?.critical?.length ? ` Flags: ${sec.critical.join(', ')}` : ''}
        </div>
      )}

      {side && (
        <div className="qt-confirm">
          <b>Preview — {side} ${confirmUsd} {displayName}</b>
          {elevated && (
            <div className="dash-error" style={{ marginTop: 8, fontSize: 12 }}>
              Risk override will be recorded. Probe size ~${Number(probeUsd).toFixed(0)} is recommended.
            </div>
          )}
          {quoting && <div className="dash-muted" style={{ marginTop: 8 }}>Fetching OpenOcean quote…</div>}
          {quoteErr && !quoting && (
            <div style={{ marginTop: 8 }}>
              <div className="dash-error">{quoteErr.text}</div>
              <div className="btns">
                {!quoteErr.fatal && (
                  <>
                    <button style={{ background: 'rgba(255,255,255,0.08)', color: '#fff' }}
                      onClick={() => getQuote(side, confirmUsd)}>Retry</button>
                    <button style={{ background: side === 'BUY' ? 'var(--success-gradient)' : 'var(--danger-gradient)', color: '#fff' }}
                      disabled={busy || (elevated && !riskGateOk())}
                      onClick={() => send(side, confirmUsd)}>{busy ? '…' : `${side} without preview`}</button>
                  </>
                )}
                <button style={{ background: 'rgba(255,255,255,0.08)', color: '#fff' }} onClick={closeConfirm}>Cancel</button>
              </div>
            </div>
          )}
          {quote && !quoting && (() => {
            const rejected = maxImpact != null && quote.impactPct > maxImpact;
            const age = Math.max(0, Math.round((Date.now() - quote.fetchedAt) / 1000));
            const impactColor = rejected ? 'var(--danger)' : quote.impactPct > 1 ? '#fbbf24' : '#34d399';
            return (
              <div style={{ marginTop: 8 }}>
                {quote.route?.length > 0 && (
                  <div className="trade-line"><span className="l">Route</span><span className="v">{quote.route.join(' + ')}</span></div>
                )}
                {side === 'BUY' ? (
                  <>
                    <div className="trade-line"><span className="l">You pay</span>
                      <span className="v">{fmtUsd(quote.usdNotional)} ({fmtQty(quote.amountIn)} BNB)</span></div>
                    <div className="trade-line"><span className="l">You receive</span>
                      <span className="v">≈ {fmtQty(quote.quotedOut)} {displayName}</span></div>
                  </>
                ) : (
                  <>
                    <div className="trade-line"><span className="l">You sell</span>
                      <span className="v">{fmtQty(quote.amountIn)} {displayName}{quote.capped ? ' (capped)' : ''}</span></div>
                    <div className="trade-line"><span className="l">You receive</span>
                      <span className="v">≈ {fmtQty(quote.quotedOut)} BNB ({fmtUsd(quote.quotedOut * quote.bnbPrice)})</span></div>
                  </>
                )}
                <div className="trade-line"><span className="l">Eff. price</span>
                  <span className="v">${fmtPrice(quote.effPrice)}</span></div>
                <div className="trade-line"><span className="l">Impact</span>
                  <span className="v" style={{ color: impactColor }}>
                    {quote.impactPct >= 0 ? '+' : ''}{quote.impactPct.toFixed(2)}%
                    {maxImpact != null ? ` / limit ${maxImpact}%` : ''}
                  </span></div>
                <div className="trade-line"><span className="l">Min received ({ENGINE_SLIPPAGE_PCT}% slip)</span>
                  <span className="v">{fmtQty(quote.minOut)} {side === 'BUY' ? displayName : 'BNB'}</span></div>
                <div className="qt-note">Quote age {age}s · engine re-quotes at execution</div>
                {rejected && (
                  <div className="dash-error" style={{ marginTop: 6 }}>
                    Engine would reject this size (impact above limit). Reduce amount or raise limit in Settings.
                  </div>
                )}
                <div className="btns">
                  <button style={{ background: side === 'BUY' ? 'var(--success-gradient)' : 'var(--danger-gradient)', color: '#fff' }}
                    disabled={busy || rejected || (elevated && !riskGateOk())}
                    onClick={() => send(side, confirmUsd)}>
                    {busy ? 'Sending…' : elevated ? `Confirm ${side} (risk accepted)` : `Confirm ${side}`}
                  </button>
                  <button style={{ background: 'rgba(255,255,255,0.08)', color: '#fff' }} onClick={closeConfirm}>Cancel</button>
                </div>
              </div>
            );
          })()}
        </div>
      )}
      {msg && <div className={msg.kind === 'ok' ? 'dash-green' : 'dash-error'} style={{ marginTop: 10, fontSize: 12 }}>{msg.text}</div>}
    </div>
  );
}
