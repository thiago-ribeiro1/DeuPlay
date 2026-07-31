import { probeSource } from './probeService.js';
import { decidePlaybackStrategy, Profile } from './strategy.js';
import { describeCode } from './diagnostics.js';
import * as processManager from './processManager.js';
import { logger } from '../utils/logger.js';
import { validateSourceUrl, UrlValidationError } from '../security/validateUrl.js';

const FFMPEG_PROFILES = new Set([
  Profile.REMUX,
  Profile.COPY_VIDEO_TRANSCODE_AUDIO,
  Profile.TRANSCODE_VIDEO_COPY_AUDIO,
  Profile.TRANSCODE_ALL,
  Profile.AUDIO_ONLY,
]);

// Mostra host+caminho para debug, sem vazar query string (tokens, chaves de
// sessao) nos logs do terminal.
function maskUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return '***';
  }
}

/**
 * Ponto central de decisao: sonda a origem, decide a cadeia de estrategias e
 * tenta cada uma em ordem ate obter uma reproduzivel, sem repetir
 * estrategias equivalentes.
 *
 * @param {import("./m3uParser.js").Channel} channel
 * @param {{ sessionId: string, viewerId: string, forceProfile?: string }} ctx
 */
export async function resolvePlayback(channel, ctx) {
  const headers = channel.sourceHeaders || {};
  const maskedUrl = maskUrl(channel.sourceUrl);

  logger.info('playback_resolve_start', {
    channelId: channel.id,
    sourceUrl: maskedUrl,
    sessionId: ctx.sessionId,
  });

  // Revalidado aqui (nao so na importacao): canais registrados via texto
  // colado/upload nao passam por filtro de protocolo/host, entao esta e a
  // unica barreira central contra SSRF antes do probe/proxy/ffmpeg.
  try {
    validateSourceUrl(channel.sourceUrl);
  } catch (err) {
    if (err instanceof UrlValidationError) {
      logger.warn('playback_url_rejected', {
        channelId: channel.id,
        sourceUrl: maskedUrl,
        code: err.code,
      });
      return {
        status: 'failed',
        mediaInfo: {
          reachable: false,
          hasVideo: false,
          hasAudio: false,
          probeDurationMs: 0,
          errors: [err.code],
        },
        attemptedProfiles: [],
        reason: err.code,
        diagnosticMessage: err.message,
      };
    }
    throw err;
  }

  const mediaInfo = await probeSource(channel.sourceUrl, { headers });
  logger.info('ffprobe_result', {
    channelId: channel.id,
    reachable: mediaInfo.reachable,
    videoCodec: mediaInfo.videoCodec,
    audioCodec: mediaInfo.audioCodec,
    resolution: mediaInfo.width ? `${mediaInfo.width}x${mediaInfo.height}` : undefined,
    errorCode: mediaInfo.errorCode,
    probeDurationMs: mediaInfo.probeDurationMs,
  });

  if (ctx.forceProfile) {
    logger.info('strategy_forced', { channelId: channel.id, profile: ctx.forceProfile });
    const result = await tryProfile(ctx.forceProfile, channel, mediaInfo, ctx, [ctx.forceProfile]);
    logger.info('playback_resolved', {
      channelId: channel.id,
      status: result.status,
      strategy: result.strategy,
    });
    return result;
  }

  const decision = decidePlaybackStrategy(mediaInfo, { url: channel.sourceUrl }, {});
  logger.info('strategy_decided', {
    channelId: channel.id,
    profiles: decision.profiles,
    unavailable: decision.unavailable,
  });
  const attempted = [];

  if (decision.unavailable) {
    logger.warn('playback_unavailable', { channelId: channel.id, reason: decision.reason });
    return {
      status: 'failed',
      mediaInfo,
      attemptedProfiles: attempted,
      reason: decision.reason,
      diagnosticMessage: describeCode(decision.reason),
    };
  }

  for (const profile of decision.profiles) {
    attempted.push(profile);
    logger.info('strategy_attempt', {
      channelId: channel.id,
      profile,
      attemptNumber: attempted.length,
      of: decision.profiles.length,
    });
    const result = await tryProfile(profile, channel, mediaInfo, ctx, attempted);
    if (result.status === 'ready') {
      logger.info('playback_resolved', {
        channelId: channel.id,
        status: 'ready',
        strategy: result.strategy,
        attemptedProfiles: attempted,
      });
      return result;
    }
    logger.warn('strategy_failed', { channelId: channel.id, profile, reason: result.reason });
  }

  logger.warn('playback_resolved', {
    channelId: channel.id,
    status: 'failed',
    attemptedProfiles: attempted,
  });
  return {
    status: 'failed',
    mediaInfo,
    attemptedProfiles: attempted,
    reason: 'all_strategies_failed',
    diagnosticMessage: 'Nenhuma das estrategias disponiveis conseguiu reproduzir esta origem.',
  };
}

async function tryProfile(profile, channel, mediaInfo, ctx, attempted) {
  const headers = channel.sourceHeaders || {};

  if (profile === Profile.DIRECT) {
    return {
      status: 'ready',
      strategy: Profile.DIRECT,
      playbackUrl: channel.sourceUrl,
      mediaInfo,
      attemptedProfiles: attempted,
    };
  }

  if (profile === Profile.HTTP_PROXY) {
    return {
      status: 'ready',
      strategy: Profile.HTTP_PROXY,
      playbackUrl: `/api/playback/${ctx.sessionId}/proxy`,
      mediaInfo,
      attemptedProfiles: attempted,
    };
  }

  if (profile === Profile.HLS_PROXY) {
    return {
      status: 'ready',
      strategy: Profile.HLS_PROXY,
      playbackUrl: `/api/playback/${ctx.sessionId}/index.m3u8`,
      mediaInfo,
      attemptedProfiles: attempted,
    };
  }

  if (FFMPEG_PROFILES.has(profile)) {
    const proc = await processManager.startOrJoin(channel.id, profile, {
      inputUrl: channel.sourceUrl,
      headers,
      mediaInfo,
      viewerId: ctx.viewerId,
    });

    if (proc.status === 'ready') {
      return {
        status: 'ready',
        strategy: profile,
        playbackUrl: `/api/playback/${ctx.sessionId}/index.m3u8`,
        processKey: proc.key,
        mediaInfo,
        attemptedProfiles: attempted,
      };
    }

    return {
      status: 'failed',
      mediaInfo,
      attemptedProfiles: attempted,
      reason: proc.lastError || 'ffmpeg_failed',
      diagnosticMessage: proc.lastError,
    };
  }

  return {
    status: 'failed',
    mediaInfo,
    attemptedProfiles: attempted,
    reason: 'unknown_profile',
    diagnosticMessage: `Perfil desconhecido: ${profile}`,
  };
}
