import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkLoading, ClerkProvider, SignedIn, SignedOut } from '@clerk/clerk-react'
import './index.css'
import './haven-saas.css'
import App from './App.jsx'
import Landing from './components/Landing.jsx'
import Gate from './components/Gate.jsx'
import { installAuthFetch, API_URL } from './authFetch.js'

// Attach the Clerk token to every API request (no-op in solo mode).
installAuthFetch(API_URL)

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

// Solo / local dev (no Clerk key): straight into the terminal, no login —
// exactly the pre-SaaS behavior. The API must run with HAVEN_SOLO=1.
// Cloud build (Clerk key present): signed-out sees the Landing page; signed-in
// passes through the subscription Gate into the terminal.
function Root() {
  if (!CLERK_KEY) return <App />
  return (
    <ClerkProvider publishableKey={CLERK_KEY} afterSignOutUrl="/">
      <ClerkLoading>
        <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
          <div role="status" style={{ textAlign: 'center', color: '#cbd5e1' }}>
            <h1 style={{ marginBottom: 8, color: '#f8fafc' }}>Haven</h1>
            <p>Secure account service is loading…</p>
          </div>
        </main>
      </ClerkLoading>
      <SignedOut><Landing /></SignedOut>
      <SignedIn><Gate /></SignedIn>
    </ClerkProvider>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
