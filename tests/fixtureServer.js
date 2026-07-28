import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const MEDIA_CONTENT_TYPES = {
  ".mp4": "video/mp4",
  ".ts": "video/mp2t",
  ".flac": "audio/flac",
  ".mp3": "audio/mpeg",
};

/**
 * Servidor HTTP minimo para testes de proxy/HLS sem depender de canais
 * externos: cobre resposta ok, 404, 500, lenta, redirect, playlist HLS
 * valida/invalida e um "segmento" binario.
 */
export function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/ok.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("conteudo de teste");
      return;
    }

    if (url.pathname === "/404") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    if (url.pathname === "/500") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("server error");
      return;
    }

    if (url.pathname === "/slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("demorou mas respondeu");
      }, 300);
      return;
    }

    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: "/ok.txt" });
      res.end();
      return;
    }

    if (url.pathname === "/playlist.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end(
        [
          "#EXTM3U",
          "#EXT-X-VERSION:3",
          "#EXT-X-TARGETDURATION:4",
          "#EXTINF:4.0,",
          "segment0.ts",
          "#EXT-X-ENDLIST",
        ].join("\n")
      );
      return;
    }

    if (url.pathname === "/playlist-invalid.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end("isso nao e uma playlist valida");
      return;
    }

    if (url.pathname === "/segment0.ts") {
      res.writeHead(200, { "content-type": "video/mp2t" });
      res.end(Buffer.from([0x47, 0x00, 0x00, 0x10, 0x00, 0x00]));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * Servidor HTTP que serve os arquivos de midia REAIS gerados por FFmpeg
 * (ver generateFixtures.js) a partir de um diretorio, com Content-Type
 * correto por extensao. Usado pelo teste fim-a-fim para nao depender de
 * nenhum canal IPTV externo.
 */
export function startMediaFixtureServer(dir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const filePath = path.join(dir, path.basename(url.pathname));

    if (!filePath.startsWith(dir) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const contentType = MEDIA_CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "content-type": contentType, "content-length": fs.statSync(filePath).size });
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}
