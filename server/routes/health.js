import { Router } from "express";
import { config } from "../config.js";
import { checkFfmpegAvailable, listProcesses } from "../services/processManager.js";
import { checkFfprobeAvailable } from "../services/probeService.js";
import { getStreamsDiskUsageBytes } from "../services/cleanup.js";

export const healthRouter = Router();

const bootedAt = Date.now();

healthRouter.get("/health", async (req, res) => {
  const [ffmpeg, ffprobe] = await Promise.all([checkFfmpegAvailable(), checkFfprobeAvailable()]);
  const processes = listProcesses();

  res.json({
    status: ffmpeg && ffprobe ? "ok" : "degraded",
    uptimeSec: Math.round((Date.now() - bootedAt) / 1000),
    node: process.version,
    ffmpegAvailable: ffmpeg,
    ffprobeAvailable: ffprobe,
    playbackMode: config.playbackMode,
    activeStreams: processes.filter((p) => p.status === "ready" || p.status === "degraded").length,
    maxActiveStreams: config.maxActiveStreams,
    diskUsageBytes: getStreamsDiskUsageBytes(),
    warnings: [
      !ffmpeg ? "FFmpeg nao encontrado (FFMPEG_PATH=" + config.ffmpegPath + "). Remux/transcodificacao indisponiveis." : null,
      !ffprobe ? "ffprobe nao encontrado (FFPROBE_PATH=" + config.ffprobePath + "). Inspecao de midia indisponivel." : null,
    ].filter(Boolean),
  });
});
