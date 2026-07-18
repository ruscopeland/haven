// Futuristic Haven mark — geometric hex + H, no nautical/anchor theme.
export default function HavenLogo({ size = 28, showWordmark = true, className = '' }) {
  const s = size;
  return (
    <span className={`haven-logo ${className}`.trim()} style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <svg
        width={s}
        height={s}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        <defs>
          <linearGradient id={`havenG-${s}`} x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
            <stop stopColor="#67e8f9" />
            <stop offset="0.45" stopColor="#a78bfa" />
            <stop offset="1" stopColor="#7c3aed" />
          </linearGradient>
        </defs>
        <path
          stroke={`url(#havenG-${s})`}
          strokeWidth="2.5"
          fill="rgba(13,20,38,0.85)"
          d="M32 4 L56 18 V46 L32 60 L8 46 V18 Z"
        />
        <path
          fill={`url(#havenG-${s})`}
          d="M22 20h5.2v9.2H36.8V20H42v24h-5.2v-9.8H27.2V44H22V20z"
        />
        <circle cx="32" cy="32" r="2.2" fill="#67e8f9" />
      </svg>
      {showWordmark && <span className="haven-wordmark">Haven</span>}
    </span>
  );
}
