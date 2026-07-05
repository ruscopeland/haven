import React, { useState, useEffect, useRef } from 'react';

export default function BotDashboard() {
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState({ status: 'Unknown', chat_history: [] });
  const [chatInput, setChatInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const logsEndRef = useRef(null);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 5000);

    const ws = new WebSocket('ws://127.0.0.1:8001/ws/logs');
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'log') {
        setLogs(prev => [...prev, data.message]);
      }
    };

    return () => {
      clearInterval(interval);
      ws.close();
    };
  }, []);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, stats.chat_history]);

  const fetchStats = async () => {
    try {
      const res = await fetch('http://127.0.0.1:8001/api/stats');
      const data = await res.json();
      setStats(data);
    } catch (e) {
      console.error('Failed to fetch stats', e);
    }
  };

  const sendChat = async () => {
    if (!chatInput.trim() || isLoading) return;
    const msg = chatInput;
    setChatInput('');
    setIsLoading(true);
    
    try {
      // Optimistically add to UI
      setStats(prev => ({
        ...prev,
        chat_history: [...prev.chat_history, { role: 'user', content: msg }]
      }));
      
      await fetch('http://127.0.0.1:8001/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg })
      });
      await fetchStats();
    } catch (e) {
      console.error('Failed to send chat', e);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bot-dashboard">
      <div className="bot-logs-panel">
        <div className="terminal-header">
          <span>MCP Execution Logs</span>
          <span style={{ color: stats.status === 'Ready' ? '#00ff88' : '#ff3366' }}>
            ● {stats.status}
          </span>
        </div>
        <div className="terminal-logs">
          {logs.map((log, i) => (
            <div key={i} className="log-entry">{log}</div>
          ))}
          <div ref={logsEndRef} />
        </div>
      </div>

      <div className="bot-sidebar" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="chat-panel" style={{ flex: 1, borderTop: 'none', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="terminal-header" style={{ borderBottom: '1px solid var(--border-color)' }}>
            Chat with Grok + DeFi Tools
          </div>
          <div className="chat-history">
            {stats.chat_history.length === 0 && (
              <div style={{ color: 'var(--text-secondary)', textAlign: 'center', marginTop: '20px' }}>
                Ask Grok to fetch a quote, check balances, or execute a swap!
              </div>
            )}
            {stats.chat_history.map((msg, i) => (
              <div key={i} className={`chat-msg ${msg.role}`}>
                {msg.content}
              </div>
            ))}
            {isLoading && (
              <div className="chat-msg bot">
                <span className="typing-indicator">Grok is thinking (and using tools)...</span>
              </div>
            )}
          </div>
          <div className="chat-input-container">
            <input 
              type="text" 
              className="chat-input"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendChat()}
              placeholder="Ask Grok to do something..."
              disabled={isLoading}
            />
            <button className="chat-send-btn" onClick={sendChat} disabled={isLoading}>
              {isLoading ? '...' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
