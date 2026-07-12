import { LEGAL_EFFECTIVE, MANIFESTO, TERMS, PRIVACY, RISK, DOCS_SECTIONS } from '../legal/content.js';

const DOCS = {
  terms: TERMS,
  privacy: PRIVACY,
  risk: RISK,
};

export function ManifestoBlock({ compact = false }) {
  return (
    <div className={`legal-manifesto${compact ? ' compact' : ''}`}>
      <h2>{MANIFESTO.title}</h2>
      {MANIFESTO.lines.map((line, i) => (
        <p key={i}>{line}</p>
      ))}
    </div>
  );
}

export function LegalDocBody({ docKey }) {
  if (docKey === 'docs') {
    return (
      <div className="legal-doc">
        <h1>Haven documentation</h1>
        <p className="legal-meta">How to use the product · Effective reference {LEGAL_EFFECTIVE}</p>
        <ManifestoBlock compact />
        {DOCS_SECTIONS.map(sec => (
          <section key={sec.id} id={`doc-${sec.id}`} className="legal-section">
            <h2>{sec.title}</h2>
            {sec.body.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </section>
        ))}
      </div>
    );
  }

  const doc = DOCS[docKey];
  if (!doc) return <p className="dash-muted">Document not found.</p>;

  return (
    <div className="legal-doc">
      <h1>{doc.title}</h1>
      <p className="legal-meta">Haven · Effective {LEGAL_EFFECTIVE}</p>
      {doc.sections.map((s) => (
        <section key={s.h} className="legal-section">
          <h2>{s.h}</h2>
          {s.p.map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </section>
      ))}
    </div>
  );
}

export default function LegalDocView({ docKey, onBack }) {
  return (
    <div className="legal-page">
      <div className="legal-page-inner glass-panel">
        <div className="legal-page-actions">
          {onBack && (
            <button type="button" className="btn-secondary" onClick={onBack}>
              ← Back
            </button>
          )}
        </div>
        <LegalDocBody docKey={docKey} />
      </div>
    </div>
  );
}
