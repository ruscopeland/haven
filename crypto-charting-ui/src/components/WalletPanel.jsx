import { useState } from 'react';
import useWalletData from '../hooks/useWalletData';
import { fmtUsd, fmtQty } from '../utils/format';

// C2: read-only wallet panel — balances + USD values, no key, no signing.
// Token USD prices come from the collector (Dashboard's shared overview poll),
// the same feed the engine trades against.
export default function WalletPanel({ prices, tokenMap }) {
  const { address, setAddress, bnb, bnbPrice, tokens, error } = useWalletData();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(address);

  const priceOf = (symbol) => prices?.[symbol] || 0;
  const bnbUsd = bnb != null && bnbPrice != null ? bnb * bnbPrice : null;
  const tokenRows = tokens.map(t => ({ ...t, usd: t.qty * priceOf(t.symbol) }));
  const total = bnbUsd != null ? bnbUsd + tokenRows.reduce((s, t) => s + t.usd, 0) : null;

  return (
    <div className="dash-panel">
      <h3>Wallet</h3>

      {editing ? (
        <div className="qt-row">
          <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="0x… wallet address" />
          <button className="settings-save" onClick={() => { setAddress(draft); setEditing(false); }}>Save</button>
        </div>
      ) : (
        <div className="wallet-addr" style={{ cursor: 'pointer' }} title="Click to change address"
          onClick={() => { setDraft(address); setEditing(true); }}>
          {address ? `${address.slice(0, 8)}…${address.slice(-6)} ✎` : 'No address set — click to add one ✎'}
        </div>
      )}

      {error && <div className="dash-error" style={{ marginTop: 6 }}>{error}</div>}

      {address && (
        <div style={{ marginTop: 8 }}>
          <div className="wallet-row">
            <span>BNB</span>
            <span>{bnb == null ? '…' : `${fmtQty(bnb)} (${bnbUsd != null ? fmtUsd(bnbUsd) : '…'})`}</span>
          </div>
          {tokenRows.map(t => (
            <div className="wallet-row" key={t.symbol}>
              <span title={t.symbol}>{t.name || t.symbol}</span>
              <span>{fmtQty(t.qty)} ({fmtUsd(t.usd)})</span>
            </div>
          ))}
          <div className="wallet-row wallet-total">
            <span>Total</span>
            <span>{total != null ? fmtUsd(total) : '…'}</span>
          </div>
        </div>
      )}
    </div>
  );
}
