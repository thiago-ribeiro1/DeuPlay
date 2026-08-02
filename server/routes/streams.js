import { Router } from 'express';
import * as processManager from '../services/processManager.js';
import * as store from '../store.js';

export const streamsRouter = Router();

// Estrategias servidas sem FFmpeg: nao existe processo para elas, entao o
// painel precisa monta-las a partir das sessoes ativas.
const PROCESSLESS_STRATEGIES = new Set(['direct', 'http_proxy', 'hls_proxy']);

streamsRouter.get('/streams', (req, res) => {
  const processes = processManager.listProcesses().map((proc) => {
    const channel = store.getChannel(proc.channelId);
    return {
      ...proc,
      channelName: channel?.name,
      channelGroup: channel?.group,
      kind: 'process',
    };
  });

  const covered = new Set(processes.map((proc) => proc.key));

  const sessions = store
    .listSessions()
    .filter(
      (session) =>
        session.status === 'ready' &&
        !session.processKey &&
        PROCESSLESS_STRATEGIES.has(session.strategy)
    )
    .map((session) => {
      const channel = store.getChannel(session.channelId);
      return {
        key: `session:${session.id}`,
        kind: 'session',
        sessionId: session.id,
        channelId: session.channelId,
        channelName: channel?.name,
        channelGroup: channel?.group,
        mode: session.strategy,
        status: 'ready',
        viewers: 1,
        pid: undefined,
        startedAt: session.startedAt,
        lastError: undefined,
        mediaInfo: session.mediaInfo,
      };
    })
    .filter((entry) => !covered.has(entry.key));

  res.json([...processes, ...sessions]);
});

streamsRouter.get('/streams/:key/logs', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  if (key.startsWith('session:')) {
    return res.json({
      key,
      lines: ['Reproducao sem FFmpeg (proxy/direto): nao ha log de processo.'],
    });
  }
  res.json({ key, lines: processManager.getLogs(key) });
});

streamsRouter.post('/streams/:key/restart', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  if (key.startsWith('session:')) {
    return res.status(409).json({ error: 'Sessoes sem FFmpeg nao podem ser reiniciadas.' });
  }
  const ok = processManager.forceRestart(key);
  if (!ok) return res.status(404).json({ error: 'Processo nao encontrado.' });
  res.json({ ok: true });
});

streamsRouter.post('/streams/:key/stop', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  if (key.startsWith('session:')) {
    const removed = store.deleteSession(key.slice('session:'.length));
    if (!removed) return res.status(404).json({ error: 'Sessao nao encontrada.' });
    return res.json({ ok: true });
  }
  const ok = processManager.stopProcess(key, 'admin_stop');
  if (!ok) return res.status(404).json({ error: 'Processo nao encontrado.' });
  res.json({ ok: true });
});
