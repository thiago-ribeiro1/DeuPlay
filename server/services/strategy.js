import { config } from "../config.js";
import { DiagnosticCode } from "./diagnostics.js";

export const Profile = Object.freeze({
  DIRECT: "direct",
  HTTP_PROXY: "http_proxy",
  HLS_PROXY: "hls_proxy",
  REMUX: "remux",
  COPY_VIDEO_TRANSCODE_AUDIO: "copy_video_transcode_audio",
  TRANSCODE_VIDEO_COPY_AUDIO: "transcode_video_copy_audio",
  TRANSCODE_ALL: "transcode_all",
  AUDIO_ONLY: "audio_only",
});

// Codecs que o proprio navegador (via <video> nativo ou HLS.js remuxando so o
// container) consegue decodificar sem passar por FFmpeg.
const BROWSER_VIDEO_CODECS = new Set(["h264", "avc", "avc1", "vp8", "vp9"]);
const BROWSER_AUDIO_CODECS = new Set(["aac", "mp3", "opus"]);

/**
 * Decide a cadeia ordenada de estrategias a tentar para uma origem, a partir
 * do resultado do probe. Nunca retorna profiles repetidos nem estrategias
 * equivalentes a uma ja tentada com o mesmo resultado.
 */
export function decidePlaybackStrategy(mediaInfo, sourceInfo = {}, clientCapabilities = {}) {
  if (!mediaInfo || !mediaInfo.reachable) {
    return { profiles: [], unavailable: true, reason: mediaInfo?.errorCode || DiagnosticCode.UNKNOWN_ERROR };
  }

  if (!mediaInfo.hasVideo && !mediaInfo.hasAudio) {
    return { profiles: [], unavailable: true, reason: "no_playable_streams" };
  }

  const videoCodec = normalizeCodec(mediaInfo.videoCodec);
  const audioCodec = normalizeCodec(mediaInfo.audioCodec);
  const videoOk = !mediaInfo.hasVideo || BROWSER_VIDEO_CODECS.has(videoCodec);
  const audioOk = !mediaInfo.hasAudio || BROWSER_AUDIO_CODECS.has(audioCodec);
  const isHls =
    sourceInfo.isHls ?? (/\.m3u8(\?|#|$)/i.test(sourceInfo.url || "") || mediaInfo.protocol === "hls");
  const preferBackend = clientCapabilities.preferBackend ?? config.playbackMode === "backend_only";

  const profiles = [];

  if (!mediaInfo.hasVideo && mediaInfo.hasAudio) {
    if (audioOk && !preferBackend) profiles.push(Profile.DIRECT);
    if (audioOk) profiles.push(isHls ? Profile.HLS_PROXY : Profile.HTTP_PROXY);
    profiles.push(Profile.AUDIO_ONLY);
    return { profiles: dedupe(profiles), unavailable: false, isHls };
  }

  if (videoOk && audioOk) {
    // Container pode ainda exigir remux, mas codecs ja sao compativeis:
    // nao ha necessidade de cair para transcodificacao completa.
    if (!preferBackend) profiles.push(Profile.DIRECT);
    profiles.push(isHls ? Profile.HLS_PROXY : Profile.HTTP_PROXY);
    profiles.push(Profile.REMUX);
    return { profiles: dedupe(profiles), unavailable: false, isHls };
  }

  if (videoOk && !audioOk) {
    profiles.push(Profile.COPY_VIDEO_TRANSCODE_AUDIO);
  } else if (!videoOk && audioOk) {
    profiles.push(Profile.TRANSCODE_VIDEO_COPY_AUDIO);
  }

  profiles.push(Profile.TRANSCODE_ALL);

  return { profiles: dedupe(profiles), unavailable: false, isHls };
}

function normalizeCodec(codec) {
  return (codec || "").toLowerCase().trim();
}

function dedupe(list) {
  return [...new Set(list)];
}
