import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useWallet } from '../context/WalletContext';
import { Terminal, X, Trash2, Copy, Search, ChevronDown, Check } from 'lucide-react';

export default function DebugConsole() {
  const { logs, clearLogs } = useWallet();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('all'); // 'all', 'errors', 'swaps', 'system'
  const [copied, setCopied] = useState(false);
  const [hasNewLogs, setHasNewLogs] = useState(false);
  
  const logContainerRef = useRef(null);
  const lastLogCount = useRef(logs.length);

  // Track log count for unread badge when console is closed
  useEffect(() => {
    // Check if new logs arrived while console was closed
    if (!isOpen && logs.length > lastLogCount.current) {
      setHasNewLogs(true);
    }
    lastLogCount.current = logs.length;
  }, [logs, isOpen]);

  const handleToggleOpen = () => {
    setIsOpen(!isOpen);
    if (!isOpen) {
      setHasNewLogs(false);
    }
  };

  // Filter logs based on search query and active tab
  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      // 1. Search Query Filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const msg = log.message.toLowerCase();
        const type = log.type.toLowerCase();
        if (!msg.includes(query) && !type.includes(query)) {
          return false;
        }
      }

      // 2. Tab Filter
      if (activeTab === 'errors') {
        return log.type === 'error' || log.type === 'warning';
      }
      
      if (activeTab === 'swaps') {
        const msg = log.message.toLowerCase();
        return msg.includes('swap') || msg.includes('quote') || msg.includes('approve') || msg.includes('route');
      }

      if (activeTab === 'system') {
        const msg = log.message.toLowerCase();
        const isError = log.type === 'error' || log.type === 'warning';
        const isSwap = msg.includes('swap') || msg.includes('quote') || msg.includes('approve') || msg.includes('route');
        return !isError && !isSwap;
      }

      return true; // 'all'
    });
  }, [logs, searchQuery, activeTab]);

  const handleCopyLogs = () => {
    if (filteredLogs.length === 0) return;
    
    const textToCopy = filteredLogs
      .map(log => `[${log.timestamp}] [${log.type.toUpperCase()}] ${log.message}`)
      .reverse() // Logs are stored newest-first in context, reverse to make chronological in clipboard
      .join('\n');

    navigator.clipboard.writeText(textToCopy)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(err => {
        console.error('Failed to copy logs: ', err);
      });
  };

  // Log counter helper
  const errorCount = useMemo(() => {
    return logs.filter(l => l.type === 'error' || l.type === 'warning').length;
  }, [logs]);

  return (
    <div style={{ position: 'fixed', bottom: '20px', right: '20px', zIndex: 9999 }}>
      {/* Floating Minimize/Badge */}
      {!isOpen ? (
        <button
          onClick={handleToggleOpen}
          className="btn-secondary"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 16px',
            borderRadius: '30px',
            boxShadow: '0 4px 20px rgba(139, 92, 246, 0.25)',
            border: '1px solid rgba(139, 92, 246, 0.4)',
            background: 'rgba(13, 20, 38, 0.85)',
            backdropFilter: 'blur(12px)',
            color: '#fff',
            position: 'relative'
          }}
        >
          <Terminal size={16} className="text-primary" />
          <span style={{ fontSize: '14px', fontWeight: '500' }}>Debug Console</span>
          
          {/* Unread dot or count badge */}
          {errorCount > 0 ? (
            <span style={{
              background: 'var(--danger)',
              color: '#fff',
              fontSize: '11px',
              borderRadius: '10px',
              padding: '1px 6px',
              fontWeight: 'bold'
            }}>
              {errorCount}
            </span>
          ) : (
            logs.length > 0 && (
              <span style={{
                background: 'rgba(255,255,255,0.15)',
                color: 'var(--text-muted)',
                fontSize: '11px',
                borderRadius: '10px',
                padding: '1px 6px'
              }}>
                {logs.length}
              </span>
            )
          )}

          {hasNewLogs && (
            <span style={{
              position: 'absolute',
              top: '-2px',
              right: '-2px',
              width: '8px',
              height: '8px',
              background: 'var(--primary)',
              borderRadius: '50%',
              boxShadow: '0 0 8px var(--primary)',
              animation: 'pulse 1.5s infinite'
            }} />
          )}
        </button>
      ) : (
        /* Expanded Dev Console */
        <div 
          className="glass-panel"
          style={{
            width: '460px',
            height: '420px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            background: 'rgba(7, 10, 22, 0.92)',
            border: '1px solid rgba(139, 92, 246, 0.25)',
            boxShadow: '0 12px 40px rgba(0, 0, 0, 0.6)'
          }}
        >
          {/* Header */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.07)',
            background: 'rgba(0, 0, 0, 0.2)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Terminal size={16} style={{ color: 'var(--primary)' }} />
              <h4 style={{ margin: 0, fontSize: '14px', letterSpacing: '0.5px' }}>SYSTEM LOG CONSOLE</h4>
            </div>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {/* Copy logs */}
              <button 
                onClick={handleCopyLogs}
                title="Copy log list"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '4px',
                  borderRadius: '4px',
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                {copied ? <Check size={14} style={{ color: 'var(--success)' }} /> : <Copy size={14} />}
              </button>
              
              {/* Clear logs */}
              <button 
                onClick={clearLogs}
                title="Clear logs"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '4px',
                  borderRadius: '4px',
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                <Trash2 size={14} />
              </button>

              {/* Minimize window */}
              <button 
                onClick={handleToggleOpen}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '4px',
                  borderRadius: '4px',
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                <ChevronDown size={16} />
              </button>
            </div>
          </div>

          {/* Filtering controls & Search */}
          <div style={{
            padding: '8px 12px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            background: 'rgba(0,0,0,0.1)'
          }}>
            {/* Search Input */}
            <div style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center'
            }}>
              <Search size={12} style={{
                position: 'absolute',
                left: '10px',
                color: 'var(--text-muted)'
              }} />
              <input
                type="text"
                placeholder="Search logs..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  width: '100%',
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '6px',
                  padding: '5px 10px 5px 28px',
                  fontSize: '12px',
                  color: '#fff',
                  outline: 'none',
                  fontFamily: 'var(--font-body)'
                }}
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  style={{
                    position: 'absolute',
                    right: '10px',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer'
                  }}
                >
                  <X size={10} />
                </button>
              )}
            </div>

            {/* Filter Tabs */}
            <div style={{
              display: 'flex',
              gap: '4px',
              fontSize: '11px'
            }}>
              {[
                { id: 'all', label: 'All' },
                { id: 'errors', label: 'Errors' },
                { id: 'swaps', label: 'Swaps' },
                { id: 'system', label: 'System' }
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  style={{
                    padding: '3px 8px',
                    borderRadius: '4px',
                    border: 'none',
                    background: activeTab === tab.id ? 'var(--primary-glow)' : 'transparent',
                    color: activeTab === tab.id ? 'var(--text-bright)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    fontWeight: activeTab === tab.id ? '600' : '400',
                    borderBottom: activeTab === tab.id ? '1px solid var(--primary)' : '1px solid transparent'
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Log Stream Panel */}
          <div 
            ref={logContainerRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '12px',
              display: 'flex',
              flexDirection: 'column-reverse', // To render latest at the bottom and keep scroll anchored nicely
              gap: '6px',
              fontFamily: 'monospace',
              fontSize: '11.5px',
              lineHeight: '1.4',
              background: '#04070e'
            }}
          >
            {filteredLogs.length === 0 ? (
              <div style={{
                color: 'var(--text-muted)',
                textAlign: 'center',
                padding: '24px 0',
                fontStyle: 'italic'
              }}>
                No log entries found.
              </div>
            ) : (
              filteredLogs.map((log) => {
                let color = '#d1d5db'; // default info gray-white
                let labelColor = 'rgba(209, 213, 219, 0.1)';
                
                if (log.type === 'error') {
                  color = '#f87171'; // red
                  labelColor = 'rgba(248, 113, 113, 0.15)';
                } else if (log.type === 'warning') {
                  color = '#fbbf24'; // orange
                  labelColor = 'rgba(251, 191, 36, 0.15)';
                } else if (log.type === 'success') {
                  color = '#34d399'; // green
                  labelColor = 'rgba(52, 211, 153, 0.15)';
                } else if (log.type === 'info') {
                  color = '#60a5fa'; // blue
                  labelColor = 'rgba(96, 165, 250, 0.15)';
                }

                return (
                  <div 
                    key={log.id} 
                    style={{ 
                      color,
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '6px',
                      wordBreak: 'break-all',
                      background: 'rgba(255, 255, 255, 0.01)',
                      padding: '2px 4px',
                      borderRadius: '4px'
                    }}
                  >
                    <span style={{ 
                      color: 'var(--text-muted)', 
                      userSelect: 'none',
                      fontSize: '10px'
                    }}>
                      [{log.timestamp}]
                    </span>
                    <span style={{
                      color,
                      fontSize: '9px',
                      fontWeight: 'bold',
                      background: labelColor,
                      padding: '1px 4px',
                      borderRadius: '3px',
                      textTransform: 'uppercase',
                      userSelect: 'none',
                      flexShrink: 0
                    }}>
                      {log.type}
                    </span>
                    <span>{log.message}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
