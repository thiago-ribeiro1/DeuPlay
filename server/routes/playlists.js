import { Router } from 'express';
import { config } from '../config.js';
import { parseM3U, M3uParseError } from '../services/m3uParser.js';
import { validateSourceUrl, UrlValidationError } from '../security/validateUrl.js';
import * as store from '../store.js';
import { logger } from '../utils/logger.js';

export const playlistsRouter = Router();

// POST /api/playlists/import  { sourceType: "url"|"text", url?, text?, name? }
// "text" cobre colar conteudo ou upload (o navegador le o arquivo e envia o texto), evitando multipart/multer.
playlistsRouter.post('/playlists/import', async (req, res) => {
  const { sourceType, url, text, name } = req.body || {};

  try {
    let content;
    let sourceRef;

    if (sourceType === 'url') {
      const target = validateSourceUrl(url);
      sourceRef = target.toString();
      const response = await fetch(target.toString());
      if (!response.ok) {
        return res.status(502).json({ error: `A origem respondeu HTTP ${response.status}.` });
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > config.maxPlaylistSizeBytes) {
        return res.status(413).json({ error: 'Playlist excede MAX_PLAYLIST_SIZE_BYTES.' });
      }
      content = buffer.toString('utf8');
    } else if (sourceType === 'text') {
      if (typeof text !== 'string' || !text.length) {
        return res.status(400).json({ error: 'Campo text ausente ou vazio.' });
      }
      if (Buffer.byteLength(text, 'utf8') > config.maxPlaylistSizeBytes) {
        return res.status(413).json({ error: 'Playlist excede MAX_PLAYLIST_SIZE_BYTES.' });
      }
      content = text;
      sourceRef = name || 'colado/upload';
    } else {
      return res.status(400).json({ error: 'sourceType deve ser "url" ou "text".' });
    }

    const parsed = parseM3U(content, { maxChannels: config.maxPlaylistChannels });
    const record = store.importPlaylist({ name, sourceType, sourceRef, parsed });

    res.status(201).json({
      id: record.id,
      name: record.name,
      channelCount: record.channelIds.length,
      duplicates: record.duplicates,
      warnings: record.warnings,
      epgUrl: record.epgUrl,
    });
  } catch (err) {
    if (err instanceof M3uParseError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof UrlValidationError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    logger.error('playlist_import_failed', { error: err.message });
    res.status(500).json({ error: 'Falha inesperada ao importar a playlist.' });
  }
});

playlistsRouter.get('/playlists', (req, res) => {
  res.json(store.listPlaylists());
});

playlistsRouter.get('/playlists/:id/channels', (req, res) => {
  const channels = store.listChannelsForPlaylist(req.params.id);
  if (!channels) return res.status(404).json({ error: 'Playlist nao encontrada.' });
  res.json(channels);
});
