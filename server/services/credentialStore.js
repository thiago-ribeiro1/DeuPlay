import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './../config.js';
import { logger } from '../utils/logger.js';
import { seal, open, DecryptError } from './secretBox.js';

const FILE = path.join(config.dataDir, 'xtream-credentials.enc.json');

/**
 * Credenciais do painel cifradas em repouso com AES-256-GCM. A senha de
 * protecao nunca e gravada: sem ela o arquivo nao volta a ser legivel, nem
 * por quem tem acesso ao disco.
 */
export async function saveCredentials({ host, username, password }, passphrase) {
  const envelope = await seal(
    { host, username, password, savedAt: new Date().toISOString() },
    passphrase
  );

  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(envelope, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(FILE, 0o600);
  } catch {
    // Windows ignora modo POSIX; ali a protecao vem das ACLs da pasta do usuario.
  }

  logger.info('xtream_credentials_saved', { encrypted: true });
}

export async function loadCredentials(passphrase) {
  const envelope = await readEnvelope();
  if (!envelope) return null;
  return open(envelope, passphrase);
}

/** Diz apenas SE existe credencial salva. Nada do conteudo vaza sem a senha. */
export async function describeCredentials() {
  const envelope = await readEnvelope();
  if (!envelope) return { saved: false };
  return { saved: true, encrypted: true };
}

export async function clearCredentials() {
  try {
    await fs.unlink(FILE);
    logger.info('xtream_credentials_cleared', {});
    return true;
  } catch {
    return false;
  }
}

async function readEnvelope() {
  try {
    return JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    return null;
  }
}

export { DecryptError };
