// Haven Engine — first-run setup.
// Creates a trading wallet on this machine (or reuses one you paste),
// then writes marker-engine/.env. Nothing here is sent to Haven servers.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { createLocalWallet } from './create-wallet.js';
import { credentialLocation, loadEngineSecrets, saveEngineSecrets } from './credential-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '.env');
const DEFAULT_API = 'https://api-production-0dc54.up.railway.app';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def) => new Promise((res) => {
  rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => res((a || '').trim() || def || ''));
});

function readExisting() {
  const out = {};
  try {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* first run */ }
  return out;
}

function isLikelyPk(v) {
  const s = (v || '').startsWith('0x') ? v.slice(2) : (v || '');
  return /^[0-9a-fA-F]{64}$/.test(s);
}

function normalizePk(v) {
  const s = (v || '').trim();
  if (!s) return '';
  return s.startsWith('0x') ? s : `0x${s}`;
}

function printWalletOnce({ address, privateKey, mnemonic }) {
  console.log('\n---------------------------------------------');
  console.log('  NEW WALLET (this machine only)');
  console.log('---------------------------------------------');
  console.log(`  Address:      ${address}`);
  console.log(`  Private key:  ${privateKey}`);
  if (mnemonic) {
    console.log('');
    console.log('  Seed phrase (12 words) — copy this somewhere safe offline:');
    console.log('');
    console.log(`    ${mnemonic}`);
  }
  console.log('---------------------------------------------');
  console.log('  If you lose the seed / key, funds in this wallet are gone.');
  console.log('---------------------------------------------\n');
}

async function confirmSeedSaved(mnemonic) {
  if (!mnemonic) {
    const ok = await ask('Type YES after you have copied the private key', '');
    return /^yes$/i.test(ok);
  }
  const words = mnemonic.trim().split(/\s+/);
  const i1 = 2; // word #3
  const i2 = 8; // word #9
  console.log('Confirm you saved the seed phrase (enter two words):');
  for (;;) {
    const w1 = await ask(`  Word #${i1 + 1}`, '');
    const w2 = await ask(`  Word #${i2 + 1}`, '');
    if (w1.toLowerCase() === words[i1].toLowerCase()
        && w2.toLowerCase() === words[i2].toLowerCase()) {
      return true;
    }
    console.log('  Those words do not match. Check your copy and try again.');
    const again = await ask('  Try again? (Y/n)', 'Y');
    if (!/^y/i.test(again)) return false;
  }
}

async function chooseWallet(cur) {
  const hasExisting = isLikelyPk(cur.PRIVATE_KEY || '');
  console.log('\nWallet for live trading:');
  console.log('  [1] Create a new wallet on this computer  (recommended)');
  if (hasExisting) {
    console.log(`  [2] Keep existing wallet  (${String(cur.PRIVATE_KEY).slice(0, 10)}…)`);
    console.log('  [3] Paste a private key you already have');
  } else {
    console.log('  [2] Paste a private key you already have');
  }

  for (;;) {
    const choice = await ask('Choose', '1');

    if (choice === '1') {
      const created = createLocalWallet();
      printWalletOnce(created);
      const ok = await confirmSeedSaved(created.mnemonic);
      if (!ok) {
        console.log('Setup cancelled — no wallet saved.');
        return null;
      }
      return created.privateKey;
    }

    if (hasExisting && choice === '2') {
      console.log('  Keeping existing wallet from .env');
      return normalizePk(cur.PRIVATE_KEY);
    }

    const pasteChoice = hasExisting ? '3' : '2';
    if (choice === pasteChoice) {
      let pk = '';
      while (!pk) {
        pk = await ask('Paste private key', '');
        if (!pk) {
          console.log('  Private key required, or choose 1 to create one.');
          continue;
        }
        if (!isLikelyPk(pk)) {
          const ok = await ask('  That does not look like a 64-char key. Use it anyway? (y/N)', 'N');
          if (!/^y/i.test(ok)) pk = '';
        }
      }
      return normalizePk(pk);
    }

    console.log('  Enter 1' + (hasExisting ? ', 2, or 3' : ' or 2') + '.');
  }
}

async function main() {
  console.log('\n=============================================');
  console.log('  Haven Engine — setup');
  console.log('=============================================');
  console.log('Connects this computer to your Haven account for live trading.\n');

  const cur = readExisting();
  const secure = loadEngineSecrets();
  if (secure.apiKey) cur.HAVEN_API_KEY = secure.apiKey;
  if (secure.privateKey) cur.PRIVATE_KEY = secure.privateKey;

  const apiUrl = await ask(
    '1) Haven API address (press Enter for the default)',
    cur.HAVEN_API_URL || DEFAULT_API);

  console.log('\n   Connection key: Haven website → Settings → Connect your engine.\n');
  let apiKey = '';
  while (!apiKey) {
    apiKey = await ask('2) Paste your connection key', cur.HAVEN_API_KEY || '');
    if (!apiKey) console.log('   A connection key is required.');
  }

  const pk = await chooseWallet(cur);
  if (!pk) {
    rl.close();
    process.exit(1);
  }

  let address = '';
  try {
    address = new Wallet(pk).address;
  } catch (e) {
    console.error(`Invalid private key: ${e.message}`);
    rl.close();
    process.exit(1);
  }

  const lines = [
    '# Haven Engine — non-secret local configuration.',
    `# Trading wallet address: ${address}`,
    `HAVEN_API_URL=${apiUrl}`,
    '',
  ];
  saveEngineSecrets({ apiKey, privateKey: pk });
  fs.writeFileSync(ENV_PATH, lines.join('\n'), { mode: 0o600 });

  console.log(`\nSaved: ${ENV_PATH}`);
  console.log(`Encrypted credentials: ${credentialLocation()}`);
  console.log(`Wallet address: ${address}`);
  console.log('Start the engine:  npm start   (or run.bat)');
  console.log('Fund this address on-chain before live trades.\n');
  rl.close();
}

main().catch((e) => {
  console.error('Setup failed:', e.message);
  process.exit(1);
});
