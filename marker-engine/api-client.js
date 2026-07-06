// Shared Haven API client — used by the desktop engine (index.js) and the
// cloud paper-runner (paper-runner-service.js). Every request carries the
// X-Api-Key header when a key is set (a user's engine key, or the cloud
// runner's service key); solo/local mode leaves it empty.
export class ApiClient {
  constructor(baseUrl, apiKey = '') {
    this.base = baseUrl;
    this.apiKey = apiKey;
  }

  async #json(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;
    const res = await fetch(this.base + pathname, { ...options, headers });
    if (!res.ok) throw new Error(`API ${pathname} → HTTP ${res.status}`);
    return res.json();
  }
  #post(pathname, body) {
    return this.#json(pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  getOverview() { return this.#json('/dashboard/overview'); }
  getTokens() { return this.#json('/tokens?limit=2000'); }
  getEngineSettings() { return this.#json('/engine/settings'); }
  claimMarker(id) { return this.#post(`/markers/${id}/claim`); }
  recordTrade(trade) { return this.#post('/trades', trade); }
  createMarker(marker) { return this.#post('/markers', marker); }
  deleteMarker(id) {
    const headers = this.apiKey ? { 'X-Api-Key': this.apiKey } : {};
    return fetch(`${this.base}/markers/${id}`, { method: 'DELETE', headers })
      .then(r => { if (!r.ok) throw new Error(`DELETE /markers/${id} → HTTP ${r.status}`); });
  }
  heartbeat(process = 'execution_engine') { return this.#post('/heartbeat', { process }); }

  // Strategy runner endpoints
  listStrategies() { return this.#json('/strategies'); }
  getStrategy(id) { return this.#json(`/strategies/${id}`); }
  patchStrategy(id, body) {
    return this.#json(`/strategies/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // Token Finder endpoints (finder hub + portfolio strategies)
  listFinders() { return this.#json('/finders'); }
  getFinder(id) { return this.#json(`/finders/${id}`); }
  patchFinder(id, body) {
    return this.#json(`/finders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  getUniverse(interval, startMs, minVol24h = 50_000) {
    return this.#json(`/universe?interval=${interval}&start_ms=${startMs}&min_vol_24h=${minVol24h}`);
  }
  getKlines(symbol, interval, limit) {
    return this.#json(`/klines/${symbol}?interval=${interval}&limit=${limit}`);
  }
  getFlow(symbol, startMs) {
    return this.#json(`/flow/${symbol}?limit=10080${startMs ? `&start_ms=${startMs}` : ''}`);
  }
  getTrades({ symbol, status, strategy_id, limit = 50 } = {}) {
    const q = new URLSearchParams();
    if (symbol) q.set('symbol', symbol);
    if (status) q.set('status', status);
    if (strategy_id) q.set('strategy_id', strategy_id);
    q.set('limit', String(limit));
    return this.#json(`/trades?${q}`);
  }
  postLog(level, message, metadata) {
    return this.#post('/debug/logs', {
      source: 'engine', level, message,
      metadata_json: metadata ? JSON.stringify(metadata) : null,
    });
  }
  rearmMarker(id) {
    return this.#json(`/markers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: 1 }),
    });
  }
}
