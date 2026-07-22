// Manual BUY/SELL via CoW Protocol intent-based batch auctions.
import { useEffect, useState } from 'react';
import { fmtUsd, fmtQty, fmtPrice } from '../utils/format';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const SLIPPAGE = 0.5;

export default function ManualTradePanel({
  symbol, displayName, contract, price, heldQty, decimals,
  stacked = false, skipRiskReview = false,
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

  const buyNum = parseFloat(buyUsd);
  const sellNum = parseFloat(sellUsd);
  const heldUsd = heldQty != null && price ? heldQty * price : null;
  const tradeable = !!contract;
  const confirmUsd = side === 'BUY' ? buyNum : sellNum;

  useEffect(() => {
    if (!quote) return undefined;
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, [quote]);

  useEffect(() => {
    setSide(null); setQuote(null); setQuoteErr(null); setBuyUsd(''); setSellUsd(''); setMsg(null);
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
      const cowurl = 'https://api.cow.fi/bnb/api/v1/quote';
      const nat = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
      const ib = dir === 'BUY';
      const amt = ib ? usdNum / 580 : Math.min(usdNum / price, heldQty || Infinity);
      const body = JSON.stringify({kind: ib ? 'buy' : 'sell', sellToken: ib ? nat : contract, buyToken: ib ? contract : nat, sellAmountBeforeFee: BigInt(Math.floor(amt * 1e18)).toString(), from: '0x0000000000000000000000000000000000000000', receiver: '0x0000000000000000000000000000000000000000', validFor: 1800});
      const res = await fetch(cowurl, {method:'POST', headers:{'Content-Type':'application/json'}, body});
      const raw = await res.text();
      let p; try {p = JSON.parse(raw);} catch {throw new Error('[CoW] non-JSON HTTP '+res.status+': '+raw.slice(0,300));}
      if (!res.ok) throw new Error('[CoW] '+(p.description||p.errorType||JSON.stringify(p).slice(0,200)));
      const q = p.quote; if (!q||!q.buyAmount) throw new Error('[CoW] no quote: '+raw.slice(0,200));
      const out = Number(BigInt(q.buyAmount))/1e18;
      setQuote({side:dir,usdNotional:usdNum,bnbPrice:580,amountIn:amt,expectedOut:out,quotedOut:out,impactPct:0,effPrice:usdNum/out,feeAmount:q.feeAmount?Number(BigInt(q.feeAmount))/1e18:0,minOut:out*0.995,gasBnb:null,gasUsd:null,route:['CoW Protocol'],fetchedAt:Date.now()});
    } catch (e) {
      setQuoteErr({ text: `Quote preview unavailable: ${e.message || e}`, fatal: false });
    }
    setQuoting(false);
  };

  const startConfirm = (dir) => {
    setSide(dir);
    getQuote(dir, dir === 'BUY' ? buyNum : sellNum);
  };

  const send = async (dir, usdNum) => {
    setBusy(true); setMsg(null);
    try {
      const s = await (await fetch(`${API_URL}/engine/settings`)).json();
      if (s.paused) {
        setMsg({ kind: 'err', text: 'Engine is PAUSED — resume it first.' });
        closeConfirm(); setBusy(false); return;
      }
      const metadata = { usd: usdNum, tag: 'manual', contract_address: contract, decimals: decimals || 18 };
      const r = await fetch(`${API_URL}/markers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, price: price || 0, marker_type: dir === 'BUY' ? 'STRAT_BUY' : 'STRAT_SELL', direction: 'cross', label: `Manual ${dir} $${usdNum}`, metadata_json: JSON.stringify(metadata) }),
      });
      if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
      setMsg({ kind: 'ok', text: `${dir} $${usdNum} of ${displayName} sent to the engine. Fill appears in history when executed.` });
      if (dir === 'BUY') setBuyUsd(''); else setSellUsd('');
      closeConfirm();
    } catch (e) {
      setMsg({ kind: 'err', text: `Order failed: ${e.message || e}` });
      closeConfirm();
    }
    setBusy(false);
  };

  return (
    <div className={`manual-trade${stacked ? ' stacked' : ''}`}>
      <h3 style={{ margin: '0 0 6px', fontSize: 15 }}>Trade {displayName}</h3>
      <p className="qt-note" style={{ marginTop: 0, marginBottom: 12 }}>
        Engine → CoW Protocol on BSC. Key stays on your machine.
        Unexecuted orders cancel after 120s if the engine is offline.
        Not financial advice — you authorize every size and token.
      </p>

      <div className="trade-line" style={{ maxWidth: '100%' }}>
        <span className="l">Market (Binance Alpha)</span>
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
                onChange={e => { setBuyUsd(e.target.value); closeConfirm(); setMsg(null); }} />
            </div>
            <button className="trade-send buy"
              disabled={!(buyNum > 0) || !price || busy || quoting}
              onClick={() => startConfirm('BUY')}>
              {quoting && side === 'BUY' ? 'Quoting…' : `Quote buy ${buyNum > 0 ? `$${buyNum}` : ''}`}
            </button>
          </div>
          <div className="trade-box">
            <div className="head"><span>SELL</span><span className="badge badge-loss">engine</span></div>
            <div className="qt-row">
              <input type="number" min="1" step="1" placeholder="USD amount" value={sellUsd}
                onChange={e => { setSellUsd(e.target.value); closeConfirm(); setMsg(null); }} />
              {heldUsd != null && heldUsd > 0 && (
                <button className="btn-secondary" style={{ padding: '6px 12px', fontSize: 12 }}
                  onClick={() => { setSellUsd(String(Math.floor(heldUsd * 100) / 100)); closeConfirm(); }}>Max</button>
              )}
            </div>
            <button className="trade-send sell"
              disabled={!(sellNum > 0) || !price || busy || quoting}
              onClick={() => startConfirm('SELL')}>
              {quoting && side === 'SELL' ? 'Quoting…' : `Quote sell ${sellNum > 0 ? `$${sellNum}` : ''}`}
            </button>
          </div>
        </div>
      )}

      {side && (
        <div className="qt-confirm">
          <b>Preview — {side} ${confirmUsd} {displayName}</b>
          {quoting && <div className="dash-muted" style={{ marginTop: 8 }}>Fetching CoW Protocol quote…</div>}
          {quoteErr && !quoting && (
            <div style={{ marginTop: 8 }}>
              <div className="dash-error">{quoteErr.text}</div>
              <div className="btns">
                {!quoteErr.fatal && (
                  <>
                    <button style={{ background: 'rgba(255,255,255,0.08)', color: '#fff' }}
                      onClick={() => getQuote(side, confirmUsd)}>Retry</button>
                    <button style={{ background: side === 'BUY' ? 'var(--success-gradient)' : 'var(--danger-gradient)', color: '#fff' }}
                      disabled={busy}
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
                <div className="trade-line"><span className="l">Min received ({SLIPPAGE}% slip)</span>
                  <span className="v">{fmtQty(quote.minOut)} {side === 'BUY' ? displayName : 'BNB'}</span></div>
                <div className="qt-note">Quote age {age}s · engine re-quotes at execution</div>
                {rejected && (
                  <div className="dash-error" style={{ marginTop: 6 }}>
                    Engine would reject this size (impact above limit). Reduce amount or raise limit in Settings.
                  </div>
                )}
                <div className="btns">
                  <button style={{ background: side === 'BUY' ? 'var(--success-gradient)' : 'var(--danger-gradient)', color: '#fff' }}
                    disabled={busy || rejected}
                    onClick={() => send(side, confirmUsd)}>
                    {busy ? 'Sending…' : `Confirm ${side}`}
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
