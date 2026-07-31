import { Router } from 'express';
import * as processManager from '../services/processManager.js';
import * as store from '../store.js';

export const streamsRouter = Router();

streamsRouter.get('/streams', (req, res) => {
  const enriched = processManager.listProcesses().map((proc) => {
    const channel = store.getChannel(proc.channelId);
    return {
      ...proc,
      channelName: channel?.name,
      channelGroup: channel?.group,
    };
  });
  res.json(enriched);
});

streamsRouter.get('/streams/:key/logs', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  res.json({ key, lines: processManager.getLogs(key) });
});

streamsRouter.post('/streams/:key/restart', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const ok = processManager.forceRestart(key);
  if (!ok) return res.status(404).json({ error: 'Processo nao encontrado.' });
  res.json({ ok: true });
});

streamsRouter.post('/streams/:key/stop', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const ok = processManager.stopProcess(key, 'admin_stop');
  if (!ok) return res.status(404).json({ error: 'Processo nao encontrado.' });
  res.json({ ok: true });
});
