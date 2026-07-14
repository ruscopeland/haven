// Layered isolation for user-authored strategy/finder code in the local engine.
// The context has no Node globals, network, filesystem, dynamic code generation,
// or WebAssembly. Every callback receives a hard execution deadline.
import vm from 'node:vm';
import { randomBytes } from 'node:crypto';

const LOAD_TIMEOUT_MS = Number(process.env.HAVEN_CODE_LOAD_TIMEOUT_MS || 100);
const CALL_TIMEOUT_MS = Number(process.env.HAVEN_CODE_CALL_TIMEOUT_MS || 50);
const MAX_CODE_BYTES = Number(process.env.HAVEN_MAX_CODE_BYTES || 64 * 1024);
const FORBIDDEN = /\b(?:process|require|module|exports|global|globalThis|fetch|WebSocket|XMLHttpRequest|Function|eval|Proxy|Reflect|SharedArrayBuffer|Atomics|import)\b|(?:__proto__|prototype|constructor)/;

function validateSource(code) {
  if (typeof code !== 'string' || Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    throw new Error(`code exceeds the ${MAX_CODE_BYTES}-byte limit`);
  }
  const hit = code.match(FORBIDDEN);
  if (hit) throw new Error(`restricted capability in strategy code: ${hit[0]}`);
}

function contextFor(code, binding) {
  validateSource(code);
  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox, {
    name: `haven-${binding}`,
    codeGeneration: { strings: false, wasm: false },
  });
  const script = new vm.Script(
    `globalThis.__haven=(function(){'use strict';\n${code}\n;Object.freeze(${binding});return ${binding};})();`,
    { filename: `user-${binding}.js` },
  );
  script.runInContext(context, { timeout: LOAD_TIMEOUT_MS });
  return context;
}

function bridgeName() {
  return `__haven_bridge_${randomBytes(12).toString('hex')}`;
}

// User code must never receive a host-realm object or function. A host
// function's constructor can otherwise lead back to Node even when string
// code generation is disabled in the VM. Build the entire facade inside the
// VM and cross the boundary only as JSON strings.
function facadeSource(context, value, bridgeKeys) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'function') {
    const key = bridgeName();
    bridgeKeys.push(key);
    context[key] = (jsonArgs) => {
      const args = JSON.parse(jsonArgs);
      const result = value(...args);
      return result === undefined ? undefined : JSON.stringify(result);
    };
    return `((...args)=>{const out=${key}(JSON.stringify(args));return out===undefined?undefined:JSON.parse(out)})`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => facadeSource(context, item, bridgeKeys)).join(',')}]`;
  }
  const entries = Object.keys(value).map(key =>
    `${JSON.stringify(key)}:${facadeSource(context, value[key], bridgeKeys)}`);
  return `Object.assign(Object.create(null),{${entries.join(',')}})`;
}

function call(context, expression, values) {
  const bridgeKeys = [];
  for (const [key, value] of Object.entries(values)) {
    const source = facadeSource(context, value, bridgeKeys);
    new vm.Script(`globalThis[${JSON.stringify(key)}]=${source}`)
      .runInContext(context, { timeout: CALL_TIMEOUT_MS });
  }
  try {
    const result = new vm.Script(expression).runInContext(context, { timeout: CALL_TIMEOUT_MS });
    // ctx.state is the only intentionally mutable user surface. Copy its
    // JSON-safe contents back without ever exporting the VM object itself.
    if (values.__ctx?.state) {
      const encoded = new vm.Script(`JSON.stringify(__ctx.state)`)
        .runInContext(context, { timeout: CALL_TIMEOUT_MS });
      const next = JSON.parse(encoded || '{}');
      for (const key of Object.keys(values.__ctx.state)) delete values.__ctx.state[key];
      Object.assign(values.__ctx.state, next);
    }
    return result == null || typeof result !== 'object'
      ? result : JSON.parse(JSON.stringify(result));
  } finally {
    for (const key of Object.keys(values)) delete context[key];
    for (const key of bridgeKeys) delete context[key];
  }
}

export function loadIsolatedStrategy(code) {
  try {
    const context = contextFor(code, 'strategy');
    const hasOnBar = new vm.Script(`typeof __haven.onBar === 'function'`)
      .runInContext(context, { timeout: CALL_TIMEOUT_MS });
    if (!hasOnBar) return { strategy: null, error: 'strategy.onBar(bar, ctx) is required' };
    const params = new vm.Script(`JSON.parse(JSON.stringify(__haven.params || {}))`)
      .runInContext(context, { timeout: CALL_TIMEOUT_MS });
    const hasInit = new vm.Script(`typeof __haven.init === 'function'`)
      .runInContext(context, { timeout: CALL_TIMEOUT_MS });
    return {
      error: null,
      strategy: Object.freeze({
        params,
        init: hasInit ? (ctx) => call(context, `__haven.init(__ctx)`, { __ctx: ctx }) : undefined,
        onBar: (bar, ctx) => call(context, `__haven.onBar(__bar, __ctx)`, { __bar: bar, __ctx: ctx }),
      }),
    };
  } catch (e) {
    return { strategy: null, error: e?.message || String(e) };
  }
}

export function loadIsolatedFinder(code) {
  try {
    const context = contextFor(code, 'finder');
    const hasScore = new vm.Script(`typeof __haven.score === 'function'`)
      .runInContext(context, { timeout: CALL_TIMEOUT_MS });
    if (!hasScore) return { finder: null, error: 'finder.score(ctx) is required' };
    const hasFilter = new vm.Script(`typeof __haven.filter === 'function'`)
      .runInContext(context, { timeout: CALL_TIMEOUT_MS });
    const params = new vm.Script(`JSON.parse(JSON.stringify(__haven.params || {}))`)
      .runInContext(context, { timeout: CALL_TIMEOUT_MS });
    return {
      error: null,
      finder: Object.freeze({
        params,
        filter: hasFilter ? (ctx) => call(context, `__haven.filter(__ctx)`, { __ctx: ctx }) : undefined,
        score: (ctx) => call(context, `__haven.score(__ctx)`, { __ctx: ctx }),
      }),
    };
  } catch (e) {
    return { finder: null, error: e?.message || String(e) };
  }
}
