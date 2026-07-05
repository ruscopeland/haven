// Shared authoring guide — slide-over panel opened from the Strategies and
// Token Finder tabs. Content lives in strategy-sdk/docs/*.md so it versions
// with the contract it documents; a tiny renderer below covers exactly the
// markdown those files use (headings, fenced code, tables, lists, inline
// code/bold). Code blocks defining a strategy/finder get an "Insert into
// editor" button that hands the raw source back to the active workbench.
import { useState } from 'react';
import authoringBasics from '@sdk-docs/authoring-basics.md?raw';
import strategyContract from '@sdk-docs/strategy-contract.md?raw';
import finderContract from '@sdk-docs/finder-contract.md?raw';
import indicatorReference from '@sdk-docs/indicator-reference.md?raw';
import recipes from '@sdk-docs/recipes.md?raw';

const SECTIONS = [
  { id: 'authoring-basics', label: 'Basics', md: authoringBasics },
  { id: 'strategy-contract', label: 'Strategy contract', md: strategyContract },
  { id: 'finder-contract', label: 'Finder contract', md: finderContract },
  { id: 'indicator-reference', label: 'Indicators', md: indicatorReference },
  { id: 'recipes', label: 'Recipes', md: recipes },
];

// ── Tiny markdown renderer (headings/code/tables/lists/inline) ─────────────
function renderInline(text, key) {
  const parts = [];
  // `code` and **bold**, non-nested — all these docs need.
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0, m, i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) parts.push(<code key={`${key}-${i++}`}>{tok.slice(1, -1)}</code>);
    else parts.push(<strong key={`${key}-${i++}`}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function renderMarkdown(md, onInsert) {
  const out = [];
  const lines = md.split('\n');
  let i = 0, key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {                          // fenced code
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;                                                  // closing fence
      const code = buf.join('\n');
      const insertable = onInsert && /const (strategy|finder)\s*=/.test(code);
      out.push(
        <div className="guide-codeblock" key={key++}>
          {insertable && (
            <button className="guide-insert" onClick={() => onInsert(code)}>
              Insert into editor
            </button>
          )}
          <pre>{code}</pre>
        </div>
      );
      continue;
    }

    if (line.startsWith('|')) {                            // table
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.split('|').slice(1, -1).map(c => c.trim());
      const header = cells(rows[0]);
      const body = rows.slice(2).map(cells);               // rows[1] = separator
      out.push(
        <table key={key++}>
          <thead><tr>{header.map((h, k) => <th key={k}>{renderInline(h, `h${k}`)}</th>)}</tr></thead>
          <tbody>
            {body.map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => <td key={ci}>{renderInline(c, `c${ri}-${ci}`)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      );
      continue;
    }

    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading) {
      const H = `h${heading[1].length}`;
      out.push(<H key={key++}>{renderInline(heading[2], `t${key}`)}</H>);
      i++;
      continue;
    }

    if (/^[-*] /.test(line) || /^\d+\. /.test(line)) {     // list block
      const items = [];
      // Keep indented continuation lines glued to their item.
      while (i < lines.length && (/^[-*] /.test(lines[i]) || /^\d+\. /.test(lines[i]) || /^ {2,}\S/.test(lines[i]))) {
        if (/^[-*] /.test(lines[i]) || /^\d+\. /.test(lines[i])) {
          items.push(lines[i].replace(/^([-*]|\d+\.) /, ''));
        } else {
          items[items.length - 1] += ' ' + lines[i].trim();
        }
        i++;
      }
      const ordered = /^\d+\. /.test(line);
      const L = ordered ? 'ol' : 'ul';
      out.push(
        <L key={key++}>
          {items.map((it, k) => <li key={k}>{renderInline(it, `li${k}`)}</li>)}
        </L>
      );
      continue;
    }

    if (line.trim() === '') { i++; continue; }

    // Paragraph: join consecutive plain lines.
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#|```|\||[-*] |\d+\. )/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    out.push(<p key={key++}>{renderInline(buf.join(' '), `p${key}`)}</p>);
  }
  return out;
}

export default function GuidePanel({ section = 'authoring-basics', onClose, onInsert }) {
  const [active, setActive] = useState(
    SECTIONS.some(s => s.id === section) ? section : 'authoring-basics');
  const current = SECTIONS.find(s => s.id === active);

  return (
    <>
      <div className="guide-overlay" onClick={onClose} />
      <div className="guide-panel">
        <div className="guide-header">
          <span className="wb-title">📖 Guide</span>
          <div className="guide-tabs">
            {SECTIONS.map(s => (
              <button
                key={s.id}
                className={`guide-tab ${s.id === active ? 'active' : ''}`}
                onClick={() => setActive(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button className="guide-close" onClick={onClose} title="Close">✕</button>
        </div>
        <div className="guide-content">
          {renderMarkdown(current.md, onInsert)}
        </div>
      </div>
    </>
  );
}
