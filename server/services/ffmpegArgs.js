import path from "node:path";
import { Profile } from "./strategy.js";

/**
 * Monta os argumentos de FFmpeg para um perfil de reprodução, sempre como
 * array (sem shell), evitando qualquer risco de injeção via URL/headers.
 */
export function buildFfmpegArgs(profile, params) {
  const {
    inputUrl,
    headers = {},
    outputDir,
    hlsSegmentDuration,
    hlsPlaylistSize,
    encoder = "libx264",
    ffmpegLogLevel = "warning",
    frameRate,
  } = params;

  const args = ["-hide_banner", "-nostdin", "-loglevel", ffmpegLogLevel];

  args.push(...inputResilienceArgs(inputUrl));
  args.push(...inputHeaderArgs(headers));
  args.push("-fflags", "+genpts+discardcorrupt");
  args.push("-avoid_negative_ts", "make_zero");
  // O ffprobe ja rodou segundos antes e ja conhece os codecs (mediaInfo);
  // usar os 5s "de fabrica" do FFmpeg aqui so soma latencia ao primeiro
  // segmento sem trazer informacao nova. 1s/1MB e suficiente pra um
  // container ja identificado.
  args.push("-analyzeduration", "1000000", "-probesize", "1000000");
  args.push("-i", inputUrl);

  args.push(...mapAndCodecArgs(profile, encoder, frameRate, hlsSegmentDuration));
  args.push(...hlsOutputArgs(outputDir, hlsSegmentDuration, hlsPlaylistSize));

  return args;
}

function inputResilienceArgs(inputUrl) {
  if (!/^https?:\/\//i.test(inputUrl)) return [];
  // Aplicavel apenas a entradas HTTP(S): reconecta em quedas transitorias
  // sem reiniciar o processo inteiro, e "-re" pausa a leitura no ritmo real
  // do conteudo (fps/sample rate) em vez de processar o quanto o disco/CPU
  // permitirem — sem isso, uma origem finita com "-c:v copy" e lida e
  // descartada quase instantaneamente, quebrando a semantica de "canal ao
  // vivo" e podendo dar EOF antes de qualquer espectador acompanhar.
  //
  // NAO usar "-use_wallclock_as_timestamps": e para fontes sem timestamps
  // confiaveis (captura de dispositivo bruto). Containers HTTP normais
  // (mp4/ts) ja tem PTS validos, e combinar essa flag com "-re" faz o
  // muxer de saida ver descontinuidade de timestamp que nao existe.
  return [
    "-re",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",
    "-rw_timeout",
    "15000000",
  ];
}

function inputHeaderArgs(headers) {
  const entries = Object.entries(headers || {});
  if (!entries.length) return [];
  const headerBlock = entries.map(([key, value]) => `${key}: ${value}`).join("\r\n") + "\r\n";
  return ["-headers", headerBlock];
}

function mapAndCodecArgs(profile, encoder, frameRate, hlsSegmentDuration) {
  switch (profile) {
    case Profile.REMUX:
      return ["-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy"];

    case Profile.COPY_VIDEO_TRANSCODE_AUDIO:
      return [
        "-map", "0:v:0?", "-map", "0:a:0?",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
      ];

    case Profile.TRANSCODE_VIDEO_COPY_AUDIO:
      return [
        "-map", "0:v:0?", "-map", "0:a:0?",
        ...videoEncodeArgs(encoder, frameRate, hlsSegmentDuration),
        "-c:a", "copy",
      ];

    case Profile.TRANSCODE_ALL:
      return [
        "-map", "0:v:0?", "-map", "0:a:0?",
        ...videoEncodeArgs(encoder, frameRate, hlsSegmentDuration),
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
      ];

    case Profile.AUDIO_ONLY:
      return ["-vn", "-map", "0:a:0", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"];

    default:
      throw new Error(`Perfil "${profile}" nao gera argumentos de FFmpeg (deve ser tratado por proxy).`);
  }
}

// HLS so corta um segmento em um keyframe. Sem forcar o intervalo de
// keyframes do encoder para bater com hls_time, a segmentacao fica a merce
// do GOP padrao do encoder (frequentemente varios segundos), atrasando o
// primeiro segmento e deixando os demais irregulares.
function gopArgs(frameRate, hlsSegmentDuration) {
  const fps = frameRate && frameRate > 0 ? frameRate : 25;
  const duration = hlsSegmentDuration && hlsSegmentDuration > 0 ? hlsSegmentDuration : 4;
  const gopSize = Math.max(1, Math.round(fps * duration));
  return ["-g", String(gopSize), "-keyint_min", String(gopSize)];
}

function videoEncodeArgs(encoder, frameRate, hlsSegmentDuration) {
  const gop = gopArgs(frameRate, hlsSegmentDuration);

  switch (encoder) {
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll", "-pix_fmt", "yuv420p", "-profile:v", "main", ...gop];
    case "h264_qsv":
      return ["-c:v", "h264_qsv", "-preset", "veryfast", "-pix_fmt", "nv12", "-profile:v", "main", ...gop];
    case "h264_vaapi":
      return ["-c:v", "h264_vaapi", "-pix_fmt", "vaapi", "-profile:v", "main", ...gop];
    case "h264_videotoolbox":
      return ["-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p", "-profile:v", "main", ...gop];
    case "h264_amf":
      return ["-c:v", "h264_amf", "-quality", "speed", "-pix_fmt", "yuv420p", "-profile:v", "main", ...gop];
    default:
      return [
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-tune", "zerolatency",
        "-pix_fmt", "yuv420p",
        "-profile:v", "main",
        "-level", "4.1",
        ...gop,
        "-sc_threshold", "0",
      ];
  }
}

function hlsOutputArgs(outputDir, hlsSegmentDuration, hlsPlaylistSize) {
  return [
    "-f", "hls",
    "-hls_time", String(hlsSegmentDuration),
    "-hls_list_size", String(hlsPlaylistSize),
    "-hls_flags", "delete_segments+append_list+omit_endlist",
    "-hls_segment_filename", path.join(outputDir, "segment_%06d.ts"),
    path.join(outputDir, "index.m3u8"),
  ];
}
