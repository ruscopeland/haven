import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { createLocalWallet } from './create-wallet.js';

describe('createLocalWallet', () => {
  it('returns address, private key, and 12-word mnemonic', () => {
    const w = createLocalWallet();
    assert.match(w.address, /^0x[0-9a-fA-F]{40}$/);
    assert.match(w.privateKey, /^0x[0-9a-fA-F]{64}$/);
    const words = w.mnemonic.trim().split(/\s+/);
    assert.equal(words.length, 12);
    const recovered = new Wallet(w.privateKey);
    assert.equal(recovered.address, w.address);
  });

  it('creates unique wallets', () => {
    const a = createLocalWallet();
    const b = createLocalWallet();
    assert.notEqual(a.privateKey, b.privateKey);
    assert.notEqual(a.address, b.address);
  });
});
