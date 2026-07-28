import "./setupEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { startFixtureServer } from "./fixtureServer.js";
import { proxyHttp } from "../server/services/httpProxy.js";
import { proxyHls } from "../server/services/hlsProxy.js";

async function withTestServer(t) {
  const fixture = await startFixtureServer();
  const app = express();
  app.get("/proxy", (req, res) => proxyHttp(req, res, req.query.url, {}));
  app.get("/hls", (req, res) => proxyHls(req, res, req.query.url, {}, "http://127.0.0.1:0/hls"));

  const proxyServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => proxyServer.once("listening", resolve));
  const { port } = proxyServer.address();
  const proxyBaseUrl = `http://127.0.0.1:${port}`;

  t.after(() => {
    fixture.server.close();
    proxyServer.close();
  });

  return { fixtureBaseUrl: fixture.baseUrl, proxyBaseUrl };
}

test("proxyHttp encaminha resposta 200 com o corpo original", async (t) => {
  const { fixtureBaseUrl, proxyBaseUrl } = await withTestServer(t);
  const response = await fetch(`${proxyBaseUrl}/proxy?url=${encodeURIComponent(fixtureBaseUrl + "/ok.txt")}`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "conteudo de teste");
});

test("proxyHttp preserva status 404 da origem", async (t) => {
  const { fixtureBaseUrl, proxyBaseUrl } = await withTestServer(t);
  const response = await fetch(`${proxyBaseUrl}/proxy?url=${encodeURIComponent(fixtureBaseUrl + "/404")}`);
  assert.equal(response.status, 404);
});

test("proxyHttp preserva status 500 da origem", async (t) => {
  const { fixtureBaseUrl, proxyBaseUrl } = await withTestServer(t);
  const response = await fetch(`${proxyBaseUrl}/proxy?url=${encodeURIComponent(fixtureBaseUrl + "/500")}`);
  assert.equal(response.status, 500);
});

test("proxyHttp segue redirect da origem", async (t) => {
  const { fixtureBaseUrl, proxyBaseUrl } = await withTestServer(t);
  const response = await fetch(`${proxyBaseUrl}/proxy?url=${encodeURIComponent(fixtureBaseUrl + "/redirect")}`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "conteudo de teste");
});

test("proxyHttp rejeita protocolo nao permitido antes de sair para a rede", async (t) => {
  const { proxyBaseUrl } = await withTestServer(t);
  const response = await fetch(`${proxyBaseUrl}/proxy?url=${encodeURIComponent("ftp://exemplo.com/x")}`);
  assert.equal(response.status, 400);
});

test("proxyHls reescreve a playlist para apontar de volta ao proxy", async (t) => {
  const { fixtureBaseUrl, proxyBaseUrl } = await withTestServer(t);
  const response = await fetch(`${proxyBaseUrl}/hls?url=${encodeURIComponent(fixtureBaseUrl + "/playlist.m3u8")}`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /#EXTM3U/);
  assert.match(body, /\/hls\?url=/);
  assert.match(body, /segment0\.ts/);
});

test("proxyHls encaminha segmentos binarios como passthrough", async (t) => {
  const { fixtureBaseUrl, proxyBaseUrl } = await withTestServer(t);
  const response = await fetch(`${proxyBaseUrl}/hls?url=${encodeURIComponent(fixtureBaseUrl + "/segment0.ts")}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp2t");
});
