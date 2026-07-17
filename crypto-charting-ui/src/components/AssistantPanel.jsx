// In-app AI coding assistant, embedded under the code editor on both the
// Strategies and Token Finder pages. It talks ONLY to the server-side proxy
// (POST /assistant/chat) so the DeepSeek key never reaches the browser; the
// server scopes each turn (by `mode`) to helping author this page's JS. Code
// blocks in a reply are inserted into the editor automatically and retain an
// "Insert into editor" button so the user can re-apply an earlier reply.
import { useState, useRef, useEffect } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const CODE_BLOCK_RE = /```[a-zA-Z0-9]*\n?([\s\S]*?)```/g;

const NAME_CONCEPTS = [
  [/\brsi\b/i, 'RSI'],
  [/\bmacd\b/i, 'MACD'],
  [/\bema\b/i, 'EMA'],
  [/\bsma\b/i, 'SMA'],
  [/bollinger/i, 'Bollinger'],
  [/\batr\b/i, 'ATR'],
  [/volum/i, 'Volume'],
  [/momentum/i, 'Momentum'],
  [/breakout|highest|new high/i, 'Breakout'],
  [/trend/i, 'Trend'],
  [/oversold|dip/i, 'Dip'],
  [/reversion|mean/i, 'Reversion'],
  [/volatil/i, 'Volatility'],
];

function firstCodeBlock(content) {
  const match = new RegExp(CODE_BLOCK_RE.source).exec(content);
  return match ? match[1].replace(/\n$/, '') : '';
}

function suggestedName(code, mode) {
  const concepts = NAME_CONCEPTS
    .filter(([pattern]) => pattern.test(code))
    .map(([, name]) => name);
  const uniqueConcepts = [...new Set(concepts)];
  const lead = uniqueConcepts.length > 0
    ? uniqueConcepts[Math.floor(Math.random() * uniqueConcepts.length)]
    : (mode === 'finder' ? 'Token' : 'Market');
  const secondChoices = uniqueConcepts.filter(concept => concept !== lead);
  const second = secondChoices.length > 0 && Math.random() < 0.5
    ? ` ${secondChoices[Math.floor(Math.random() * secondChoices.length)]}`
    : '';
  const endings = mode === 'finder'
    ? ['Scout', 'Radar', 'Lens', 'Compass', 'Beacon']
    : ['Pulse', 'Wave', 'Compass', 'Beacon', 'Signal'];
  return `${lead}${second} ${endings[Math.floor(Math.random() * endings.length)]}`;
}

// Split a reply into text + ```fenced code``` segments so code can be inserted.
function renderContent(content, onInsertCode) {
  const out = [];
  const re = new RegExp(CODE_BLOCK_RE.source, 'g');
  let last = 0, m, key = 0;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) {
      out.push(<span key={key++} className="asst-text">{content.slice(last, m.index)}</span>);
    }
    const code = m[1].replace(/\n$/, '');
    out.push(
      <div className="asst-codeblock" key={key++}>
        {onInsertCode && (
          <button type="button" className="guide-insert" onClick={() => onInsertCode(code)}>
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
  const [insertNotice, setInsertNotice] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const scrollRef = useRef(null);
  const guideDialogRef = useRef(null);

  const label = mode === 'finder' ? 'finder' : 'strategy';

  const insertCode = (generatedCode) => {
    if (!generatedCode || !onInsertCode) return;
    const name = suggestedName(generatedCode, mode);
    onInsertCode(generatedCode, name);
    setInsertNotice(`Inserted into the editor as “${name}”. Press Save if you wish to keep it.`);
  };

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  useEffect(() => {
    const dialog = guideDialogRef.current;
    if (!dialog) return;
    if (showGuide && !dialog.open) dialog.showModal();
    if (!showGuide && dialog.open) dialog.close();
  }, [showGuide]);

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
      const reply = data.reply || '(empty reply)';
      setMessages([...next, { role: 'assistant', content: reply }]);
      const generatedCode = firstCodeBlock(reply);
      if (generatedCode) insertCode(generatedCode);
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
        <span className="asst-sub">Type in your idea, and it takes care of the coding for you. Read the guide to see what it can and can’t do.</span>
        <div className="asst-header-actions">
          <button type="button" className="asst-mini-btn" onClick={() => setShowGuide(true)}>Guide</button>
          {messages.length > 0 && (
            <button type="button" className="asst-mini-btn" disabled={loading}
                    onClick={() => { setMessages([]); setError(''); setInsertNotice(''); }}>
              Clear
            </button>
          )}
          <button type="button" className="asst-mini-btn" onClick={() => setCollapsed(c => !c)}>
            {collapsed ? 'Show' : 'Hide'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {(messages.length > 0 || loading) && (
            <div className="asst-messages" ref={scrollRef}>
            {messages.map((msg, i) => (
              <div key={i} className={`asst-msg asst-${msg.role}`}>
                <div className="asst-role">{msg.role === 'user' ? 'You' : 'Assistant'}</div>
                <div className="asst-body">
                  {renderContent(msg.content, msg.role === 'assistant' ? insertCode : null)}
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
          )}

          {error && <div className="bt-error asst-error">⚠ {error}</div>}
          {insertNotice && <div className="asst-insert-notice" role="status">{insertNotice}</div>}

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
            <button type="button" className="wb-btn wb-save asst-send"
                    onClick={send} disabled={loading || !input.trim()}>
              {loading ? '…' : 'Send'}
            </button>
          </div>
        </>
      )}

      <dialog
        ref={guideDialogRef}
        className="asst-guide-dialog"
        aria-labelledby="assistant-guide-title"
        onClose={() => setShowGuide(false)}
      >
        <header className="asst-guide-header">
          <h2 id="assistant-guide-title">AI assistant guide</h2>
          <button type="button" className="asst-mini-btn" onClick={() => setShowGuide(false)}>Close</button>
        </header>
        <div className="asst-guide-body">
          <h3>What it can do</h3>
          <p>Describe your idea, rules, or an error, and the assistant can help turn that into Haven {label} code, explain existing code, or suggest a revision. When it replies with a complete script, Haven inserts it into the editor with a script-inspired name. Review it, then press Save if you want to keep it.</p>
          <h3>What it cannot do</h3>
          <p>It cannot give you a proven or automatically working strategy. You must develop the strategy idea, rules, risk choices, and judgment yourself. It does its best to interpret what you ask for, but it can misunderstand, make mistakes, or produce code that is unsuitable for your goal.</p>
          <h3>Your work and your responsibility</h3>
          <p>Strategies and finder logic created here are your own work. The assistant is a tool that helps translate your instructions into code; it does not make trading decisions for you or provide financial, investment, legal, or tax advice.</p>
          <p>To the maximum extent permitted by law, Haven, its operators, affiliates, contributors, service providers, and any assistant or language-model provider are not responsible for results, trading losses, or other loss arising from anything created or suggested here. The tool is only as useful as the instructions and review you provide.</p>
          <h3>Before using anything live</h3>
          <p>Review the code, inspect the backtest results, and run it in DRY (paper) mode before using it live. You remain responsible for deciding whether, when, and how much to trade.</p>
        </div>
      </dialog>
    </div>
  );
}
