let worker;
let sequence = 0;
const pending = new Map();

function createWorker() {
  const instance = new Worker(new URL('./strategyWorker.js', import.meta.url), { type: 'module' });
  instance.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  };
  instance.onerror = (event) => resetWorker(new Error(event.message || 'Strategy worker failed'));
  return instance;
}

function resetWorker(error) {
  worker?.terminate();
  worker = null;
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

export function runStrategyWorker(operation, payload, timeoutMs = 12_000) {
  worker ||= createWorker();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resetWorker(new Error('User code exceeded its execution limit'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, operation, payload });
  });
}
