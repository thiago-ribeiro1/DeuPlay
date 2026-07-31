import { config } from '../config.js';

// Faixas privadas/loopback/link-local: bloqueadas por padrao para reduzir risco de SSRF
// contra a propria maquina ou rede local a partir de uma URL fornecida pelo usuario.
const BLOCKED_HOST_PATTERN =
  /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0$|\[?::1\]?$|\[?fc[0-9a-f]{2}:|\[?fe80:)/i;

export class UrlValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UrlValidationError';
    this.code = code;
  }
}

export function validateSourceUrl(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new UrlValidationError('empty_url', 'Nenhuma URL foi informada.');
  }

  let target;
  try {
    target = new URL(raw);
  } catch {
    throw new UrlValidationError('invalid_url', 'A URL informada nao pode ser interpretada.');
  }

  const protocol = target.protocol.replace(':', '').toLowerCase();
  if (!config.allowedStreamProtocols.includes(protocol)) {
    throw new UrlValidationError(
      'protocol_not_allowed',
      `Protocolo "${protocol}" nao esta na lista ALLOWED_STREAM_PROTOCOLS.`
    );
  }

  if (!config.allowPrivateHosts && BLOCKED_HOST_PATTERN.test(target.hostname)) {
    throw new UrlValidationError(
      'host_not_allowed',
      'O host de destino aponta para rede local/privada e esta bloqueado por padrao.'
    );
  }

  return target;
}
