import { validateSourceUrl, UrlValidationError } from '../security/validateUrl.js';
import { fetchUpstream, forwardResponse } from './httpProxy.js';

/**
 * Proxy consciente de HLS: playlists (master ou media) sao reescritas para
 * que toda referencia (variantes, segmentos, chaves) volte a passar por esta
 * mesma rota; qualquer outro recurso (segmento .ts, chave, legenda) e
 * encaminhado como stream binario, preservando Range e status.
 */
export async function proxyHls(req, res, targetUrl, headers = {}, proxyBaseUrl) {
  let target;
  try {
    target = validateSourceUrl(targetUrl);
  } catch (err) {
    if (err instanceof UrlValidationError) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }

  const upstream = await fetchUpstream(req, target, headers);
  if (!upstream) {
    res.status(502).json({ error: 'Falha ao contatar a origem.', code: 'connection_refused' });
    return;
  }

  if (!upstream.ok && upstream.status !== 206) {
    res
      .status(upstream.status)
      .json({ error: `A origem respondeu ${upstream.status}.`, code: 'http_status' });
    return;
  }

  const contentType = upstream.headers.get('content-type') || '';
  const looksLikeManifest =
    /mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(target.pathname + target.search);

  if (!looksLikeManifest) {
    forwardResponse(upstream, res);
    return;
  }

  const body = await upstream.text();
  const rewritten = rewriteManifest(body, target, proxyBaseUrl);

  res.status(200);
  res.setHeader('content-type', 'application/vnd.apple.mpegurl');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('access-control-allow-origin', '*');
  res.send(rewritten);
}

// Toda URL do manifesto precisa voltar apontando para o proxy, senao o
// navegador busca variantes/segmentos direto na origem e o CORS volta a barrar.
function rewriteManifest(manifest, target, proxyBaseUrl) {
  const wrap = (value) =>
    proxyBaseUrl + '?url=' + encodeURIComponent(new URL(value, target).toString());

  return manifest
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => `URI="${wrap(uri)}"`);
      }

      return wrap(trimmed);
    })
    .join('\n');
}
