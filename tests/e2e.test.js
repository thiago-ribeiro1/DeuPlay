// Fluxo fim-a-fim REAL, sem mocks de ffprobe/FFmpeg e sem depender de canal
// IPTV externo: gera fixtures com FFmpeg de verdade, sobe um servidor HTTP
// local para servi-las, sobe a aplicacao real e exercita a API HTTP de
// ponta a ponta (import -> probe -> FFmpeg -> HLS local -> encerramento).
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

// Declaracoes "import" sao hoisted e avaliadas ANTES de qualquer statement
// deste modulo, mesmo as que aparecem antes delas no texto — entao setar
// process.env aqui em cima nao adiantaria nada se server/config.js fosse
// importado estaticamente: ele leria os defaults antes do assign rodar.
// Import dinamico se comporta como uma chamada normal, na ordem do codigo.
process.env.ALLOW_PRIVATE_HOSTS = "true";
process.env.HLS_SEGMENT_DURATION = "1";
process.env.HLS_PLAYLIST_SIZE = "8";
process.env.STREAM_START_TIMEOUT_MS = "20000";
process.env.PROBE_TIMEOUT_MS = "10000";

const { config } = await import("../server/config.js");
const { app } = await import("../server/app.js");
const { generateFixtures } = await import("./generateFixtures.js");
const { startMediaFixtureServer } = await import("./fixtureServer.js");

const hasFfmpeg = spawnSync(config.ffmpegPath, ["-version"]).status === 0;
const hasFfprobe = spawnSync(config.ffprobePath, ["-version"]).status === 0;

async function withApp(t) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  t.after(() => server.close());
  return `http://127.0.0.1:${port}`;
}

async function importFixtureChannel(base, media, filename, label) {
  const m3u = ["#EXTM3U", `#EXTINF:-1 group-title="E2E",${label}`, media.baseUrl + "/" + filename].join("\n");
  const importResponse = await fetch(base + "/api/playlists/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceType: "text", name: label, text: m3u }),
  });
  assert.equal(importResponse.status, 201, "import deveria retornar 201");
  const imported = await importResponse.json();
  assert.equal(imported.channelCount, 1);

  const channelsResponse = await fetch(base + "/api/playlists/" + imported.id + "/channels");
  const [channel] = await channelsResponse.json();
  assert.ok(channel.id, "canal importado deve ter id");
  return channel;
}

