import { stableChannelId } from "../utils/ids.js";

/**
 * @typedef {Object} Channel
 * @property {string} id
 * @property {string} name
 * @property {string} [group]
 * @property {string} [logoUrl]
 * @property {string} sourceUrl
 * @property {Record<string,string>} [sourceHeaders]
 * @property {string} [tvgId]
 * @property {string} [tvgName]
 * @property {Record<string, unknown>} [metadata]
 * @property {boolean} enabled
 * @property {string} createdAt
 * @property {string} updatedAt
 */

export class M3uParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "M3uParseError";
  }
}

/**
 * Interpreta o texto de uma playlist M3U/M3U8 e retorna canais normalizados
 * e os metadados de cabecalho da playlist (#EXTM3U url-tvg=... etc).
 * @param {string} rawText
 * @param {{maxChannels?: number}} [options]
 */
export function parseM3U(rawText, options = {}) {
  if (typeof rawText !== "string" || !rawText.trim()) {
    throw new M3uParseError("Conteudo da playlist esta vazio.");
  }

  const text = stripBom(rawText);
  const lines = text.split(/\r\n|\r|\n/);
  const maxChannels = options.maxChannels ?? Infinity;

  if (!lines.some((line) => line.trim().startsWith("#EXTM3U"))) {
    throw new M3uParseError('Playlist invalida: cabecalho "#EXTM3U" nao encontrado.');
  }

  const playlistMeta = parsePlaylistHeader(lines[0]);
  const channelsById = new Map();
  const warnings = [];
  let duplicates = 0;

  let pendingExtinf = null;
  let pendingOptions = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith("#EXTM3U")) continue;

    if (line.startsWith("#EXTINF")) {
      pendingExtinf = line;
      continue;
    }

    if (line.startsWith("#EXTVLCOPT")) {
      applyVlcOption(pendingOptions, line);
      continue;
    }

    if (line.startsWith("#EXTHTTP")) {
      applyExtHttp(pendingOptions, line);
      continue;
    }

    if (line.startsWith("#EXTGRP")) {
      pendingOptions.group = line.slice("#EXTGRP:".length).trim();
      continue;
    }

    if (line.startsWith("#")) {
      // Comentario ou tag nao reconhecida: ignorado sem interromper o parse.
      continue;
    }

    // Linha de URL - encerra a entrada atual, mesmo sem #EXTINF anterior.
    const url = resolveUrl(line, playlistMeta.baseUrl);
    if (!url) {
      warnings.push(`Linha ${i + 1}: URL vazia ou invalida, entrada ignorada.`);
      pendingExtinf = null;
      pendingOptions = {};
      continue;
    }

    const entry = buildChannel(pendingExtinf, pendingOptions, url);
    pendingExtinf = null;
    pendingOptions = {};

    if (!entry) {
      warnings.push(`Linha ${i + 1}: entrada sem nome/URL utilizavel, ignorada.`);
      continue;
    }

    if (channelsById.has(entry.id)) {
      duplicates++;
      continue;
    }

    if (channelsById.size >= maxChannels) {
      warnings.push(`Limite de ${maxChannels} canais atingido; entradas restantes ignoradas.`);
      break;
    }

    channelsById.set(entry.id, entry);
  }

  return {
    channels: [...channelsById.values()],
    playlistMeta,
    warnings,
    duplicates,
  };
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parsePlaylistHeader(headerLine) {
  const line = (headerLine || "").trim();
  const tvgUrl = getAttribute(line, "url-tvg") || getAttribute(line, "x-tvg-url") || "";
  return {
    epgUrl: tvgUrl,
    baseUrl: null,
  };
}

function applyVlcOption(options, line) {
  const match = line.match(/^#EXTVLCOPT:\s*([^=]+)=(.*)$/i);
  if (!match) return;
  const key = match[1].trim().toLowerCase();
  const value = match[2].trim();
  options.headers = options.headers || {};
  if (key === "http-user-agent") options.headers["User-Agent"] = value;
  else if (key === "http-referrer" || key === "http-referer") options.headers["Referer"] = value;
}

function applyExtHttp(options, line) {
  const jsonPart = line.slice(line.indexOf(":") + 1).trim();
  try {
    const parsed = JSON.parse(jsonPart);
    options.headers = { ...(options.headers || {}), ...parsed };
  } catch {
    // Payload de #EXTHTTP invalido: ignorado silenciosamente, nao interrompe o parse.
  }
}

function resolveUrl(rawUrl, baseUrl) {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    return baseUrl ? new URL(trimmed, baseUrl).toString() : new URL(trimmed).toString();
  } catch {
    return null;
  }
}

function buildChannel(extinfLine, options, sourceUrl) {
  const attrs = extinfLine ? extinfLine.slice(0, findNameSeparator(extinfLine)) : "";
  const rawName = extinfLine
    ? extinfLine.slice(findNameSeparator(extinfLine) + 1).trim()
    : "";

  const tvgId = getAttribute(attrs, "tvg-id");
  const tvgName = getAttribute(attrs, "tvg-name");
  const name = (rawName || tvgName || "Canal sem nome").trim();
  const group = getAttribute(attrs, "group-title") || "Sem categoria";
  const logoUrl = getAttribute(attrs, "tvg-logo") || undefined;
  const isRadio = /^(true|1|yes)$/i.test(getAttribute(attrs, "radio") || "");
  const catchup = getAttribute(attrs, "catchup") || undefined;
  const catchupSource = getAttribute(attrs, "catchup-source") || undefined;
  const timeshift = getAttribute(attrs, "timeshift") || undefined;

  if (!name || !sourceUrl) return null;

  const id = stableChannelId(sourceUrl, options.headers);
  const now = new Date().toISOString();

  return {
    id,
    name,
    group,
    logoUrl,
    sourceUrl,
    sourceHeaders: options.headers || undefined,
    tvgId: tvgId || undefined,
    tvgName: tvgName || undefined,
    metadata: {
      radio: isRadio,
      catchup,
      catchupSource,
      timeshift,
    },
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

// Primeira virgula fora de aspas: nomes de canal podem conter virgula.
function findNameSeparator(line) {
  let insideQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') insideQuotes = !insideQuotes;
    else if (char === "," && !insideQuotes) return i;
  }
  return line.length;
}

function getAttribute(source, key) {
  const match = source.match(new RegExp(key + '="([^"]*)"', "i"));
  return match ? match[1].trim() : "";
}
