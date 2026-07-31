import { Router } from 'express';
import { probeSource } from '../services/probeService.js';
import { resolvePlayback } from '../services/playbackOrchestrator.js';
import { validateSourceUrl, UrlValidationError } from '../security/validateUrl.js';
import * as store from '../store.js';
import { newId } from '../utils/ids.js';
import { logger } from '../utils/logger.js';

export const channelsRouter = Router();

channelsRouter.post('/channels/:id/probe', async (req, res) => {
  const channel = store.getChannel(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Canal nao encontrado.' });

  const mediaInfo = await probeSource(channel.sourceUrl, { headers: channel.sourceHeaders || {} });
  res.json(mediaInfo);
});

channelsRouter.post('/channels/:id/playback', async (req, res) => {
  const channel = store.getChannel(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Canal nao encontrado.' });
  await handlePlayback(req, res, channel);
});

// Fluxo usado pelo player: o canal ainda nao precisa existir no store, o
// proprio pedido de reproducao registra a origem.
channelsRouter.post('/channels/playback', async (req, res) => {
  const { name, url, headers, id } = req.body || {};
  try {
    validateSourceUrl(url);
  } catch (err) {
    if (err instanceof UrlValidationError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const channel = store.upsertAdHocChannel({ name, sourceUrl: url, sourceHeaders: headers, id });
  await handlePlayback(req, res, channel);
});

async function handlePlayback(req, res, channel) {
  const viewerId = (req.body && req.body.viewerId) || newId();
  const session = store.createSession({
    channelId: channel.id,
    viewerId,
    status: 'preparing',
  });

  try {
    const result = await resolvePlayback(channel, {
      sessionId: session.id,
      viewerId,
      forceProfile: (req.body && req.body.forceProfile) || undefined,
    });

    store.updateSession(session.id, {
      status: result.status === 'ready' ? 'ready' : 'failed',
      strategy: result.strategy,
      playbackUrl: result.playbackUrl,
      processKey: result.processKey,
    });

    if (result.status !== 'ready') {
      return res.status(502).json({
        sessionId: session.id,
        status: 'failed',
        channelId: channel.id,
        attemptedProfiles: result.attemptedProfiles,
        reason: result.reason,
        diagnosticMessage: result.diagnosticMessage,
        mediaInfo: result.mediaInfo,
      });
    }

    res.json({
      sessionId: session.id,
      channelId: channel.id,
      status: 'ready',
      strategy: result.strategy,
      playbackUrl: result.playbackUrl,
      attemptedProfiles: result.attemptedProfiles,
      mediaInfo: result.mediaInfo,
    });
  } catch (err) {
    logger.error('playback_resolution_failed', { channelId: channel.id, error: err.message });
    store.updateSession(session.id, { status: 'failed' });
    res
      .status(500)
      .json({
        sessionId: session.id,
        status: 'failed',
        error: 'Falha interna ao preparar a reproducao.',
      });
  }
}
