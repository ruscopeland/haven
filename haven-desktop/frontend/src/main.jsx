// Desktop app entry point — Clerk auth, subscription verification, app shell.
import { StrictMode, Component } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import App from './App.jsx'

const PUBLISHABLE_KEY = 'pk_live_YOUR_CLERK_KEY'
const hasRealKey = PUBLISHABLE_KEY && !PUBLISHABLE_KEY.includes('YOUR_CLERK_KEY')

// Error boundary — catches Clerk/React init failures so the user sees a message instead of a blank screen.
class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return <App standalone={true} />
    }
    return this.props.children
  }
}

function Root() {
  // If no real Clerk key is configured, skip Clerk and show the app directly in standalone trial mode.
  if (!hasRealKey) {
    return <App standalone={true} />
  }

  return (
    <ErrorBoundary>
      <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
        <App />
      </ClerkProvider>
    </ErrorBoundary>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
