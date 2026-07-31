import { stableChannelId } from '../utils/ids.js';
import { config } from '../config.js';

// Paineis costumam recusar clientes sem User-Agent de navegador.
const PANEL_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export class XtreamError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'XtreamError';
    this.code = code;
  }
}

/**
 * Aceita as tres formas que o usuario costuma ter em maos:
 *   host:porta
 *   http://host:porta
 *   http://host:porta/get.php?username=U&password=P&type=m3u_plus
 * A terceira e a URL de lista que os paineis entregam; dela extraimos as
 * credenciais para o usuario nao precisar separar na mao.
 */
export function parseXtreamInput(rawHost, rawUsername, rawPassword) {
  const host = (rawHost || '').trim();
  if (!host) throw new XtreamError('empty_host', 'Informe o endereco do servidor para continuar.');

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : 'http://' + host;

  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new XtreamError(
      'invalid_host',
      'Nao foi possivel encontrar o servidor. Verifique o endereco informado.'
    );
  }

  const username = (rawUsername || parsed.searchParams.get('username') || '').trim();
  const password = (rawPassword || parsed.searchParams.get('password') || '').trim();

  if (!username || !password) {
    throw new XtreamError('missing_credentials', 'Informe o usuario e a senha para continuar.');
  }

  const hadProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(host);
  const baseUrl = parsed.origin;

  // Sem protocolo explicito nao da pra adivinhar: paineis servem em http ou
  // https, e escolher errado falha na conexao, nao na autenticacao.
  const baseUrlCandidates = hadProtocol
    ? [baseUrl]
    : [baseUrl, baseUrl.replace(/^http:/, 'https:')];

  return { baseUrl, baseUrlCandidates, username, password };
}

// O fetch do Node esconde a causa real em err.cause.code. Sem isso, DNS
// inexistente, porta fechada e certificado invalido viram a mesma mensagem.
function describeNetworkFailure(err) {
  const code = extractErrorCode(err);

  const notFoundCodes = ['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ECONNREFUSED'];
  const timeoutCodes = ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'];
  const tlsCodes = [
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'EPROTO',
  ];

  if (notFoundCodes.includes(code)) {
    return 'Nao foi possivel encontrar o servidor. Verifique o endereco informado.';
  }
  if (timeoutCodes.includes(code)) {
    return 'O servidor demorou muito para responder. Tente novamente.';
  }
  if (code === 'ECONNRESET') {
    return 'A conexao com o servidor foi interrompida. Tente novamente.';
  }
  if (tlsCodes.includes(code)) {
    return 'Nao foi possivel estabelecer uma conexao segura com o servidor. Verifique o endereco informado.';
  }
  return 'Nao foi possivel conectar ao servidor. Verifique sua internet e o endereco informado.';
}

// Ao tentar IPv4 e IPv6, o fetch agrupa as falhas num AggregateError e o
// codigo util fica um nivel abaixo, em cause.errors[0].
function extractErrorCode(err, depth = 0) {
  if (!err || depth > 4) return '';
  if (err.code) return err.code;
  if (Array.isArray(err.errors) && err.errors.length) {
    return extractErrorCode(err.errors[0], depth + 1);
  }
  if (err.cause) return extractErrorCode(err.cause, depth + 1);
  return '';
}

function apiUrl(baseUrl, username, password, params = {}) {
  const url = new URL('/player_api.php', baseUrl);
  url.searchParams.set('username', username);
  url.searchParams.set('password', password);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function requestJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.probeTimeoutMs);

  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': PANEL_USER_AGENT },
      redirect: 'follow',
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new XtreamError('timeout', 'O servidor demorou muito para responder. Tente novamente.');
    }
    throw new XtreamError('unreachable', describeNetworkFailure(err));
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new XtreamError(
      'unauthorized',
      'O acesso foi recusado pelo servidor. Verifique suas credenciais ou entre em contato com o provedor.'
    );
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new XtreamError(
        'http_error',
        'Nao foi possivel encontrar o servidor. Verifique o endereco informado.'
      );
    }
    if (response.status >= 500) {
      throw new XtreamError(
        'http_error',
        'O servidor esta temporariamente indisponivel. Tente novamente mais tarde.'
      );
    }
    throw new XtreamError(
      'http_error',
      'Nao foi possivel concluir a solicitacao. Tente novamente em instantes.'
    );
  }

  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new XtreamError(
      'not_xtream',
      'Nao foi possivel reconhecer a resposta do servidor. Verifique se o endereco informado e de um painel Xtream valido.'
    );
  }
}

