import { RISK_SUMMARY_SHORT } from '../legal/content.js';

const LINKS = [
  ['terms', 'Terms'],
  ['privacy', 'Privacy'],
  ['risk', 'Risk disclosure'],
  ['docs', 'Docs'],
];

/**
 * @param {(key: string) => void} onOpen - open legal/docs page
 * @param {boolean} showStrip - short risk line
 */
export default function LegalFooter({ onOpen, showStrip = true, className = '' }) {
  return (
    <footer className={`legal-footer ${className}`.trim()}>
      {showStrip && (
        <p className="legal-footer-strip">{RISK_SUMMARY_SHORT}</p>
      )}
      <nav className="legal-footer-nav" aria-label="Legal">
        {LINKS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="legal-footer-link"
            onClick={() => onOpen?.(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      <p className="legal-footer-copy">
        © {new Date().getFullYear()} Haven · Software &amp; shared data access · Not investment advice
      </p>
    </footer>
  );
}
