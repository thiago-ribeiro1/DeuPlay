import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { buildFfmpegArgs } from "./ffmpegArgs.js";
import { detectEncoder } from "./hardware.js";
import { classifyFfmpegLikeError, DiagnosticCode } from "./diagnostics.js";

const RESTART_BACKOFF_MS = [2000, 5000, 10000, 30000];
const MAX_LOG_LINES = 200;
const READINESS_POLL_MS = 250;

/** @type {Map<string, StreamProcessInternal>} */
const registry = new Map();
/** @type {Map<string, Promise<StreamProcessInternal>>} */
const startLocks = new Map();

let ffmpegAvailable = null;

export async function checkFfmpegAvailable() {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  ffmpegAvailable = await new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(config.ffmpegPath, ["-version"], { shell: false });
    } catch {
      resolve(false);
      return;
    }
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
  if (!ffmpegAvailable) {
    logger.warn("ffmpeg_not_installed", { ffmpegPath: config.ffmpegPath });
  }
  return ffmpegAvailable;
}

export function processKey(channelId, profile) {
  return `${channelId}:${profile}`;
}

export function getProcess(key) {
  return registry.get(key) ? toPublic(registry.get(key)) : undefined;
}

export function listProcesses() {
  return [...registry.values()].map(toPublic);
}

/**
 * Garante um único processo FFmpeg por canal+perfil. Chamadas concorrentes
 * para a mesma chave reutilizam a mesma inicialização (lock por chave).
 */
export async function startOrJoin(channelId, profile, { inputUrl, headers, mediaInfo, viewerId }) {
  const key = processKey(channelId, profile);

  const existing = registry.get(key);
  if (existing && ["starting", "ready", "degraded"].includes(existing.status)) {
    if (viewerId) addViewer(key, viewerId);
    if (existing.status === "starting" && existing.readyPromise) {
      await existing.readyPromise;
    }
    return toPublic(registry.get(key));
  }

  if (startLocks.has(key)) {
    const proc = await startLocks.get(key);
    if (viewerId) addViewer(key, viewerId);
    return toPublic(proc);
  }

  const startPromise = doStart(key, channelId, profile, { inputUrl, headers, mediaInfo, viewerId });
  startLocks.set(key, startPromise);
  try {
    const proc = await startPromise;
    return toPublic(proc);
  } finally {
    startLocks.delete(key);
  }
}

async function doStart(key, channelId, profile, { inputUrl, headers, mediaInfo, viewerId }) {
  const available = await checkFfmpegAvailable();
  if (!available) {
    const proc = createRecord(key, channelId, profile, { inputUrl, headers });
    proc.status = "failed";
    proc.lastError = DiagnosticCode.FFMPEG_NOT_INSTALLED;
    registry.set(key, proc);
    return proc;
  }

  const activeTranscodes = [...registry.values()].filter(
    (p) => p.status === "ready" || p.status === "starting"
  ).length;
  if (activeTranscodes >= config.maxActiveStreams) {
    const proc = createRecord(key, channelId, profile, { inputUrl, headers });
    proc.status = "failed";
    proc.lastError = DiagnosticCode.RESOURCE_LIMIT;
    registry.set(key, proc);
    return proc;
  }

  // O viewer entra no registro ANTES do spawn, nao depois do processo ficar
  // pronto: com "-c:v copy" um FFmpeg pode terminar (EOF de uma origem
  // curta) em poucas centenas de ms, antes que a chamada so pudesse
  // registrar o viewer depois. Sem isso, handleExit via viewers.size===0 e
  // trata uma sessao com espectador real como "ninguem estava assistindo".
  const proc = createRecord(key, channelId, profile, { inputUrl, headers, mediaInfo, viewerId });
  proc.status = "starting";
  registry.set(key, proc);

  proc.readyPromise = launchAndWaitReady(proc);
  await proc.readyPromise;
  return proc;
}

function createRecord(key, channelId, profile, { inputUrl, headers, mediaInfo, viewerId }) {
  return {
    key,
    channelId,
    mode: profile,
    status: "idle",
    pid: undefined,
    outputDirectory: path.join(config.streamsDir, sanitizeKey(key)),
    viewers: new Set(viewerId ? [viewerId] : []),
    startedAt: undefined,
    lastViewerAt: Date.now(),
    restartCount: 0,
    restartTimestamps: [],
    mediaInfo,
    lastError: undefined,
    inputUrl,
    headers,
    child: undefined,
    logLines: [],
    readyPromise: null,
    intentionalStop: false,
  };
}

