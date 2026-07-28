import { Readable } from "node:stream";
import { validateSourceUrl, UrlValidationError } from "../security/validateUrl.js";
import { logger } from "../utils/logger.js";

const PASSTHROUGH_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges"];

/**
 * Encaminha uma requisicao HTTP para a origem em chunks, com backpressure via
 * streams nativos, suporte a Range, e cancelamento da origem quando o
 * cliente desconecta.
 */
export async function proxyHttp(req, res, targetUrl, headers = {}) {
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
    if (!res.headersSent) {
      res.status(502).json({ error: "Falha ao contatar a origem.", code: "connection_refused" });
    }
    return;
  }

  if (!upstream.ok && upstream.status !== 206) {
    res.status(upstream.status).json({
      error: `A origem respondeu ${upstream.status}.`,
      code: "http_status",
    });
    return;
  }

  forwardResponse(upstream, res);
}

export async function fetchUpstream(req, target, headers = {}) {
  const forwardHeaders = new Headers();
  if (req?.headers?.range) forwardHeaders.set("range", req.headers.range);
  forwardHeaders.set("user-agent", headers["User-Agent"] || req?.headers?.["user-agent"] || "Mozilla/5.0");
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "user-agent") continue;
    forwardHeaders.set(key, value);
  }

  const controller = new AbortController();
  req?.on?.("close", () => controller.abort());

  try {
    return await fetch(target.toString(), {
      headers: forwardHeaders,
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (err) {
    logger.warn("proxy_upstream_failed", { url: target.toString(), error: err.message });
    return null;
  }
}

export function forwardResponse(upstream, res) {
  res.status(upstream.status);
  for (const header of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  res.setHeader("cache-control", "no-store");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "Range,Content-Type");

  if (!upstream.body) {
    res.end();
    return;
  }

  const nodeStream = Readable.fromWeb(upstream.body);
  nodeStream.on("error", () => {
    if (!res.writableEnded) res.end();
  });
  res.on("close", () => {
    if (!nodeStream.destroyed) nodeStream.destroy();
  });
  nodeStream.pipe(res);
}
