import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as store from '../store.js';
import * as processManager from '../services/processManager.js';
import { proxyHttp } from '../services/httpProxy.js';
import { proxyHls } from '../services/hlsProxy.js';
import { Profile } from '../services/strategy.js';

export const playbackRouter = Router();

function loadSessionOr404(req, res) {
  const session = store.getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'Sessao nao encontrada ou expirada.' });
    return null;
  }
  return session;
}

playbackRouter.get('/playback/:sessionId/status', (req, res) => {
  const session = loadSessionOr404(req, res);
  if (!session) return;

  let processInfo;
  if (session.processKey) processInfo = processManager.getProcess(session.processKey);

  res.json({
    sessionId: session.id,
    channelId: session.channelId,
    status: session.status,
    strategy: session.strategy,
    playbackUrl: session.playbackUrl,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    process: processInfo
      ? {
          status: processInfo.status,
          viewers: processInfo.viewers,
          lastError: processInfo.lastError,
        }
      : undefined,
  });
});

playbackRouter.post('/playback/:sessionId/heartbeat', (req, res) => {
  const session = store.heartbeatSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Sessao nao encontrada ou expirada.' });
  res.json({ ok: true, expiresAt: session.expiresAt });
});

playbackRouter.delete('/playback/:sessionId', (req, res) => {
  const removed = store.deleteSession(req.params.sessionId);
  if (!removed) return res.status(404).json({ error: 'Sessao nao encontrada.' });
  res.status(204).end();
});

// Alias POST: navigator.sendBeacon so envia POST, usado ao fechar a aba.
playbackRouter.post('/playback/:sessionId/stop', (req, res) => {
  store.deleteSession(req.params.sessionId);
  res.status(204).end();
});

playbackRouter.get('/playback/:sessionId/index.m3u8', async (req, res) => {
  const session = loadSessionOr404(req, res);
  if (!session) return;
  const channel = store.getChannel(session.channelId);
  if (!channel) return res.status(404).json({ error: 'Canal associado nao existe mais.' });

  if (session.strategy === Profile.HLS_PROXY) {
    const proxyBase = `/api/playback/${session.id}/hlsproxy`;
    await proxyHls(req, res, channel.sourceUrl, channel.sourceHeaders || {}, proxyBase);
    return;
  }

  if (!session.processKey) {
    return res.status(409).json({ error: 'Sessao nao possui saida HLS local.' });
  }
  const proc = processManager.getProcess(session.processKey);
  if (!proc || !['ready', 'degraded'].includes(proc.status)) {
    return res.status(503).json({ error: 'Stream ainda nao esta pronto.', status: proc?.status });
  }

  const playlistPath = path.join(proc.outputDirectory, 'index.m3u8');
  try {
    const content = await fs.readFile(playlistPath, 'utf8');
    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    res.setHeader('cache-control', 'no-store');
    res.send(content);
  } catch {
    res.status(503).json({ error: 'Playlist ainda nao disponivel.' });
  }
});

playbackRouter.get('/playback/:sessionId/hlsproxy', async (req, res) => {
  const session = loadSessionOr404(req, res);
  if (!session) return;
  const channel = store.getChannel(session.channelId);
  if (!channel) return res.status(404).json({ error: 'Canal associado nao existe mais.' });

  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'Parametro url ausente.' });

  const proxyBase = `/api/playback/${session.id}/hlsproxy`;
  await proxyHls(req, res, target, channel.sourceHeaders || {}, proxyBase);
});

playbackRouter.get('/playback/:sessionId/proxy', async (req, res) => {
  const session = loadSessionOr404(req, res);
  if (!session) return;
  const channel = store.getChannel(session.channelId);
  if (!channel) return res.status(404).json({ error: 'Canal associado nao existe mais.' });

  await proxyHttp(req, res, channel.sourceUrl, channel.sourceHeaders || {});
});

// Segmentos gerados localmente pelo FFmpeg. Nome restrito por regex: nada de
// path traversal, apenas o padrao gerado por -hls_segment_filename.
playbackRouter.get('/playback/:sessionId/:segment(segment_[0-9]+\\.ts)', async (req, res) => {
  const session = loadSessionOr404(req, res);
  if (!session) return;
  if (!session.processKey) return res.status(404).json({ error: 'Segmento nao encontrado.' });

  const proc = processManager.getProcess(session.processKey);
  if (!proc) return res.status(404).json({ error: 'Stream nao encontrado.' });

  const segmentPath = path.join(proc.outputDirectory, req.params.segment);
  res.setHeader('content-type', 'video/mp2t');
  res.setHeader('cache-control', 'public, max-age=6');
  res.sendFile(segmentPath, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Segmento nao encontrado.' });
  });
});
