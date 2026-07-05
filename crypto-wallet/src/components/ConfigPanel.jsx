import React, { useState, useEffect } from 'react';
import { useWallet } from '../context/WalletContext';
import { DEFAULT_RPC_URLS } from '../utils/blockchain';
import { Settings, ShieldAlert, Key, Globe, Percent, Trash2, CheckCircle2, Gauge } from 'lucide-react';

export default function ConfigPanel() {
  const { config, saveConfig, address, clearWallet, error, engineSettings, updateEngineSettings } = useWallet();
  const [walletInput, setWalletInput] = useState(config.walletInput || '');
  const [bscScanApiKey, setBscScanApiKey] = useState(config.bscScanApiKey || '');
  const [nodeRealApiKey, setNodeRealApiKey] = useState(config.nodeRealApiKey || '51c445c6f2b841e59a5931ad50e0939d');
  const [rpcUrl, setRpcUrl] = useState(config.rpcUrl || DEFAULT_RPC_URLS[0]);
  const [slippage, setSlippage] = useState(config.slippage || '0.5');
  const [quickBuyPercent, setQuickBuyPercent] = useState(config.quickBuyPercent || '5');
  const [quickSellPercent, setQuickSellPercent] = useState(config.quickSellPercent || '100');
  const [isSaved, setIsSaved] = useState(false);

  // Marker engine risk limits — server-side state (engine_settings via the API),
  // edited here as a draft and pushed on Save.
  const [engineDraft, setEngineDraft] = useState(null);
  useEffect(() => {
    if (engineSettings && !engineDraft) {
      setEngineDraft({
        max_trades_per_day: String(engineSettings.max_trades_per_day),
        max_trade_usd: String(engineSettings.max_trade_usd),
        max_price_impact_pct: String(engineSettings.max_price_impact_pct),
        max_retry_attempts: String(engineSettings.max_retry_attempts),
      });
    }
  }, [engineSettings, engineDraft]);

  const setDraftField = (key) => (e) =>
    setEngineDraft(prev => ({ ...prev, [key]: e.target.value }));

  const handleSave = (e) => {
    e.preventDefault();
    setIsSaved(false);
    saveConfig({
      walletInput,
      bscScanApiKey,
      nodeRealApiKey,
      rpcUrl,
      slippage,
      quickBuyPercent,
      quickSellPercent
    });
    if (engineDraft) {
      updateEngineSettings({
        max_trades_per_day: parseInt(engineDraft.max_trades_per_day, 10) || 20,
        max_trade_usd: parseFloat(engineDraft.max_trade_usd) || 250,
        max_price_impact_pct: parseFloat(engineDraft.max_price_impact_pct) || 3,
        max_retry_attempts: parseInt(engineDraft.max_retry_attempts, 10) || 3,
      });
    }
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 3000);
  };

  const handleClear = () => {
    if (window.confirm('Are you sure you want to delete your seed phrase and configuration? This cannot be undone.')) {
      clearWallet();
      setWalletInput('');
      setBscScanApiKey('');
      setNodeRealApiKey('51c445c6f2b841e59a5931ad50e0939d');
      setRpcUrl(DEFAULT_RPC_URLS[0]);
      setSlippage('0.5');
      setQuickBuyPercent('5');
      setQuickSellPercent('100');
    }
  };

  return (
    <div className="config-container glass-panel">
      <div className="config-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
          <Settings className="text-primary" size={28} style={{ color: 'var(--primary)' }} />
          <h2>Wallet Configuration</h2>
        </div>
        <p className="form-label" style={{ margin: 0 }}>Configure your local keys, network connection, and swap tolerance.</p>
      </div>

      <div className="warning-box">
        <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
          <ShieldAlert size={20} style={{ flexShrink: 0 }} />
          <div>
            <strong>Local Storage Security Notice</strong>
            <p style={{ fontSize: '13px', marginTop: '4px', color: '#f59e0b' }}>
              Your private keys and seed phrases are stored **entirely locally in your browser's Local Storage** and are used directly to sign transaction transactions in client-side memory. Your keys are never sent to any external server. Clear browser cookies/cache or click the delete button below to wipe all details.
            </p>
          </div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {isSaved && (
        <div className="info-banner" style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--success-glow)', border: '1px solid rgba(16, 185, 129, 0.3)', color: '#a7f3d0' }}>
          <CheckCircle2 size={16} />
          Configuration saved and wallet derived successfully!
        </div>
      )}

      <form onSubmit={handleSave}>
        <div className="form-group">
          <label className="form-label">
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Key size={14} />
              Seed Phrase or Private Key
            </div>
          </label>
          <textarea
            className="input-control"
            rows={3}
            placeholder="Enter your 12/24 word seed phrase or raw 64-character private key (e.g. 0x...)"
            value={walletInput}
            onChange={(e) => setWalletInput(e.target.value)}
            style={{ resize: 'vertical', fontFamily: 'monospace' }}
          />
          {address && (
            <div style={{ marginTop: '8px', fontSize: '13px' }}>
              <span className="form-label" style={{ display: 'inline', marginRight: '6px' }}>Derived Address:</span>
              <code style={{ background: 'rgba(255,255,255,0.05)', padding: '2px 6px', borderRadius: '4px', color: '#fff' }}>{address}</code>
            </div>
          )}
        </div>

        <div className="form-group">
          <label className="form-label">NodeReal API Key (Optional)</label>
          <input
            type="password"
            className="input-control"
            placeholder="Enter your NodeReal API key"
            value={nodeRealApiKey}
            onChange={(e) => setNodeRealApiKey(e.target.value)}
          />
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginTop: '4px' }}>
            Used to scan transactions on BNB Chain keylessly (pre-filled with a working developer key).
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: '16px' }}>
          <div className="form-group">
            <label className="form-label">
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Globe size={14} />
                BNB Chain RPC Node URL
              </div>
            </label>
            <input
              type="text"
              className="input-control"
              placeholder="e.g. https://binance.llamarpc.com"
              value={rpcUrl}
              onChange={(e) => setRpcUrl(e.target.value)}
              list="rpc-list"
            />
            <datalist id="rpc-list">
              {DEFAULT_RPC_URLS.map(url => <option key={url} value={url} />)}
            </datalist>
          </div>

          <div className="form-group">
            <label className="form-label">
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Percent size={14} />
                Max Slippage (%)
              </div>
            </label>
            <input
              type="number"
              step="0.05"
              min="0.05"
              max="50"
              className="input-control"
              placeholder="0.5"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
            />
          </div>
        </div>

        <div style={{ marginTop: '20px', borderTop: '1px solid rgba(255, 255, 255, 0.06)', paddingTop: '20px', marginBottom: '16px' }}>
          <h3 style={{ fontSize: '16px', marginBottom: '12px', color: 'var(--text-bright)' }}>Quick Trade Settings (Token Page)</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div className="form-group">
              <label className="form-label">Quick Buy Allocation (% BNB)</label>
              <input
                type="number"
                min="1"
                max="100"
                className="input-control"
                placeholder="5"
                value={quickBuyPercent}
                onChange={(e) => setQuickBuyPercent(e.target.value)}
              />
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Percentage of BNB balance to use for Quick Buy.
              </span>
            </div>
            <div className="form-group">
              <label className="form-label">Quick Sell Allocation (% Token)</label>
              <input
                type="number"
                min="1"
                max="100"
                className="input-control"
                placeholder="100"
                value={quickSellPercent}
                onChange={(e) => setQuickSellPercent(e.target.value)}
              />
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Percentage of token holdings to swap for Quick Sell.
              </span>
            </div>
          </div>
        </div>

        <div style={{ marginTop: '20px', borderTop: '1px solid rgba(255, 255, 255, 0.06)', paddingTop: '20px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <Gauge size={16} style={{ color: 'var(--primary)' }} />
            <h3 style={{ fontSize: '16px', margin: 0, color: 'var(--text-bright)' }}>Marker Engine Risk Limits</h3>
          </div>
          <p className="form-label" style={{ margin: '0 0 12px 0', fontSize: '12px' }}>
            Applied by the headless marker engine to every automated trade. Saved to the shared
            server, so they take effect without restarting anything.
            {!engineDraft && ' (Waiting for engine API…)'}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', opacity: engineDraft ? 1 : 0.5 }}>
            <div className="form-group">
              <label className="form-label">Max Trades / Day</label>
              <input
                type="number" min="0" step="1" className="input-control" placeholder="20"
                value={engineDraft?.max_trades_per_day ?? ''}
                onChange={setDraftField('max_trades_per_day')}
                disabled={!engineDraft}
              />
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Hard cap on marker executions per UTC day.
              </span>
            </div>
            <div className="form-group">
              <label className="form-label">Max Trade Size (USD)</label>
              <input
                type="number" min="0" step="1" className="input-control" placeholder="250"
                value={engineDraft?.max_trade_usd ?? ''}
                onChange={setDraftField('max_trade_usd')}
                disabled={!engineDraft}
              />
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Any single trade sized above this is aborted.
              </span>
            </div>
            <div className="form-group">
              <label className="form-label">Max Price Impact (%)</label>
              <input
                type="number" min="0" step="0.1" className="input-control" placeholder="3"
                value={engineDraft?.max_price_impact_pct ?? ''}
                onChange={setDraftField('max_price_impact_pct')}
                disabled={!engineDraft}
              />
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Abort if the quote implies more slippage than this vs. the collector price.
              </span>
            </div>
            <div className="form-group">
              <label className="form-label">Max Retry Attempts</label>
              <input
                type="number" min="0" step="1" className="input-control" placeholder="3"
                value={engineDraft?.max_retry_attempts ?? ''}
                onChange={setDraftField('max_retry_attempts')}
                disabled={!engineDraft}
              />
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                A failing marker is disabled after this many tries.
              </span>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '24px' }}>
          <button type="submit" className="btn-primary">
            Save Settings
          </button>
          
          <button type="button" className="btn-secondary" onClick={handleClear} style={{ color: 'var(--danger)', border: '1px solid rgba(244, 63, 94, 0.2)' }}>
            <Trash2 size={16} />
            Wipe Wallet Data
          </button>
        </div>
      </form>
    </div>
  );
}
