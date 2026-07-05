import React, { useState } from 'react';
import { WalletProvider, useWallet } from './context/WalletContext';
import Dashboard from './components/Dashboard';
import TokenDetails from './components/TokenDetails';
import SwapPanel from './components/SwapPanel';
import ConfigPanel from './components/ConfigPanel';
import DebugConsole from './components/DebugConsole';
import { Wallet, Settings, LayoutDashboard, ArrowUpDown, Shield, RefreshCw } from 'lucide-react';

function AppContent() {
  const { address, isRefreshing } = useWallet();
  const [currentTab, setCurrentTab] = useState('dashboard');
  const [selectedTokenAddress, setSelectedTokenAddress] = useState('');

  const handleSelectToken = (tokenAddress) => {
    setSelectedTokenAddress(tokenAddress);
    setCurrentTab('token-details');
  };

  const handleNavigateToSwap = (tokenAddress = '') => {
    setSelectedTokenAddress(tokenAddress);
    setCurrentTab('swap');
  };

  return (
    <div className="app-container">
      {/* Header Bar */}
      <header className="header">
        <div className="logo-section">
          <div className="token-icon-placeholder" style={{ width: '36px', height: '36px', background: 'var(--primary-gradient)' }}>
            <Wallet size={16} />
          </div>
          <div>
            <h1 className="logo-title">Aether Wallet</h1>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase', letterSpacing: '1px' }}>
              BNB Chain Hub
            </span>
          </div>
        </div>

        <nav className="nav-links">
            <button 
              className={`btn-secondary ${currentTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setCurrentTab('dashboard')}
              style={{ 
                height: '38px', 
                padding: '0 16px', 
                borderRadius: '10px',
                fontSize: '13px',
                background: currentTab === 'dashboard' ? 'rgba(139, 92, 246, 0.15)' : '',
                borderColor: currentTab === 'dashboard' ? 'var(--primary)' : ''
              }}
            >
              <LayoutDashboard size={14} /> Dashboard
            </button>
            
            <button 
              className={`btn-secondary ${currentTab === 'swap' ? 'active' : ''}`}
              onClick={() => handleNavigateToSwap('')}
              style={{ 
                height: '38px', 
                padding: '0 16px', 
                borderRadius: '10px',
                fontSize: '13px',
                background: currentTab === 'swap' ? 'rgba(139, 92, 246, 0.15)' : '',
                borderColor: currentTab === 'swap' ? 'var(--primary)' : ''
              }}
            >
              <ArrowUpDown size={14} /> Swaps
            </button>

            <button 
              className={`btn-secondary ${currentTab === 'config' ? 'active' : ''}`}
              onClick={() => setCurrentTab('config')}
              style={{ 
                height: '38px', 
                padding: '0 16px', 
                borderRadius: '10px',
                fontSize: '13px',
                background: currentTab === 'config' ? 'rgba(139, 92, 246, 0.15)' : '',
                borderColor: currentTab === 'config' ? 'var(--primary)' : ''
              }}
            >
              <Settings size={14} /> Config
            </button>
          </nav>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {isRefreshing && (
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <RefreshCw size={10} className="spin-animation" style={{ animation: 'spin 1s linear infinite' }} />
              Updating...
            </span>
          )}

          {address ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-glass)', padding: '6px 12px', borderRadius: '10px', fontSize: '12px' }}>
              <Shield size={12} className="text-success" style={{ color: 'var(--success)' }} />
              <code>{address.substring(0, 6)}...{address.substring(address.length - 4)}</code>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', padding: '6px 12px', borderRadius: '10px', fontSize: '11px', color: 'var(--text-muted)' }}>
              <Shield size={12} style={{ opacity: 0.4 }} />
              <span>Wallet not configured — check .env</span>
            </div>
          )}
        </div>
      </header>

      {/* Main Screen Router */}
      <main className="main-content">
        {currentTab === 'dashboard' && (
          <Dashboard 
            onSelectToken={handleSelectToken} 
            onNavigateToSwap={handleNavigateToSwap} 
          />
        )}
        
        {currentTab === 'token-details' && (
          <TokenDetails 
            key={selectedTokenAddress}
            tokenAddress={selectedTokenAddress} 
            onBack={() => setCurrentTab('dashboard')} 
            onNavigateToSwap={handleNavigateToSwap}
          />
        )}

        {currentTab === 'swap' && (
          <SwapPanel 
            initialFromTokenAddress={selectedTokenAddress} 
          />
        )}

        {currentTab === 'config' && (
          <ConfigPanel />
        )}
      </main>

      <footer style={{ marginTop: '48px', paddingTop: '20px', borderTop: '1px solid rgba(255,255,255,0.03)', textAlign: 'center', fontSize: '11px', color: 'var(--text-muted)' }}>
        Aether Wallet &copy; 2026. Made locally &amp; securely. No tracking. No backend.
      </footer>
      
      <DebugConsole />
    </div>
  );
}

export default function App() {
  return (
    <WalletProvider>
      <AppContent />
    </WalletProvider>
  );
}