/** Valida credenciais e devolve o estado da conta (sem a senha). */
export async function authenticate(baseUrl, username, password) {
  const payload = await requestJson(apiUrl(baseUrl, username, password));
  const info = payload && payload.user_info;

  if (!info || String(info.auth) === '0') {
    throw new XtreamError(
      'unauthorized',
      'Usuario ou senha invalidos. Verifique os dados e tente novamente.'
    );
  }

  const status = String(info.status || '').toLowerCase();
  if (status && status !== 'active') {
    const accountStatusMessages = {
      expired: 'Sua assinatura expirou. Entre em contato com o provedor para renovar.',
      banned: 'Sua conta foi bloqueada pelo provedor. Entre em contato com o suporte.',
      disabled: 'Sua conta esta desativada. Entre em contato com o provedor.',
    };
    const message =
      accountStatusMessages[status] ||
      'Sua conta nao esta ativa no momento. Entre em contato com o provedor.';
    throw new XtreamError('account_inactive', message);
  }

  return {
    status: info.status || 'Active',
    isTrial: String(info.is_trial) === '1',
    expiresAt: toIsoDate(info.exp_date),
    activeConnections: toInt(info.active_cons),
    maxConnections: toInt(info.max_connections),
    allowedFormats: Array.isArray(info.allowed_output_formats) ? info.allowed_output_formats : [],
    serverInfo: payload.server_info || {},
  };
}

/**
 * Importa o catalogo ao vivo e devolve exatamente o mesmo formato que
 * parseM3U produz, para o store e o restante do pipeline nao notarem
 * diferenca entre uma playlist M3U e um painel Xtream.
 */
export async function importLiveCatalog({ baseUrl, username, password, account, maxChannels }) {
  const [categories, streams] = await Promise.all([
    requestJson(apiUrl(baseUrl, username, password, { action: 'get_live_categories' })),
    requestJson(apiUrl(baseUrl, username, password, { action: 'get_live_streams' })),
  ]);

  if (!Array.isArray(streams)) {
    throw new XtreamError('unexpected_payload', 'O painel nao devolveu a lista de canais ao vivo.');
  }

  const categoryNames = new Map();
  if (Array.isArray(categories)) {
    for (const category of categories) {
      categoryNames.set(String(category.category_id), category.category_name || 'Sem categoria');
    }
  }

  const extension = pickExtension(account && account.allowedFormats);
  const limit = maxChannels ?? Infinity;
  const channelsById = new Map();
  const warnings = [];
  let duplicates = 0;

  for (const stream of streams) {
    if (channelsById.size >= limit) {
      warnings.push(`Limite de ${limit} canais atingido; entradas restantes ignoradas.`);
      break;
    }

    const streamId = stream && stream.stream_id;
    if (streamId === undefined || streamId === null || streamId === '') {
      warnings.push('Canal sem stream_id devolvido pelo painel, ignorado.');
      continue;
    }

    // direct_source, quando presente, ja e a URL final montada pelo painel.
    const sourceUrl =
      typeof stream.direct_source === 'string' && stream.direct_source.startsWith('http')
        ? stream.direct_source
        : `${baseUrl}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.${extension}`;

    const id = stableChannelId(sourceUrl);
    if (channelsById.has(id)) {
      duplicates++;
      continue;
    }

    const now = new Date().toISOString();
    channelsById.set(id, {
      id,
      name: (stream.name || `Canal ${streamId}`).trim(),
      group: categoryNames.get(String(stream.category_id)) || 'Sem categoria',
      logoUrl: stream.stream_icon || undefined,
      sourceUrl,
      sourceHeaders: undefined,
      tvgId: stream.epg_channel_id || undefined,
      tvgName: stream.name || undefined,
      metadata: {
        origin: 'xtream',
        streamId: String(streamId),
        number: toInt(stream.num),
        hasArchive: String(stream.tv_archive) === '1',
        archiveDuration: toInt(stream.tv_archive_duration),
      },
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  return {
    channels: [...channelsById.values()],
    playlistMeta: {
      epgUrl: `${baseUrl}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
    },
    warnings,
    duplicates,
  };
}

// m3u8 quando o painel permitir: e o unico que o hls.js toca sem passar por
// remux. ts fica como alternativa, ai o backend converte.
function pickExtension(allowedFormats) {
  const formats = (allowedFormats || []).map((value) => String(value).toLowerCase());
  if (formats.includes('m3u8')) return 'm3u8';
  if (formats.includes('ts')) return 'ts';
  return formats[0] || 'm3u8';
}

function toInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function toIsoDate(epochSeconds) {
  const seconds = Number.parseInt(epochSeconds, 10);
  if (Number.isNaN(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/** Esconde usuario e senha do caminho /live/U/P/ para log e exibicao. */
export function maskStreamUrl(url) {
  return String(url).replace(/\/(live|movie|series)\/[^/]+\/[^/]+\//, '/$1/<redacted>/<redacted>/');
}
