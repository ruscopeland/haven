// In-app AI coding assistant, embedded under the code editor on both the
// Strategies and Token Finder pages. It talks ONLY to the server-side proxy
// (POST /assistant/chat) so the DeepSeek key never reaches the browser; the
// server scopes each turn (by `mode`) to helping author this page's JS. Code
// blocks in a reply carry an "Insert into editor" button (same idea as
// GuidePanel) that replaces the editor contents via the parent's onInsertCode.
import { useState, useRef, useEffect } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// Split a reply into text + ```fenced code``` segments so code can be inserted.
function renderContent(content, onInsertCode) {
  const out = [];
  const re = /```[a-zA-Z0-9]*\n?([\s\S]*?)```/g;
  let last = 0, m, key = 0;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) {
      out.push(<span key={key++} className="asst-text">{content.slice(last, m.index)}</span>);
    }
    const code = m[1].replace(/\n$/, '');
    out.push(
      <div className="asst-codeblock" key={key++}>
        {onInsertCode && (
          <button className="guide-insert" onClick={() => onInsertCode(code)}>
            Insert into editor
          </button>
        )}
        <pre>{code}</pre>
      </div>
    );
    last = re.lastIndex;
  }
  if (last < content.length) {
    out.push(<span key={key} className="asst-text">{content.slice(last)}</span>);
  }
  return out;
}

export default function AssistantPanel({ mode = 'strategy', code = '', onInsertCode }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef(null);

  const label = mode === 'finder' ? 'finder' : 'strategy';
  const example = mode === 'finder'
    ? 'rank tokens by CMC volume momentum and relative strength'
    : 'buy when RSI(14) crosses below 30, sell at +5%';

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const next = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/assistant/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, code, messages: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Request failed (${res.status})`);
      setMessages([...next, { role: 'assistant', content: data.reply || '(empty reply)' }]);
    } catch (e) {
      setError(e.message || 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className={`asst-panel ${collapsed ? 'collapsed' : ''}`}>
      <div className="asst-header">
        <span className="wb-title">🤖 AI assistant</span>
        <span className="asst-sub">helps write this {label}’s code</span>
        <div className="asst-header-actions">
          {messages.length > 0 && (
            <button className="asst-mini-btn" disabled={loading}
                    onClick={() => { setMessages([]); setError(''); }}>
              Clear
            </button>
          )}
          <button className="asst-mini-btn" onClick={() => setCollapsed(c => !c)}>
            {collapsed ? 'Show' : 'Hide'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          <div className="asst-messages" ref={scrollRef}>
            {messages.length === 0 && !loading && (
              <div className="asst-empty bt-muted">
                Ask for help building your {label}. e.g. “{example}”.
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`asst-msg asst-${msg.role}`}>
                <div className="asst-role">{msg.role === 'user' ? 'You' : 'Assistant'}</div>
                <div className="asst-body">
                  {renderContent(msg.content, msg.role === 'assistant' ? onInsertCode : null)}
                </div>
              </div>
            ))}
            {loading && (
              <div className="asst-msg asst-assistant">
                <div className="asst-role">Assistant</div>
                <div className="asst-body bt-muted">Thinking…</div>
              </div>
            )}
          </div>

          {error && <div className="bt-error asst-error">⚠ {error}</div>}

          <div className="asst-input-row">
            <textarea
              className="asst-input"
              rows={2}
              placeholder={`Describe the ${label} you want, or paste an error…`}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={loading}
            />
            <button className="wb-btn wb-save asst-send"
                    onClick={send} disabled={loading || !input.trim()}>
              {loading ? '…' : 'Send'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
