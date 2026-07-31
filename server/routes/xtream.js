import { Router } from 'express';
import { config } from '../config.js';
import {
  parseXtreamInput,
  authenticate,
  importLiveCatalog,
  XtreamError,
} from '../services/xtreamClient.js';
import { validateSourceUrl, UrlValidationError } from '../security/validateUrl.js';
import {
  saveCredentials,
  loadCredentials,
  describeCredentials,
  clearCredentials,
  DecryptError,
} from '../services/credentialStore.js';
import * as store from '../store.js';
import { logger } from '../utils/logger.js';

export const xtreamRouter = Router();

// POST /api/xtream/import  { host, username, password, name? }
// Devolve o mesmo contrato de /api/playlists/import para o frontend
// reaproveitar o caminho de renderizacao ja existente.
xtreamRouter.post('/xtream/import', async (req, res) => {
  const { host, username, password, name, remember, useSaved, passphrase } = req.body || {};

  try {
    // useSaved: o frontend nunca precisou receber a senha de volta.
    let input = { host, username, password };
    if (useSaved) {
      if (!passphrase) {
        return res
          .status(400)
          .json({ error: 'Informe a senha de protecao.', code: 'passphrase_required' });
      }
      const saved = await loadCredentials(passphrase);
      if (!saved) {
        return res.status(404).json({ error: 'Nenhuma credencial salva.', code: 'no_saved' });
      }
      input = saved;
    }

    if (remember && !useSaved && !passphrase) {
      return res.status(400).json({
        error: 'Para salvar as credenciais, defina uma senha de protecao.',
        code: 'passphrase_required',
      });
    }

    const credentials = parseXtreamInput(input.host, input.username, input.password);

    let account;
    let baseUrl;
    let lastError;

    for (const candidate of credentials.baseUrlCandidates) {
      try {
        // Mesma protecao contra SSRF aplicada as URLs de playlist.
        validateSourceUrl(candidate);
        account = await authenticate(candidate, credentials.username, credentials.password);
        baseUrl = candidate;
        break;
      } catch (err) {
        lastError = err;
        // Credencial recusada e conta inativa sao respostas do painel: ele
        // esta acessivel, entao trocar de protocolo nao muda nada.
        if (err instanceof XtreamError && ['unauthorized', 'account_inactive'].includes(err.code)) {
          throw err;
        }
      }
    }

    if (!account) throw lastError;

    const parsed = await importLiveCatalog({
      baseUrl,
      username: credentials.username,
      password: credentials.password,
      account,
      maxChannels: config.maxPlaylistChannels,
    });

    if (!parsed.channels.length) {
      return res.status(502).json({
        error: 'O painel autenticou, mas nao devolveu nenhum canal ao vivo.',
        code: 'empty_catalog',
      });
    }

    const record = store.importPlaylist({
      name: name || hostLabel(baseUrl),
      sourceType: 'xtream',
      // sourceRef nunca guarda credencial: o registro fica visivel na API.
      sourceRef: baseUrl,
      parsed,
    });

    if (remember && !useSaved) {
      await saveCredentials(
        { host: baseUrl, username: credentials.username, password: credentials.password },
        passphrase
      );
    }

    logger.info('xtream_imported', {
      playlistId: record.id,
      channels: record.channelIds.length,
      host: hostLabel(baseUrl),
      expiresAt: account.expiresAt,
    });

    res.status(201).json({
      id: record.id,
      name: record.name,
      channelCount: record.channelIds.length,
      duplicates: record.duplicates,
      warnings: record.warnings,
      epgUrl: record.epgUrl,
      account: {
        status: account.status,
        isTrial: account.isTrial,
        expiresAt: account.expiresAt,
        activeConnections: account.activeConnections,
        maxConnections: account.maxConnections,
        allowedFormats: account.allowedFormats,
      },
    });
  } catch (err) {
    if (err instanceof DecryptError) {
      return res.status(401).json({ error: err.message, code: 'bad_passphrase' });
    }
    if (err instanceof XtreamError) {
      const status = err.code === 'unauthorized' || err.code === 'account_inactive' ? 401 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    if (err instanceof UrlValidationError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    logger.error('xtream_import_failed', { error: err.message });
    res.status(500).json({ error: 'Falha inesperada ao importar o painel Xtream.' });
  }
});

xtreamRouter.get('/xtream/saved', async (req, res) => {
  res.json(await describeCredentials());
});

xtreamRouter.delete('/xtream/saved', async (req, res) => {
  const removed = await clearCredentials();
  res.json({ removed });
});

function hostLabel(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'Painel Xtream';
  }
}
