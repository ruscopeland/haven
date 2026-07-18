// Global fetch interceptor: attach the signed-in user's Clerk token to every
// request that goes to the Haven API. Doing it here (once) means the 11
// components that call `fetch(`${API_URL}/...`)` need no per-file auth changes —
// they keep working unchanged, and in solo/local dev (no Clerk) no header is
// added, which is exactly what the API's SOLO_MODE expects.
export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

let installed = false;

export function installAuthFetch(base = API_URL) {
  if (installed) return;
  installed = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.startsWith(base)) {
      try {
        const token = await window.Clerk?.session?.getToken();
        if (token) {
          init = { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } };
        }
      } catch { /* not signed in / Clerk not ready — send unauthenticated */ }
    }
    return orig(input, init);
  };
}