function sanitizeKey(key) {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function launchAndWaitReady(proc) {
  await fs.mkdir(proc.outputDirectory, { recursive: true });

  const { encoder } = await detectEncoder();
  const args = buildFfmpegArgs(proc.mode, {
    inputUrl: proc.inputUrl,
    headers: proc.headers,
    outputDir: proc.outputDirectory,
    hlsSegmentDuration: config.hlsSegmentDuration,
    hlsPlaylistSize: config.hlsPlaylistSize,
    frameRate: proc.mediaInfo?.frameRate,
    encoder,
    ffmpegLogLevel: config.ffmpegLogLevel,
  });

  logger.info("ffmpeg_spawn", {
    key: proc.key,
    profile: proc.mode,
    encoder,
    outputDirectory: proc.outputDirectory,
    args: redactArgs(args),
  });

  let child;
  try {
    child = spawn(config.ffmpegPath, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    proc.status = "failed";
    proc.lastError = DiagnosticCode.FFMPEG_NOT_INSTALLED;
    logger.error("ffmpeg_spawn_failed", { key: proc.key, reason: DiagnosticCode.FFMPEG_NOT_INSTALLED });
    return proc;
  }

  proc.child = child;
  proc.pid = child.pid;
  logger.info("ffmpeg_started", { key: proc.key, pid: child.pid, outputDirectory: proc.outputDirectory });

  child.stderr.on("data", (chunk) => appendLog(proc, chunk.toString()));
  child.on("exit", (code, signal) => handleExit(proc, code, signal));
  child.on("error", (err) => {
    appendLog(proc, `spawn_error: ${err.message}`);
  });

  const ready = await waitForReadiness(proc);
  if (ready) {
    proc.status = "ready";
    proc.startedAt = Date.now();
    const segmentCount = countSegments(proc.outputDirectory);
    logger.info("hls_ready", {
      key: proc.key,
      pid: proc.pid,
      playlist: path.join(proc.outputDirectory, "index.m3u8"),
      segments: segmentCount,
    });
  } else if (proc.status !== "stopped") {
    const { code, detail } = classifyFfmpegLikeError(proc.logLines.join("\n"));
    proc.status = "failed";
    proc.lastError = detail ? `${code}: ${detail}` : code;
    logger.warn("hls_start_failed", { key: proc.key, reason: proc.lastError });
    // Este kill e uma desistencia deliberada deste perfil (timeout de
    // inicializacao), nao uma queda inesperada de um stream ao vivo: sem
    // marcar intentionalStop, o "exit" assincrono do processo chegava depois
    // do orquestrador ja ter avancado pro proximo perfil e era tratado como
    // crash, disparando restart de um perfil que ninguem mais estava usando.
    proc.intentionalStop = true;
    killChild(proc);
  }
  return proc;
}

// Nunca loga o header block inteiro (pode conter tokens/cookies vindos da
// playlist): substitui o valor de -headers por um marcador, mantendo o
// restante do argv visivel para depuracao.
function redactArgs(args) {
  const out = [...args];
  const headersIndex = out.indexOf("-headers");
  if (headersIndex !== -1 && out[headersIndex + 1] !== undefined) {
    out[headersIndex + 1] = "<redacted>";
  }
  return out;
}

function countSegments(outputDirectory) {
  try {
    return fsSync.readdirSync(outputDirectory).filter((f) => f.endsWith(".ts")).length;
  } catch {
    return 0;
  }
}

function appendLog(proc, text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  proc.logLines.push(...lines);
  if (proc.logLines.length > MAX_LOG_LINES) {
    proc.logLines.splice(0, proc.logLines.length - MAX_LOG_LINES);
  }
}

function waitForReadiness(proc) {
  const playlistPath = path.join(proc.outputDirectory, "index.m3u8");
  const deadline = Date.now() + config.streamStartTimeoutMs;

  return new Promise((resolve) => {
    const check = () => {
      if (proc.status === "stopped" || proc.status === "failed") {
        resolve(false);
        return;
      }
      if (isPlaylistReady(playlistPath)) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }
      setTimeout(check, READINESS_POLL_MS);
    };
    check();
  });
}

function isPlaylistReady(playlistPath) {
  try {
    const stat = fsSync.statSync(playlistPath);
    if (stat.size === 0) return false;
    const content = fsSync.readFileSync(playlistPath, "utf8");
    const hasSegmentRef = /\.ts(\?|$)/m.test(content);
    if (!hasSegmentRef) return false;

    const dir = path.dirname(playlistPath);
    const segmentFiles = fsSync.readdirSync(dir).filter((f) => f.endsWith(".ts"));
    return segmentFiles.some((f) => fsSync.statSync(path.join(dir, f)).size > 0);
  } catch {
    return false;
  }
}

function handleExit(proc, code, signal) {
  const pid = proc.pid;
  proc.pid = undefined;

  if (proc.intentionalStop) {
    logger.info("ffmpeg_stopped", { key: proc.key, pid, exitCode: code, signal, reason: "intentional_stop" });
    proc.status = "stopped";
    scheduleDirCleanup(proc);
    registry.delete(proc.key);
    return;
  }

  if (proc.viewers.size === 0) {
    logger.info("ffmpeg_stopped", { key: proc.key, pid, exitCode: code, signal, reason: "no_viewers" });
    proc.status = "stopped";
    scheduleDirCleanup(proc);
    registry.delete(proc.key);
    return;
  }

  // Saida limpa (codigo 0, sem sinal) e o EOF natural de uma origem finita
  // (VOD, arquivo, fixture de teste) - nao e uma falha, entao nao deve
  // disparar o backoff de restart pensado para quedas de origens ao vivo.
  if (code === 0 && !signal) {
    logger.info("ffmpeg_stopped", { key: proc.key, pid, exitCode: code, reason: "source_ended" });
    proc.status = "stopped";
    scheduleDirCleanup(proc);
    registry.delete(proc.key);
    return;
  }

  proc.status = "degraded";
  const { code: diagCode, detail } = classifyFfmpegLikeError(proc.logLines.join("\n"), code ?? undefined);
  proc.lastError = detail ? `${diagCode}: ${detail}` : diagCode;
  logger.warn("ffmpeg_exit_unexpected", { key: proc.key, code, signal, viewers: proc.viewers.size });
  scheduleRestart(proc);
}

function scheduleRestart(proc) {
  const now = Date.now();
  proc.restartTimestamps = proc.restartTimestamps.filter(
    (ts) => now - ts < config.streamRestartWindowMs
  );

  if (proc.restartTimestamps.length >= config.streamRestartLimit) {
    proc.status = "failed";
    proc.lastError = "restart_limit_exceeded: numero maximo de reinicializacoes atingido.";
    scheduleDirCleanup(proc);
    return;
  }

  const attempt = proc.restartTimestamps.length;
  const delay = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)];
  proc.restartTimestamps.push(now);
  proc.restartCount += 1;

  setTimeout(async () => {
    if (!registry.has(proc.key) || proc.viewers.size === 0) return;
    proc.status = "starting";
    proc.readyPromise = launchAndWaitReady(proc);
    await proc.readyPromise;
  }, delay);
}

