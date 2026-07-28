import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, assertValidConfig } from "./config.js";
import { logger } from "./utils/logger.js";
import { wipeStreamsOnBoot } from "./services/cleanup.js";
import { checkFfmpegAvailable, startIdleSweep } from "./services/processManager.js";
import { checkFfprobeAvailable } from "./services/probeService.js";
import { startSessionSweep } from "./store.js";

import { healthRouter } from "./routes/health.js";
import { playlistsRouter } from "./routes/playlists.js";
import { channelsRouter } from "./routes/channels.js";
import { playbackRouter } from "./routes/playback.js";
import { streamsRouter } from "./routes/streams.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

assertValidConfig();

export const app = express();

app.use(express.json({ limit: "2mb" }));

app.get("/api/config", (req, res) => {
  res.json({ playbackMode: config.playbackMode });
});

app.use("/api", healthRouter);
app.use("/api", playlistsRouter);
app.use("/api", channelsRouter);
app.use("/api", playbackRouter);
app.use("/api", streamsRouter);

app.get("/admin", (req, res) => {
  res.sendFile(path.join(publicDir, "admin.html"));
});

// Bloqueia listagem de diretorio e nao expoe arquivos fora de public/.
app.use(express.static(publicDir, { index: "index.html", redirect: false }));

app.use((req, res) => {
  res.status(404).json({ error: "Rota nao encontrada." });
});

app.use((err, req, res, next) => {
  logger.error("unhandled_request_error", { error: err.message, path: req.path });
  if (res.headersSent) return;
  res.status(500).json({ error: "Erro interno do servidor." });
});

export async function start() {
  await wipeStreamsOnBoot();

  const [ffmpeg, ffprobe] = await Promise.all([checkFfmpegAvailable(), checkFfprobeAvailable()]);
  if (!ffmpeg) {
    logger.warn("startup_warning", {
      message: `FFmpeg nao encontrado em "${config.ffmpegPath}". Remux e transcodificacao ficarao indisponiveis ate instalar o FFmpeg e/ou configurar FFMPEG_PATH.`,
    });
  }
  if (!ffprobe) {
    logger.warn("startup_warning", {
      message: `ffprobe nao encontrado em "${config.ffprobePath}". Inspecao de midia ficara indisponivel ate instalar o FFmpeg (inclui ffprobe) e/ou configurar FFPROBE_PATH.`,
    });
  }

  startIdleSweep();
  startSessionSweep();

  return new Promise((resolve) => {
    const server = app.listen(config.port, config.host, () => {
      logger.info("server_started", { port: config.port, host: config.host, ffmpeg, ffprobe });
      resolve(server);
    });
  });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  start().catch((err) => {
    logger.error("startup_failed", { error: err.message });
    process.exit(1);
  });
}
