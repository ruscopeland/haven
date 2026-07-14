import test from 'node:test';
import assert from 'node:assert/strict';

import { validateBuiltTx } from './chain.js';
import { loadIsolatedFinder, loadIsolatedStrategy } from './sandbox-runtime.js';


function wallet(chainId = 56n) {
  return {
    address: '0x0000000000000000000000000000000000000001',
    provider: {
      getNetwork: async () => ({ chainId }),
      call: async () => '0x',
    },
  };
}

const router = '0x0000000000000000000000000000000000000010';
const tx = { to: router, data: '0x12345678', value: '10' };

test('built transactions require the expected chain, router and bounded value', async () => {
  await assert.doesNotReject(validateBuiltTx(tx, wallet(), {
    allowedRouters: router, maxValueWei: 10n,
  }));
  await assert.rejects(validateBuiltTx(tx, wallet(1n), {
    allowedRouters: router, maxValueWei: 10n,
  }), /wrong chain/);
  await assert.rejects(validateBuiltTx({ ...tx, to: '0x0000000000000000000000000000000000000020' }, wallet(), {
    allowedRouters: router,
  }), /not allow-listed/);
  await assert.rejects(validateBuiltTx({ ...tx, value: '11' }, wallet(), {
    allowedRouters: router, maxValueWei: 10n,
  }), /exceeds/);
});

test('strategy sandbox rejects direct access to powerful runtime capabilities', () => {
  for (const code of [
    'const strategy={onBar(){return process.env}}',
    'const strategy={onBar(){return fetch("https://example.com")}}',
    'const strategy={onBar(){return require("node:fs")}}',
    'const strategy={onBar(){return globalThis}}',
  ]) {
    assert.match(loadIsolatedStrategy(code).error, /restricted capability/);
  }
});

test('sandbox terminates runaway callbacks', () => {
  const loaded = loadIsolatedFinder('const finder={score(){while(true){}}}');
  assert.equal(loaded.error, null);
  assert.throws(() => loaded.finder.score({}), /timed out/);
});

test('sandbox facades do not expose host constructors through obfuscation', () => {
  const code = `const strategy={onBar(bar,ctx){
    return ctx['con'+'structor']['con'+'structor']('return pro'+'cess')();
  }}`;
  const loaded = loadIsolatedStrategy(code);
  assert.equal(loaded.error, null);
  assert.throws(() => loaded.strategy.onBar({}, { state: {} }),
    /Code generation from strings disallowed|is not a function|undefined/);
});
