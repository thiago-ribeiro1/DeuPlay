import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Gera fixtures de midia REAIS com FFmpeg (sem mocks) para os testes fim-a-fim.
 * Cobre os 6 casos pedidos: compativel, audio incompativel, video
 * incompativel, sem audio, sem video e MPEG-TS.
 */
export function generateFixtures(ffmpegPath, outputDir, { duration = 4 } = {}) {
  fs.mkdirSync(outputDir, { recursive: true });

  const fps = 15;
  const testsrc = `testsrc=size=320x240:rate=${fps}:duration=${duration}`;
  const sine = `sine=frequency=880:duration=${duration}`;

  // HLS so pode cortar um segmento em um keyframe. Qualquer fonte de
  // broadcast/IPTV real usa keyframes frequentes de proposito para permitir
  // segmentacao e channel-surfing; sem isso, "-c:v copy" (remux) fica preso
  // ao GOP longo padrao do encoder (as vezes so 1 keyframe no arquivo
  // inteiro) e nao produz segmento nenhum ate o fim do arquivo. -g/-keyint_min
  // 1s + -sc_threshold 0 (desliga deteccao adaptativa de corte de cena)
  // reproduz esse comportamento realista nas fixtures H.264.
  const gopArgs = ["-g", String(fps), "-keyint_min", String(fps), "-sc_threshold", "0"];

  const specs = [
    {
      // 1) H.264 + AAC em MP4: ja compativel com o navegador.
      file: "h264_aac.mp4",
      args: [
        "-f", "lavfi", "-i", testsrc,
        "-f", "lavfi", "-i", sine,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...gopArgs,
        "-c:a", "aac", "-shortest",
      ],
    },
    {
      // 2) H.264 + AC-3: video ok, audio precisa de conversao para AAC.
      file: "h264_ac3.ts",
      args: [
        "-f", "lavfi", "-i", testsrc,
        "-f", "lavfi", "-i", sine,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...gopArgs,
        "-c:a", "ac3", "-shortest", "-f", "mpegts",
      ],
    },
    {
      // 3) MPEG-2 + AAC: video precisa de conversao para H.264, audio ja ok.
      file: "mpeg2_aac.ts",
      args: [
        "-f", "lavfi", "-i", testsrc,
        "-f", "lavfi", "-i", sine,
        "-c:v", "mpeg2video", ...gopArgs,
        "-c:a", "aac", "-shortest", "-f", "mpegts",
      ],
    },
    {
      // 4) Video sem audio.
      file: "video_only.mp4",
      args: [
        "-f", "lavfi", "-i", testsrc,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...gopArgs, "-an",
      ],
    },
    {
      // 5) Audio sem video, em FLAC (fora da allowlist de audio do navegador,
      // forca o perfil audio_only a converter para AAC).
      file: "audio_only.flac",
      args: ["-f", "lavfi", "-i", sine, "-c:a", "flac"],
    },
    {
      // 6) MPEG-TS com codecs ja compativeis: precisa so de remux (stream copy).
      file: "h264_aac_mpegts.ts",
      args: [
        "-f", "lavfi", "-i", testsrc,
        "-f", "lavfi", "-i", sine,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...gopArgs,
        "-c:a", "aac", "-shortest", "-f", "mpegts",
      ],
    },
  ];

  const results = [];
  for (const spec of specs) {
    const outputPath = path.join(outputDir, spec.file);
    const args = ["-y", "-hide_banner", "-loglevel", "error", ...spec.args, outputPath];
    const result = spawnSync(ffmpegPath, args, { encoding: "utf8" });

    if (result.error || result.status !== 0 || !fs.existsSync(outputPath)) {
      throw new Error(
        `Falha ao gerar fixture ${spec.file} (exit ${result.status}): ${result.stderr || result.error}`
      );
    }

    results.push({ name: spec.file, path: outputPath, sizeBytes: fs.statSync(outputPath).size });
  }

  return results;
}
