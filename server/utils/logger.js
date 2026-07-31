import { config } from '../config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

const SENSITIVE_HEADER_KEYS = new Set(['authorization', 'cookie', 'x-api-key']);

function redact(fields) {
  if (!fields) return fields;
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'url' && typeof value === 'string') {
      out[key] = redactQueryString(value);
    } else if (key === 'headers' && value && typeof value === 'object') {
      out[key] = redactHeaders(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function redactQueryString(url) {
  const withoutPathCredentials = redactPathCredentials(url);
  const qIndex = withoutPathCredentials.indexOf('?');
  if (qIndex === -1) return withoutPathCredentials;
  return withoutPathCredentials.slice(0, qIndex) + '?<redacted>';
}

// Xtream carrega usuario e senha no caminho (/live/U/P/123.m3u8), fora do
// alcance da limpeza de query string.
function redactPathCredentials(url) {
  return url.replace(/\/(live|movie|series)\/[^/?#]+\/[^/?#]+\//, '/$1/<redacted>/<redacted>/');
}

function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADER_KEYS.has(key.toLowerCase()) ? '<redacted>' : value;
  }
  return out;
}

function log(level, message, fields) {
  if (LEVELS[level] > currentLevel) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...redact(fields),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  error: (message, fields) => log('error', message, fields),
  warn: (message, fields) => log('warn', message, fields),
  info: (message, fields) => log('info', message, fields),
  debug: (message, fields) => log('debug', message, fields),
};
