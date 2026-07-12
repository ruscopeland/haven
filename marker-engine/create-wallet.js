// Local wallet generation for the desktop engine. Never phones home.
import { Wallet } from 'ethers';

/** Create a new random wallet with a 12-word seed phrase (local only). */
export function createLocalWallet() {
  const wallet = Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    mnemonic: wallet.mnemonic?.phrase || '',
  };
}
