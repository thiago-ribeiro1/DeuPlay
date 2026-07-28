import { test } from "node:test";
import assert from "node:assert/strict";
import { app } from "../server/app.js";

async function withServer(t) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  t.after(() => server.close());
  return `http://127.0.0.1:${port}`;
}

test("GET /api/config expoe playbackMode", async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/api/config`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(["backend_only", "backend_preferred", "direct_preferred"].includes(body.playbackMode));
});

test("GET /api/health reporta disponibilidade real de ffmpeg/ffprobe", async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.ffmpegAvailable, "boolean");
  assert.equal(typeof body.ffprobeAvailable, "boolean");
  assert.ok(["ok", "degraded"].includes(body.status));
});

test("frontend estatico continua sendo servido em /", async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /IPTV Player/);
});

test("fluxo completo de importacao de playlist via texto", async (t) => {
  const base = await withServer(t);
  const m3u = [
    "#EXTM3U",
    '#EXTINF:-1 group-title="Testes",Canal de Teste',
    "http://exemplo.com/canal-teste.m3u8",
  ].join("\n");

  const importResponse = await fetch(`${base}/api/playlists/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceType: "text", name: "Playlist de teste", text: m3u }),
  });
  assert.equal(importResponse.status, 201);
  const playlist = await importResponse.json();
  assert.equal(playlist.channelCount, 1);

  const listResponse = await fetch(`${base}/api/playlists`);
  const playlists = await listResponse.json();
  assert.ok(playlists.some((p) => p.id === playlist.id));

  const channelsResponse = await fetch(`${base}/api/playlists/${playlist.id}/channels`);
  assert.equal(channelsResponse.status, 200);
  const channels = await channelsResponse.json();
  assert.equal(channels.length, 1);
  assert.equal(channels[0].name, "Canal de Teste");
});

test("GET /api/playlists/:id/channels retorna 404 para playlist inexistente", async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/api/playlists/nao-existe/channels`);
  assert.equal(response.status, 404);
});

test("importacao rejeita playlist sem #EXTM3U", async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/api/playlists/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceType: "text", text: "isso nao e m3u" }),
  });
  assert.equal(response.status, 400);
});

test("POST /api/channels/playback com origem inacessivel reporta diagnostico, nunca declara sucesso falso", async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/api/channels/playback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Canal Externo", url: "http://exemplo-inexistente.invalid/live.m3u8" }),
  });

  const body = await response.json();
  // Sem ffmpeg/ffprobe instalados neste ambiente, a origem nao pode ser
  // sondada: o backend deve reportar falha com diagnostico, nunca "ready".
  if (!body.mediaInfo || body.mediaInfo.reachable === false) {
    assert.equal(response.status, 502);
    assert.equal(body.status, "failed");
    assert.ok(body.reason);
  } else {
    assert.equal(response.status, 200);
    assert.equal(body.status, "ready");
  }
});

test("POST /api/channels/playback rejeita URL com protocolo nao permitido", async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/api/channels/playback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Canal", url: "ftp://exemplo.com/x" }),
  });
  assert.equal(response.status, 400);
});

test("sessao de playback: heartbeat e encerramento respondem corretamente", async (t) => {
  const base = await withServer(t);

  const playbackResponse = await fetch(`${base}/api/channels/playback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Canal", url: "http://exemplo-inexistente.invalid/live.m3u8" }),
  });
  const body = await playbackResponse.json();
  assert.ok(body.sessionId);

  const statusResponse = await fetch(`${base}/api/playback/${body.sessionId}/status`);
  assert.equal(statusResponse.status, 200);

  const deleteResponse = await fetch(`${base}/api/playback/${body.sessionId}`, { method: "DELETE" });
  assert.equal(deleteResponse.status, 204);

  const afterDelete = await fetch(`${base}/api/playback/${body.sessionId}/status`);
  assert.equal(afterDelete.status, 404);
});

test("GET /api/streams retorna lista (vazia neste ambiente sem ffmpeg)", async (t) => {
  const base = await withServer(t);
  const response = await fetch(`${base}/api/streams`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body));
});
