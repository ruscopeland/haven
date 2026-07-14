// Windows DPAPI-backed local secret storage. The encrypted blob is bound to
// the current Windows user and never lives in the Haven workspace.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Haven')
  : path.join(os.homedir(), '.haven');
const secretPath = path.join(directory, 'engine-secrets.dpapi');

function powershell(script, input) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error((result.stderr || 'Windows credential operation failed').trim());
  return result.stdout.trim();
}

export function saveEngineSecrets(secrets) {
  if (process.platform !== 'win32') {
    throw new Error('Secure automatic storage currently requires Windows; use process environment secrets on this platform.');
  }
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$plain = [Console]::In.ReadToEnd()',
    '$bytes = [Text.Encoding]::UTF8.GetBytes($plain)',
    '$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($protected)',
  ].join('; ');
  const encrypted = powershell(script, JSON.stringify(secrets));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(secretPath, encrypted, { encoding: 'utf8', mode: 0o600 });
  return secretPath;
}

export function loadEngineSecrets() {
  if (process.platform !== 'win32' || !fs.existsSync(secretPath)) return {};
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$encoded = [Console]::In.ReadToEnd().Trim()',
    '$bytes = [Convert]::FromBase64String($encoded)',
    '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Text.Encoding]::UTF8.GetString($plain)',
  ].join('; ');
  try {
    return JSON.parse(powershell(script, fs.readFileSync(secretPath, 'utf8')));
  } catch {
    return {};
  }
}

export function credentialLocation() {
  return secretPath;
}
