import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { DiagnosticCode, classifyFfmpegLikeError } from './diagnostics.js';

const MAX_LOG_BYTES = 8000;

let ffprobeAvailable = null;

export async function checkFfprobeAvailable() {
  if (ffprobeAvailable !== null) return ffprobeAvailable;
  ffprobeAvailable = await new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(config.ffprobePath, ['-version'], { shell: false });
    } catch {
      resolve(false);
      return;
    }
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
  return ffprobeAvailable;
}

/**
 * Executa ffprobe sobre uma origem e retorna um MediaInfo normalizado.
 * Nunca lanca excecao: falhas viram { reachable: false, errors: [...] }.
 */
export async function probeSource(url, { headers = {}, timeoutMs = config.probeTimeoutMs } = {}) {
  const start = Date.now();
  const args = buildProbeArgs(url, headers, timeoutMs);

  let proc;
  try {
    proc = spawn(config.ffprobePath, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return notReachable(spawnErrorCode(err), Date.now() - start);
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(notReachable(DiagnosticCode.TIMEOUT, Date.now() - start));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_LOG_BYTES) stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_LOG_BYTES) stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      finish(notReachable(spawnErrorCode(err), Date.now() - start));
    });

    proc.on('close', (exitCode) => {
      const probeDurationMs = Date.now() - start;
      if (exitCode !== 0) {
        const { code, detail } = classifyFfmpegLikeError(stderr, exitCode);
        finish(notReachable(code, probeDurationMs, detail));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        finish(normalizeProbeResult(parsed, probeDurationMs));
      } catch (err) {
        finish(notReachable(DiagnosticCode.INVALID_FORMAT, probeDurationMs, err.message));
      }
    });
  });
}

function spawnErrorCode(err) {
  return err.code === 'ENOENT'
    ? DiagnosticCode.FFPROBE_NOT_INSTALLED
    : DiagnosticCode.UNKNOWN_ERROR;
}

function buildProbeArgs(url, headers, timeoutMs) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-analyzeduration',
    '5000000',
    '-probesize',
    '5000000',
  ];

  if (/^https?:/i.test(url)) {
    args.push('-rw_timeout', String(timeoutMs * 1000));
    if (headers && Object.keys(headers).length) {
      const headerLines = Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n');
      args.push('-headers', headerLines + '\r\n');
    }
  }

  args.push(url);
  return args;
}

function notReachable(code, probeDurationMs, detail) {
  return {
    reachable: false,
    hasVideo: false,
    hasAudio: false,
    probeDurationMs,
    errors: [detail ? `${code}: ${detail}` : code],
    errorCode: code,
  };
}

function normalizeProbeResult(parsed, probeDurationMs) {
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const format = parsed.format || {};

  const errors = [];
  if (!videoStream) errors.push(DiagnosticCode.NO_VIDEO);
  if (!audioStream) errors.push(DiagnosticCode.NO_AUDIO);

  return {
    reachable: true,
    protocol: detectProtocol(format.format_name),
    format: format.format_name,
    videoCodec: videoStream?.codec_name,
    audioCodec: audioStream?.codec_name,
    width: videoStream?.width,
    height: videoStream?.height,
    frameRate: parseFrameRate(videoStream?.r_frame_rate),
    bitrate: numberOrUndefined(format.bit_rate),
    pixelFormat: videoStream?.pix_fmt,
    sampleRate: numberOrUndefined(audioStream?.sample_rate),
    audioChannels: audioStream?.channels,
    duration: numberOrUndefined(format.duration),
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    probeDurationMs,
    errors,
  };
}

function detectProtocol(formatName) {
  if (!formatName) return undefined;
  if (/hls|applehttp/i.test(formatName)) return 'hls';
  if (/mpegts/i.test(formatName)) return 'mpegts';
  if (/mp4|mov/i.test(formatName)) return 'mp4';
  if (/rtsp/i.test(formatName)) return 'rtsp';
  if (/rtmp/i.test(formatName)) return 'rtmp';
  return formatName;
}

function parseFrameRate(value) {
  if (!value || typeof value !== 'string') return undefined;
  const [num, den] = value.split('/').map(Number);
  if (!den) return num || undefined;
  return Math.round((num / den) * 100) / 100;
}

function numberOrUndefined(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