test(
  "fim-a-fim real: import -> ffprobe -> FFmpeg -> HLS local -> segmentos -> encerramento -> limpeza",
  { skip: !hasFfmpeg || !hasFfprobe ? "FFmpeg/ffprobe nao encontrados neste ambiente" : false, timeout: 60000 },
  async (t) => {
    const fixtureDir = path.join(os.tmpdir(), "iptv-e2e-fixtures-" + Date.now());
    console.log("[e2e] gerando fixtures reais com FFmpeg em", fixtureDir);
    const fixtures = generateFixtures(config.ffmpegPath, fixtureDir, { duration: 10 });
    t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
    console.log("[e2e] fixtures geradas:", fixtures.map((f) => `${f.name} (${f.sizeBytes}B)`).join(", "));

    const media = await startMediaFixtureServer(fixtureDir);
    t.after(() => media.server.close());
    console.log("[e2e] servidor de fixtures HTTP local:", media.baseUrl);

    const base = await withApp(t);
    console.log("[e2e] app real escutando em:", base);

    // 1) importar fixture -> criar canal (H.264 ok / AC-3 exige conversao de
    // audio: forca o backend a escolher copy_video_transcode_audio, que so
    // funciona chamando FFmpeg de verdade).
    const channel = await importFixtureChannel(base, media, "h264_ac3.ts", "Fixture H264+AC3");
    console.log("[e2e] canal criado:", channel.id, "->", channel.sourceUrl);

    // 2) POST playback -> dispara ffprobe real e, a partir da decisao,
    // inicia FFmpeg real e so responde quando o HLS local estiver pronto.
    const t0 = Date.now();
    const playbackResponse = await fetch(base + "/api/channels/" + channel.id + "/playback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const playback = await playbackResponse.json();
    console.log(`[e2e] POST playback respondeu em ${Date.now() - t0}ms:`, JSON.stringify(playback));

    assert.equal(playbackResponse.status, 200, "playback deveria ter sucesso: " + JSON.stringify(playback));
    assert.equal(playback.status, "ready");
    assert.equal(playback.mediaInfo.videoCodec, "h264", "ffprobe real deveria detectar h264");
    assert.equal(playback.mediaInfo.audioCodec, "ac3", "ffprobe real deveria detectar ac3");
    assert.equal(playback.strategy, "copy_video_transcode_audio", "audio incompativel deveria forcar conversao");
    assert.match(playback.playbackUrl, /^\/api\/playback\/[^/]+\/index\.m3u8$/);

    // 3) processo real aparece em /api/streams com PID e diretorio de saida
    const streamsResponse = await fetch(base + "/api/streams");
    const streams = await streamsResponse.json();
    const proc = streams.find((p) => p.channelId === channel.id);
    assert.ok(proc, "processo do canal deveria aparecer em /api/streams");
    assert.equal(proc.status, "ready");
    assert.ok(proc.pid, "PID do FFmpeg deveria estar presente");
    console.log("[e2e] processo FFmpeg real: pid=" + proc.pid, "mode=" + proc.mode, "outputDir=" + proc.outputDirectory);

    // 4) index.m3u8 existe de verdade em disco. "ready" so exige 1 segmento
    // (para nao atrasar o player); com "-re" pacing em tempo real, o 2o
    // segmento leva ~1s a mais pra aparecer, entao aguardamos ativamente
    // em vez de checar so no instante exato em que ficou pronto.
    const playlistPath = path.join(proc.outputDirectory, "index.m3u8");
    assert.ok(fs.existsSync(playlistPath), "index.m3u8 deveria existir em disco: " + playlistPath);

    let segmentNames = [];
    await waitUntil(() => {
      const content = fs.readFileSync(playlistPath, "utf8");
      segmentNames = [...new Set([...content.matchAll(/segment_\d+\.ts/g)].map((m) => m[0]))];
      return segmentNames.length >= 2;
    }, 8000);
    console.log("[e2e] segmentos referenciados na playlist em disco:", segmentNames);
    assert.ok(segmentNames.length >= 2, `esperava >=2 segmentos, achou ${segmentNames.length}`);

    // 5) buscar a playlist PELA API (nao direto do disco) e conferir Content-Type
    const playlistApiResponse = await fetch(base + playback.playbackUrl);
    assert.equal(playlistApiResponse.status, 200);
    assert.match(playlistApiResponse.headers.get("content-type"), /^application\/vnd\.apple\.mpegurl/);
    const playlistApiBody = await playlistApiResponse.text();
    assert.match(playlistApiBody, /#EXTM3U/);
    console.log("[e2e] GET " + playback.playbackUrl + " -> 200, content-type application/vnd.apple.mpegurl");

    // 6) buscar UM segmento pela API e conferir Content-Type e tamanho > 0
    const segmentUrl = playback.playbackUrl.replace("index.m3u8", segmentNames[0]);
    const segmentResponse = await fetch(base + segmentUrl);
    const segmentBuffer = Buffer.from(await segmentResponse.arrayBuffer());
    console.log(
      "[e2e] GET " + segmentUrl + " -> " + segmentResponse.status,
      "content-type=" + segmentResponse.headers.get("content-type"),
      "bytes=" + segmentBuffer.length
    );
    assert.equal(segmentResponse.status, 200);
    assert.equal(segmentResponse.headers.get("content-type"), "video/mp2t");
    assert.ok(segmentBuffer.length > 0, "segmento deveria ter tamanho > 0");

    // 7) heartbeat real de sessao
    const heartbeatResponse = await fetch(base + "/api/playback/" + playback.sessionId + "/heartbeat", { method: "POST" });
    assert.equal(heartbeatResponse.status, 200);

    // 8) encerrar sessao e confirmar encerramento do FFmpeg real (via rota
    // administrativa, para nao depender do temporizador de ociosidade)
    const pidBeforeStop = proc.pid;
    const deleteResponse = await fetch(base + "/api/playback/" + playback.sessionId, { method: "DELETE" });
    assert.equal(deleteResponse.status, 204);

    const stopResponse = await fetch(base + "/api/streams/" + encodeURIComponent(proc.key) + "/stop", { method: "POST" });
    assert.equal(stopResponse.status, 200);
    console.log("[e2e] pedido de stop enviado para pid=" + pidBeforeStop);

    const processGone = await waitUntil(() => {
      const found = spawnSync(
        process.platform === "win32" ? "tasklist" : "ps",
        process.platform === "win32" ? ["/FI", "PID eq " + pidBeforeStop] : ["-p", String(pidBeforeStop)]
      );
      const output = (found.stdout || "").toString();
      return !output.includes(String(pidBeforeStop));
    }, 8000);
    assert.ok(processGone, "processo FFmpeg (pid " + pidBeforeStop + ") deveria ter encerrado");
    console.log("[e2e] confirmado: pid=" + pidBeforeStop + " nao aparece mais na lista de processos do SO");

    // 9) limpeza posterior: diretorio de saida deve ter sido removido
    const dirGone = await waitUntil(() => !fs.existsSync(proc.outputDirectory), 5000);
    assert.ok(dirGone, "diretorio de saida deveria ter sido removido apos o stop: " + proc.outputDirectory);
    console.log("[e2e] confirmado: diretorio de saida removido:", proc.outputDirectory);

    // 10) o canal some da lista de streams ativos
    const streamsAfter = await fetch(base + "/api/streams").then((r) => r.json());
    assert.ok(!streamsAfter.some((p) => p.channelId === channel.id));
  }
);

function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      if (predicate()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(check, 200);
    };
    check();
  });
}
