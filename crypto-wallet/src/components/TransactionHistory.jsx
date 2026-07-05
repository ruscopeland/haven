import React, { useState, useMemo } from 'react';
import { useWallet } from '../context/WalletContext';
import { ArrowUpDown, TrendingUp, TrendingDown, ExternalLink, Search, Filter, AlertTriangle } from 'lucide-react';

export default function TransactionHistory() {
  const { transactions, txError } = useWallet();
  const [filterType, setFilterType] = useState('all'); // 'all' | 'swap' | 'receive' | 'send'
  const [searchQuery, setSearchQuery] = useState('');

  const filteredTxs = useMemo(() => {
    return transactions.filter(tx => {
      // Filter by type
      if (filterType !== 'all' && tx.type !== filterType) {
        return false;
      }
      // Filter by search query (description or hash)
      const query = searchQuery.toLowerCase().trim();
      if (!query) return true;
      
      return (
        tx.description.toLowerCase().includes(query) ||
        tx.hash.toLowerCase().includes(query)
      );
    });
  }, [transactions, filterType, searchQuery]);

  return (
    <div className="glass-panel" style={{ padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h3>Transaction History</h3>
          <p className="form-label" style={{ margin: 0, fontSize: '13px' }}>Plain English explanation of all wallet operations.</p>
        </div>

        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          {/* Search Bar */}
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input
              type="text"
              className="input-control"
              placeholder="Search descriptions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ padding: '8px 12px 8px 32px', fontSize: '13px', width: '200px', height: '36px' }}
            />
          </div>

          {/* Filter dropdown */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Filter size={14} className="text-muted" />
            <select
              className="input-control"
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              style={{ padding: '0 12px', fontSize: '13px', width: '130px', height: '36px', borderRadius: '12px' }}
            >
              <option value="all">All Types</option>
              <option value="swap">Swaps</option>
              <option value="receive">Receives</option>
              <option value="send">Sends</option>
              <option value="interaction">Interactions</option>
            </select>
          </div>
        </div>
      </div>

      {txError && (
        <div className="error-banner" style={{ margin: '0 0 24px 0', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)', color: '#fcd34d' }}>
          <AlertTriangle size={16} style={{ flexShrink: 0 }} />
          <span>{txError}</span>
        </div>
      )}

      {filteredTxs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
          No transactions found matching your criteria. Make sure your wallet is configured.
        </div>
      ) : (
        <div className="timeline">
          {filteredTxs.map((tx, idx) => {
            const date = new Date(tx.timeStamp * 1000).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            });

            return (
              <div 
                key={tx.hash} 
                className="timeline-item" 
                style={{ 
                  borderBottom: idx < filteredTxs.length - 1 ? '1px solid rgba(255,255,255,0.03)' : 'none', 
                  paddingBottom: '16px',
                  paddingTop: idx > 0 ? '16px' : '0'
                }}
              >
                <div className="timeline-icon-container">
                  <div className={`timeline-icon ${tx.type}`}>
                    {tx.type === 'swap' && <ArrowUpDown size={14} />}
                    {tx.type === 'receive' && <TrendingUp size={14} />}
                    {tx.type === 'send' && <TrendingDown size={14} />}
                    {tx.type === 'interaction' && <ExternalLink size={14} />}
                  </div>
                </div>
                
                <div className="timeline-content">
                  <div className="timeline-time" style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{date}</span>
                    <a 
                      href={`https://bscscan.com/tx/${tx.hash}`} 
                      target="_blank" 
                      rel="noopener noreferrer" 
                      style={{ color: 'var(--primary)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '3px' }}
                    >
                      Verify Hash <ExternalLink size={10} />
                    </a>
                  </div>
                  <div className="timeline-desc" style={{ fontSize: '15px', color: 'var(--text-bright)', marginTop: '4px' }}>{tx.description}</div>
                  {tx.isUserInitiated && (
                    <div className="timeline-fee" style={{ marginTop: '4px' }}>
                      <span>Gas fee: {parseFloat(tx.gasFeeBnb).toFixed(5)} BNB (${tx.gasFeeUsd.toFixed(2)})</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
