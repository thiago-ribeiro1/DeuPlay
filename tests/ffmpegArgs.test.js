import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildFfmpegArgs } from "../server/services/ffmpegArgs.js";
import { Profile } from "../server/services/strategy.js";

const baseParams = {
  inputUrl: "http://origem.com/live.ts",
  outputDir: path.join("media", "streams", "abc"),
  hlsSegmentDuration: 4,
  hlsPlaylistSize: 8,
  encoder: "libx264",
  ffmpegLogLevel: "warning",
};

test("remux usa stream copy e nao inclui flags de encoder", () => {
  const args = buildFfmpegArgs(Profile.REMUX, baseParams);
  assert.ok(args.includes("-c"));
  assert.ok(args.includes("copy"));
  assert.ok(!args.includes("libx264"));
  assert.ok(args.includes("-i"));
  assert.equal(args[args.indexOf("-i") + 1], baseParams.inputUrl);
});

test("entradas HTTP recebem flags de reconexao; arquivos locais nao", () => {
  const httpArgs = buildFfmpegArgs(Profile.REMUX, baseParams);
  assert.ok(httpArgs.includes("-reconnect"));

  const fileArgs = buildFfmpegArgs(Profile.REMUX, { ...baseParams, inputUrl: "/tmp/arquivo.ts" });
  assert.ok(!fileArgs.includes("-reconnect"));
});

test("transcode_all inclui codec de video e audio com parametros esperados", () => {
  const args = buildFfmpegArgs(Profile.TRANSCODE_ALL, baseParams);
  assert.ok(args.includes("libx264"));
  assert.ok(args.includes("aac"));
  assert.ok(args.includes("-b:a"));
  assert.ok(args.includes("128k"));
});

test("copy_video_transcode_audio copia video e converte apenas audio", () => {
  const args = buildFfmpegArgs(Profile.COPY_VIDEO_TRANSCODE_AUDIO, baseParams);
  const videoFlagIndex = args.indexOf("-c:v");
  assert.equal(args[videoFlagIndex + 1], "copy");
  assert.ok(args.includes("aac"));
});

test("transcode_video_copy_audio converte video e copia audio", () => {
  const args = buildFfmpegArgs(Profile.TRANSCODE_VIDEO_COPY_AUDIO, baseParams);
  assert.ok(args.includes("libx264"));
  const audioFlagIndex = args.indexOf("-c:a");
  assert.equal(args[audioFlagIndex + 1], "copy");
});

test("audio_only remove video do mapeamento (-vn)", () => {
  const args = buildFfmpegArgs(Profile.AUDIO_ONLY, baseParams);
  assert.ok(args.includes("-vn"));
  assert.ok(!args.includes("0:v:0?"));
});

test("headers da origem viram um unico argumento -headers (sem shell, sem injecao)", () => {
  const args = buildFfmpegArgs(Profile.REMUX, {
    ...baseParams,
    headers: { "User-Agent": "Teste; rm -rf /", Referer: "http://origem.com/" },
  });
  const headersIndex = args.indexOf("-headers");
  assert.notEqual(headersIndex, -1);
  const headerValue = args[headersIndex + 1];
  assert.match(headerValue, /User-Agent: Teste; rm -rf \//);
  // O valor inteiro e um unico elemento do array (spawn com shell:false),
  // entao "; rm -rf /" nunca e interpretado como um novo comando.
  assert.equal(args.filter((a) => a.includes("rm -rf")).length, 1);
});

test("saida HLS usa hls_time e hls_list_size configurados", () => {
  const args = buildFfmpegArgs(Profile.REMUX, { ...baseParams, hlsSegmentDuration: 6, hlsPlaylistSize: 10 });
  assert.equal(args[args.indexOf("-hls_time") + 1], "6");
  assert.equal(args[args.indexOf("-hls_list_size") + 1], "10");
});

test("encoder de hardware (nvenc) altera as flags de video mantendo o restante", () => {
  const args = buildFfmpegArgs(Profile.TRANSCODE_ALL, { ...baseParams, encoder: "h264_nvenc" });
  assert.ok(args.includes("h264_nvenc"));
  assert.ok(!args.includes("libx264"));
});

test("perfis somente de proxy (direct/http_proxy/hls_proxy) nao geram argumentos de ffmpeg", () => {
  assert.throws(() => buildFfmpegArgs(Profile.DIRECT, baseParams));
  assert.throws(() => buildFfmpegArgs(Profile.HTTP_PROXY, baseParams));
  assert.throws(() => buildFfmpegArgs(Profile.HLS_PROXY, baseParams));
});
