export const config = { runtime: "edge" };

const ALLOWED_ORIGINS = (process.env.PROXY_ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const BLOCKED_HOSTS =
  /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Range,Content-Type",
  "Access-Control-Expose-Headers": "Content-Length,Content-Range,Accept-Ranges",
};

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const requestUrl = new URL(request.url);
  const raw = requestUrl.searchParams.get("url");

  if (!raw) return fail(400, "Parâmetro url ausente.");

  let target;
  try {
    target = new URL(raw);
  } catch {
    return fail(400, "URL inválida.");
  }

  if (!/^https?:$/.test(target.protocol)) return fail(400, "Protocolo não permitido.");
  if (BLOCKED_HOSTS.test(target.hostname)) return fail(403, "Destino não permitido.");

  if (ALLOWED_ORIGINS.length) {
    const origin = request.headers.get("origin");
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return fail(403, "Origem não permitida.");
  }

  const forwarded = new Headers();
  const range = request.headers.get("range");
  if (range) forwarded.set("range", range);
  forwarded.set("user-agent", request.headers.get("user-agent") || "Mozilla/5.0");
  forwarded.set("referer", target.origin + "/");

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      headers: forwarded,
      redirect: "follow",
    });
  } catch {
    return fail(502, "Falha ao contatar a origem.");
  }

  if (!upstream.ok && upstream.status !== 206) {
    return fail(upstream.status, "A origem respondeu " + upstream.status + ".");
  }

  const contentType = upstream.headers.get("content-type") || "";
  const looksLikeManifest =
    /mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(target.pathname + target.search);

  if (looksLikeManifest) {
    const body = await upstream.text();
    const base = proxyBase(requestUrl);
    return new Response(rewriteManifest(body, target, base), {
      status: 200,
      headers: {
        ...CORS,
        "content-type": "application/vnd.apple.mpegurl",
        "cache-control": "no-store",
      },
    });
  }

  const headers = new Headers(CORS);
  ["content-type", "content-length", "content-range", "accept-ranges"].forEach((key) => {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  });
  headers.set("cache-control", "public, max-age=10");

  return new Response(upstream.body, { status: upstream.status, headers });
}

// Toda URL do manifesto precisa voltar apontando para o proxy, senão o
// navegador busca os segmentos direto na origem e o CORS volta a barrar.
function rewriteManifest(manifest, target, base) {
  const wrap = (value) => base + encodeURIComponent(new URL(value, target).toString());

  return manifest
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#")) {
        return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => 'URI="' + wrap(uri) + '"');
      }

      return wrap(trimmed);
    })
    .join("\n");
}

function proxyBase(requestUrl) {
  return requestUrl.origin + requestUrl.pathname + "?url=";
}

function fail(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}
