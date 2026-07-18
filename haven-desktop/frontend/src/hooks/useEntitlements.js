import { useCallback, useEffect, useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export default function useEntitlements() {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const refresh = useCallback(async () => {
    setState(previous => ({ ...previous, loading: true, error: null }));
    try {
      const response = await fetch(`${API_URL}/billing/status`);
      if (!response.ok) throw new Error(`Account status unavailable (${response.status})`);
      setState({ loading: false, data: await response.json(), error: null });
    } catch (error) {
      setState({ loading: false, data: null, error: error.message });
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { ...state, refresh };
}
