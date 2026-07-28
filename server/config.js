import "dotenv/config";
import path from "node:path";

const ROOT = process.cwd();

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`Variavel de ambiente invalida: ${name}="${raw}" nao e um inteiro.`);
  }
  return value;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function list(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export const config = {
  port: int("PORT", 3000),
  host: process.env.HOST || "127.0.0.1",

  mediaRoot: path.resolve(ROOT, process.env.MEDIA_ROOT || "media"),
  streamsDir: null, // computed below

  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH || "ffprobe",

  maxPlaylistSizeBytes: int("MAX_PLAYLIST_SIZE_BYTES", 25 * 1024 * 1024),
  maxPlaylistChannels: int("MAX_PLAYLIST_CHANNELS", 20000),

  maxActiveStreams: int("MAX_ACTIVE_STREAMS", 4),
  maxActiveTranscodes: int("MAX_ACTIVE_TRANSCODES", 2),
  maxViewersPerStream: int("MAX_VIEWERS_PER_STREAM", 50),

  probeTimeoutMs: int("PROBE_TIMEOUT_MS", 10000),
  streamStartTimeoutMs: int("STREAM_START_TIMEOUT_MS", 20000),
  streamIdleTimeoutMs: int("STREAM_IDLE_TIMEOUT_MS", 60000),
  viewerHeartbeatIntervalMs: int("VIEWER_HEARTBEAT_INTERVAL_MS", 10000),
  viewerSessionTimeoutMs: int("VIEWER_SESSION_TIMEOUT_MS", 30000),

  streamRestartLimit: int("STREAM_RESTART_LIMIT", 4),
  streamRestartWindowMs: int("STREAM_RESTART_WINDOW_MS", 5 * 60 * 1000),

  hlsSegmentDuration: int("HLS_SEGMENT_DURATION", 4),
  hlsPlaylistSize: int("HLS_PLAYLIST_SIZE", 8),

  ffmpegLogLevel: process.env.FFMPEG_LOG_LEVEL || "warning",
  logLevel: process.env.LOG_LEVEL || "info",

  allowedStreamProtocols: list("ALLOWED_STREAM_PROTOCOLS", ["http", "https", "rtsp", "rtmp"]),

  // backend_only: nunca tenta URL direta no navegador, nunca cai de volta pra
  // ela silenciosamente; toda reproducao passa por sessao no backend.
  // backend_preferred: sempre pergunta ao backend primeiro, mas o motor de
  // estrategia pode escolher "direct" (URL original) quando for a melhor opcao.
  // direct_preferred: comportamento antigo - tenta a URL direta no navegador
  // primeiro, so cai pro backend se todas as tentativas diretas falharem.
  playbackMode: process.env.PLAYBACK_MODE || "backend_only",
  hardwareAcceleration: process.env.HARDWARE_ACCELERATION || "auto",

  allowPrivateHosts: bool("ALLOW_PRIVATE_HOSTS", false),
};

config.streamsDir = path.join(config.mediaRoot, "streams");

export function assertValidConfig() {
  const errors = [];

  if (config.port < 1 || config.port > 65535) errors.push("PORT fora do intervalo valido.");
  if (config.maxPlaylistSizeBytes <= 0) errors.push("MAX_PLAYLIST_SIZE_BYTES deve ser positivo.");
  if (config.maxPlaylistChannels <= 0) errors.push("MAX_PLAYLIST_CHANNELS deve ser positivo.");
  if (config.maxActiveStreams <= 0) errors.push("MAX_ACTIVE_STREAMS deve ser positivo.");
  if (config.maxActiveTranscodes <= 0) errors.push("MAX_ACTIVE_TRANSCODES deve ser positivo.");
  if (config.hlsSegmentDuration <= 0) errors.push("HLS_SEGMENT_DURATION deve ser positivo.");
  if (config.hlsPlaylistSize <= 0) errors.push("HLS_PLAYLIST_SIZE deve ser positivo.");
  if (!["auto", "off", "on"].includes(config.hardwareAcceleration)) {
    errors.push("HARDWARE_ACCELERATION deve ser auto, off ou on.");
  }
  if (!["backend_only", "backend_preferred", "direct_preferred"].includes(config.playbackMode)) {
    errors.push("PLAYBACK_MODE deve ser backend_only, backend_preferred ou direct_preferred.");
  }
  if (!config.allowedStreamProtocols.length) {
    errors.push("ALLOWED_STREAM_PROTOCOLS nao pode ser vazio.");
  }

  if (errors.length) {
    throw new Error("Configuracao invalida:\n" + errors.map((e) => " - " + e).join("\n"));
  }
}
