import {
  randomBytes,
  scrypt as scryptCallback,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

// Custo do scrypt: ~100ms por derivacao nesta faixa. Alto o suficiente para
// tornar forca bruta cara, baixo o suficiente para nao travar o login.
const KDF = { N: 32768, r: 8, p: 1, keyLength: 32 };
const VERSION = 1;

export class DecryptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecryptError';
  }
}

async function deriveKey(passphrase, salt) {
  return scrypt(passphrase.normalize('NFKC'), salt, KDF.keyLength, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: 128 * KDF.N * KDF.r * 2,
  });
}

/**
 * Cifra um objeto com AES-256-GCM. Salt e IV sao aleatorios a cada gravacao,
 * e a tag de autenticacao faz senha errada falhar de forma detectavel em vez
 * de devolver lixo.
 */
export async function seal(payload, passphrase) {
  if (!passphrase) throw new DecryptError('Senha de protecao ausente.');

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    v: VERSION,
    kdf: 'scrypt',
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  };
}

export async function open(envelope, passphrase) {
  if (!passphrase) throw new DecryptError('Senha de protecao ausente.');
  if (!envelope || envelope.v !== VERSION) {
    throw new DecryptError('Formato de arquivo desconhecido ou corrompido.');
  }

  const key = await scrypt(
    passphrase.normalize('NFKC'),
    Buffer.from(envelope.salt, 'base64'),
    KDF.keyLength,
    {
      N: envelope.N || KDF.N,
      r: envelope.r || KDF.r,
      p: envelope.p || KDF.p,
      maxmem: 128 * (envelope.N || KDF.N) * (envelope.r || KDF.r) * 2,
    }
  );

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    // final() falha quando a tag nao confere: senha errada ou arquivo alterado.
    throw new DecryptError('Senha de protecao incorreta.');
  }
}