export function addViewer(key, viewerId) {
  const proc = registry.get(key);
  if (!proc) return;
  proc.viewers.add(viewerId);
}

export function removeViewer(key, viewerId) {
  const proc = registry.get(key);
  if (!proc) return;
  proc.viewers.delete(viewerId);
  if (proc.viewers.size === 0) proc.lastViewerAt = Date.now();
}

export function stopProcess(key, reason) {
  const proc = registry.get(key);
  if (!proc) return false;
  proc.intentionalStop = true;
  proc.lastError = reason;
  killChild(proc);
  if (!proc.child) {
    scheduleDirCleanup(proc);
    registry.delete(key);
  }
  return true;
}

export function forceRestart(key) {
  const proc = registry.get(key);
  if (!proc) return false;
  proc.restartTimestamps = [];
  proc.viewers.add("__admin_forced__");
  killChild(proc);
  return true;
}

function killChild(proc) {
  if (!proc.child) return;
  try {
    proc.child.kill("SIGTERM");
    setTimeout(() => {
      if (proc.child && !proc.child.killed) proc.child.kill("SIGKILL");
    }, 3000);
  } catch {
    // Processo ja pode ter encerrado entre a checagem e o kill.
  }
}

async function scheduleDirCleanup(proc) {
  try {
    await fs.rm(proc.outputDirectory, { recursive: true, force: true });
  } catch (err) {
    logger.warn("cleanup_failed", { key: proc.key, error: err.message });
  }
}

// Varredura periodica: encerra processos ociosos alem do timeout configurado.
export function startIdleSweep() {
  return setInterval(() => {
    const now = Date.now();
    for (const proc of registry.values()) {
      if (proc.viewers.size > 0) continue;
      if (!["ready", "degraded"].includes(proc.status)) continue;
      if (now - proc.lastViewerAt > config.streamIdleTimeoutMs) {
        logger.info("stream_idle_stop", { key: proc.key });
        stopProcess(proc.key, "idle_timeout");
      }
    }
  }, 5000);
}

function toPublic(proc) {
  return {
    key: proc.key,
    channelId: proc.channelId,
    mode: proc.mode,
    status: proc.status,
    pid: proc.pid,
    outputDirectory: proc.outputDirectory,
    viewers: proc.viewers.size,
    startedAt: proc.startedAt,
    lastViewerAt: proc.lastViewerAt,
    restartCount: proc.restartCount,
    mediaInfo: proc.mediaInfo,
    lastError: proc.lastError,
    logTail: proc.logLines.slice(-30),
  };
}

export function getLogs(key) {
  const proc = registry.get(key);
  return proc ? proc.logLines.slice(-MAX_LOG_LINES) : [];
}
