// WalletSetup — create or import an EVM wallet for trading.
// Private key is stored locally via the Go backend (Windows DPAPI / macOS Keychain / Linux Secret Service).
// Never leaves the machine. Seed phrase is shown once and never stored.
import { useState, useEffect } from 'react'
import { ethers } from 'ethers'

const API = 'http://localhost:8000'

export default function WalletSetup({ onWalletReady, onBack }) {
  const [mode, setMode] = useState(null) // null, 'create', 'import'
  const [status, setStatus] = useState(null) // null, 'checking', 'configured', 'none'
  const [address, setAddress] = useState('')
  const [seed, setSeed] = useState('')
  const [importValue, setImportValue] = useState('')
  const [importType, setImportType] = useState('seed') // 'seed' | 'key'
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [step, setStep] = useState(0) // 0=seed display, 1=confirm backup, 2=deposit guide

  // Check wallet status on mount
  useEffect(() => {
    fetch(`${API}/wallet/status`)
      .then(r => r.json())
      .then(d => {
        if (d.configured) {
          setStatus('configured')
          setAddress(d.address)
          localStorage.setItem('alpha_wallet_address', d.address)
          onWalletReady?.(d.address)
        } else {
          setStatus('none')
        }
      })
  }, [])

  const saveKey = async (privateKey) => {
    setSaving(true)
    setError('')
    try {
      const r = await fetch(`${API}/wallet/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ private_key: privateKey }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || d.message || 'Failed to save key')
      setAddress(d.address)
      setStatus('configured')
      localStorage.setItem('alpha_wallet_address', d.address)
      onWalletReady?.(d.address)
    } catch (e) {
      setError(e.message)
    }
    setSaving(false)
  }

  const handleCreate = () => {
    const wallet = ethers.Wallet.createRandom()
    setSeed(wallet.mnemonic.phrase)
    setAddress(wallet.address)
    setMode('create')
    setStep(0)
  }

  const handleConfirmBackup = async () => {
    // User confirmed they wrote down the seed. Now derive and store the private key.
    const wallet = ethers.Wallet.fromPhrase(seed)
    await saveKey(wallet.privateKey)
  }

  const handleImport = async () => {
    setError('')
    setSaving(true)
    try {
      let wallet
      if (importType === 'seed') {
        wallet = ethers.Wallet.fromPhrase(importValue.trim())
      } else {
        // Normalize 0X prefix to 0x so ethers accepts it
        let key = importValue.trim()
        if (key.startsWith('0X')) key = '0x' + key.slice(2)
        wallet = new ethers.Wallet(key)
      }
      await saveKey(wallet.privateKey)
    } catch (e) {
      setError(e.message || 'Invalid key or seed phrase')
    }
    setSaving(false)
  }

  const handleForget = async () => {
    if (!confirm('Remove this wallet? You will lose access to trade. Your tokens remain on-chain.')) return
    await fetch(`${API}/wallet`, { method: 'DELETE' })
    localStorage.removeItem('alpha_wallet_address')
    setStatus('none')
    setAddress('')
    setMode(null)
    setStep(0)
  }

  // ── Wallet configured ──────────────────────────────────────────────────

  if (status === 'configured') {
    return (
      <div style={page}>
        {onBack && <button onClick={onBack} style={backBtn}>← Back</button>}
        <div style={panel}>
        <h2 style={h2}>Wallet Connected</h2>
        <div style={addrBox}>
          <span style={{ color: '#8b949e', fontSize: 12 }}>Address</span>
          <code style={{ color: '#58a6ff', fontSize: 13, wordBreak: 'break-all' }}>{address}</code>
        </div>
        <p style={{ color: '#8b949e', fontSize: 12, marginBottom: 12 }}>
          Your wallet is ready. The Portfolio tab shows your tokens.
        </p>
        <button onClick={handleForget} style={dangerBtn}>Remove Wallet</button>
        </div>
      </div>
    )
  }

  // ── Choose mode ────────────────────────────────────────────────────────

  if (!mode) {
    return (
      <div style={page}>
        {onBack && <button onClick={onBack} style={backBtn}>← Settings</button>}
        <div style={panel}>
        <h2 style={h2}>Wallet</h2>
        <p style={{ color: '#8b949e', fontSize: 13, marginBottom: 20 }}>
          Connect a wallet to view your portfolio and trade.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button onClick={handleCreate} style={primaryBtn}>Create New Wallet</button>
          <button onClick={() => setMode('import')} style={secondaryBtn}>Import Existing Wallet</button>
        </div>
        <p style={{ color: '#484f58', fontSize: 11, marginTop: 16 }}>
          Recommended: create a new trading wallet. Do not use your cold storage wallet.
        </p>
        </div>
      </div>
    )
  }

  // ── Create: seed phrase display ────────────────────────────────────────

  if (mode === 'create' && step === 0) {
    const words = seed.split(' ')
    return (
      <div style={page}>
        {onBack && <button onClick={onBack} style={backBtn}>← Settings</button>}
        <div style={panel}>
        <h2 style={h2}>Your Recovery Phrase</h2>
        <div style={{ background: '#ffd33d22', border: '1px solid #ffd33d44', borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <p style={{ color: '#ffd33d', fontSize: 12, margin: 0, fontWeight: 600 }}>
            ⚠ Write these 12 words down on paper. Keep them safe.
          </p>
          <p style={{ color: '#ffd33d', fontSize: 12, margin: '4px 0 0' }}>
            This is the ONLY way to recover your wallet. We do not store your seed phrase.
          </p>
        </div>
        <div style={seedGrid}>
          {words.map((w, i) => (
            <div key={i} style={seedWord}>
              <span style={{ color: '#484f58', fontSize: 10 }}>{i + 1}</span>
              <span style={{ color: '#f0f6fc', fontSize: 14, fontWeight: 600 }}>{w}</span>
            </div>
          ))}
        </div>
        <div style={addrBox}>
          <span style={{ color: '#8b949e', fontSize: 12 }}>Address</span>
          <code style={{ color: '#58a6ff', fontSize: 13, wordBreak: 'break-all' }}>{address}</code>
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
          <button onClick={() => setMode(null)} style={secondaryBtn}>Back</button>
          <button onClick={() => setStep(1)} style={primaryBtn}>I've Written It Down</button>
        </div>
        </div>
      </div>
    )
  }

  // ── Create: confirm backup ─────────────────────────────────────────────

  if (mode === 'create' && step === 1) {
    return (
      <div style={page}>
        {onBack && <button onClick={onBack} style={backBtn}>← Settings</button>}
        <div style={panel}>
        <h2 style={h2}>Confirm Backup</h2>
        <p style={{ color: '#8b949e', fontSize: 13, marginBottom: 16 }}>
          Your recovery phrase has been shown. Make sure you have it written down.
          When you continue, the private key will be encrypted and stored on this computer.
        </p>
        <p style={{ color: '#f85149', fontSize: 12, marginBottom: 20 }}>
          If you lose your seed phrase and this computer, your funds are gone forever.
        </p>
        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={() => setStep(0)} style={secondaryBtn}>Show Seed Again</button>
          <button onClick={handleConfirmBackup} disabled={saving} style={primaryBtn}>
            {saving ? 'Saving...' : 'Confirm & Save'}
          </button>
        </div>
        {error && <p style={{ color: '#f85149', fontSize: 12, marginTop: 12 }}>{error}</p>}
        </div>
      </div>
    )
  }

  // ── Import wallet ──────────────────────────────────────────────────────

  return (
    <div style={page}>
      {onBack && <button onClick={onBack} style={backBtn}>← Settings</button>}
      <div style={panel}>
      <h2 style={h2}>Import Wallet</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          onClick={() => setImportType('seed')}
          style={importType === 'seed' ? primaryBtn : secondaryBtn}>
          Seed Phrase
        </button>
        <button
          onClick={() => setImportType('key')}
          style={importType === 'key' ? primaryBtn : secondaryBtn}>
          Private Key
        </button>
      </div>
      {importType === 'seed' ? (
        <textarea
          value={importValue}
          onChange={e => setImportValue(e.target.value)}
          placeholder="Enter your 12 or 24 word seed phrase..."
          rows={4}
          style={input}
        />
      ) : (
        <input
          type="password"
          value={importValue}
          onChange={e => setImportValue(e.target.value)}
          placeholder="0x... or 64 hex characters"
          style={input}
        />
      )}
      <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
        <button onClick={() => setMode(null)} style={secondaryBtn}>Back</button>
        <button onClick={handleImport} disabled={saving || !importValue.trim()} style={primaryBtn}>
          {saving ? 'Importing...' : 'Import Wallet'}
        </button>
      </div>
      {error && <p style={{ color: '#f85149', fontSize: 12, marginTop: 12 }}>{error}</p>}
      <p style={{ color: '#484f58', fontSize: 11, marginTop: 16 }}>
        Your private key is encrypted and stored only on this computer using Windows credential encryption.
      </p>
      </div>
    </div>
  )
}

// ── Styles ───────────────────────────────────────────────────────────────

const page = { maxWidth: 620, margin: '20px auto', padding: '0 16px' }
const backBtn = { background: 'transparent', color: '#58a6ff', border: 'none', cursor: 'pointer', fontSize: 13, padding: 0, marginBottom: 12 }

const panel = {
  background: '#161b22',
  border: '1px solid #30363d',
  borderRadius: 8,
  padding: 24,
  maxWidth: 560,
}

const h2 = { fontSize: 18, color: '#f0f6fc', marginBottom: 16 }

const primaryBtn = {
  background: '#238636', color: '#fff', border: 'none',
  padding: '10px 20px', borderRadius: 6, cursor: 'pointer',
  fontSize: 14, fontWeight: 600,
}

const secondaryBtn = {
  background: '#21262d', color: '#c9d1d9', border: '1px solid #30363d',
  padding: '10px 20px', borderRadius: 6, cursor: 'pointer',
  fontSize: 14, fontWeight: 600,
}

const dangerBtn = {
  background: 'transparent', color: '#f85149', border: '1px solid #f8514933',
  padding: '8px 16px', borderRadius: 6, cursor: 'pointer',
  fontSize: 13,
}

const seedGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 8,
  marginBottom: 16,
}

const seedWord = {
  background: '#0d1117',
  border: '1px solid #30363d',
  borderRadius: 6,
  padding: '8px 12px',
  display: 'flex',
  gap: 8,
  alignItems: 'center',
}

const addrBox = {
  background: '#0d1117',
  border: '1px solid #30363d',
  borderRadius: 6,
  padding: 12,
  marginBottom: 8,
}

const input = {
  width: '100%',
  background: '#0d1117',
  border: '1px solid #30363d',
  borderRadius: 6,
  padding: '10px 12px',
  color: '#c9d1d9',
  fontSize: 14,
  fontFamily: 'monospace',
  resize: 'vertical',
  boxSizing: 'border-box',
}
