import { spawn } from "node:child_process";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// Perfis candidatos em ordem de preferencia; cada um mapeia para o encoder
// FFmpeg equivalente. libx264 (software) e sempre o fallback final.
const CANDIDATES = [
  { id: "h264_nvenc", vendor: "NVIDIA NVENC" },
  { id: "h264_qsv", vendor: "Intel Quick Sync" },
  { id: "h264_vaapi", vendor: "VAAPI" },
  { id: "h264_videotoolbox", vendor: "Apple VideoToolbox" },
  { id: "h264_amf", vendor: "AMD AMF" },
];

let cachedEncoder = null;

/**
 * Detecta o melhor encoder H.264 disponivel. Em HARDWARE_ACCELERATION=off
 * ou quando nenhum encoder de hardware funciona, retorna libx264 (software).
 * Nunca lanca excecao: se ffmpeg estiver ausente, retorna libx264 mesmo assim
 * (a ausencia real do binario e reportada pelo processManager ao tentar usar).
 */
export async function detectEncoder() {
  if (cachedEncoder) return cachedEncoder;

  if (config.hardwareAcceleration === "off") {
    cachedEncoder = { encoder: "libx264", hardware: false, vendor: "software" };
    return cachedEncoder;
  }

  const available = await listAvailableEncoders();
  if (!available) {
    cachedEncoder = { encoder: "libx264", hardware: false, vendor: "software" };
    return cachedEncoder;
  }

  for (const candidate of CANDIDATES) {
    if (!available.has(candidate.id)) continue;
    const works = await testEncoder(candidate.id);
    if (works) {
      logger.info("hardware_encoder_selected", { encoder: candidate.id, vendor: candidate.vendor });
      cachedEncoder = { encoder: candidate.id, hardware: true, vendor: candidate.vendor };
      return cachedEncoder;
    }
  }

  cachedEncoder = { encoder: "libx264", hardware: false, vendor: "software" };
  return cachedEncoder;
}

function listAvailableEncoders() {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(config.ffmpegPath, ["-hide_banner", "-encoders"], { shell: false });
    } catch {
      resolve(null);
      return;
    }
    let stdout = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const found = new Set();
      for (const candidate of CANDIDATES) {
        if (stdout.includes(candidate.id)) found.add(candidate.id);
      }
      resolve(found);
    });
  });
}

// Encode curtissimo (1 frame sintetico) so para confirmar que o encoder
// realmente inicializa nesta maquina (driver presente, licenca ok etc).
function testEncoder(encoderId) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(
        config.ffmpegPath,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=black:s=64x64:d=0.1",
          "-frames:v",
          "1",
          "-c:v",
          encoderId,
          "-f",
          "null",
          "-",
        ],
        { shell: false }
      );
    } catch {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(false);
    }, 5000);

    proc.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export function resetEncoderCacheForTests() {
  cachedEncoder = null;
}
