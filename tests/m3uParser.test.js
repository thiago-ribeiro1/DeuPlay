import { test } from "node:test";
import assert from "node:assert/strict";
import { parseM3U, M3uParseError } from "../server/services/m3uParser.js";

test("rejeita conteudo sem cabecalho #EXTM3U", () => {
  assert.throws(() => parseM3U("qualquer coisa"), M3uParseError);
});

test("rejeita conteudo vazio", () => {
  assert.throws(() => parseM3U(""), M3uParseError);
});

test("interpreta EXTINF com atributos e agrupa por group-title", () => {
  const m3u = [
    "#EXTM3U",
    '#EXTINF:-1 tvg-id="tv1" tvg-name="Canal Um" tvg-logo="http://logo/1.png" group-title="Esportes",Canal Um HD',
    "http://exemplo.com/canal1.m3u8",
  ].join("\n");

  const { channels } = parseM3U(m3u);
  assert.equal(channels.length, 1);
  const [channel] = channels;
  assert.equal(channel.name, "Canal Um HD");
  assert.equal(channel.group, "Esportes");
  assert.equal(channel.tvgId, "tv1");
  assert.equal(channel.tvgName, "Canal Um");
  assert.equal(channel.logoUrl, "http://logo/1.png");
  assert.equal(channel.sourceUrl, "http://exemplo.com/canal1.m3u8");
  assert.equal(channel.enabled, true);
  assert.ok(channel.id);
});

test("nomes de canal com virgula nao quebram o parser (separador ignora aspas)", () => {
  const m3u = [
    "#EXTM3U",
    '#EXTINF:-1 group-title="Noticias",Canal, com virgula no nome',
    "http://exemplo.com/a.m3u8",
  ].join("\n");
  const { channels } = parseM3U(m3u);
  assert.equal(channels[0].name, "Canal, com virgula no nome");
});

test("reconhece radio, catchup, catchup-source e timeshift", () => {
  const m3u = [
    "#EXTM3U",
    '#EXTINF:-1 radio="true" catchup="default" catchup-source="http://cu/${start}" timeshift="4",Radio X',
    "http://exemplo.com/radio.m3u8",
  ].join("\n");
  const { channels } = parseM3U(m3u);
  assert.equal(channels[0].metadata.radio, true);
  assert.equal(channels[0].metadata.catchup, "default");
  assert.equal(channels[0].metadata.catchupSource, "http://cu/${start}");
  assert.equal(channels[0].metadata.timeshift, "4");
});

test("le url-tvg do cabecalho #EXTM3U", () => {
  const m3u = [
    '#EXTM3U url-tvg="http://epg.exemplo.com/guide.xml"',
    "#EXTINF:-1,Canal",
    "http://exemplo.com/a.m3u8",
  ].join("\n");
  const { playlistMeta } = parseM3U(m3u);
  assert.equal(playlistMeta.epgUrl, "http://epg.exemplo.com/guide.xml");
});

test("aplica #EXTVLCOPT como headers da origem", () => {
  const m3u = [
    "#EXTM3U",
    "#EXTINF:-1,Canal com headers",
    "#EXTVLCOPT:http-user-agent=MeuPlayer/1.0",
    "#EXTVLCOPT:http-referrer=http://origem.com/",
    "http://exemplo.com/a.m3u8",
  ].join("\n");
  const { channels } = parseM3U(m3u);
  assert.equal(channels[0].sourceHeaders["User-Agent"], "MeuPlayer/1.0");
  assert.equal(channels[0].sourceHeaders["Referer"], "http://origem.com/");
});

test("remove BOM e aceita finais de linha CRLF", () => {
  const m3u = "﻿#EXTM3U\r\n#EXTINF:-1,Canal\r\nhttp://exemplo.com/a.m3u8\r\n";
  const { channels } = parseM3U(m3u);
  assert.equal(channels.length, 1);
  assert.equal(channels[0].name, "Canal");
});

test("deduplica entradas com a mesma URL e headers", () => {
  const m3u = [
    "#EXTM3U",
    "#EXTINF:-1,Canal A",
    "http://exemplo.com/a.m3u8",
    "#EXTINF:-1,Canal A duplicado",
    "http://exemplo.com/a.m3u8",
  ].join("\n");
  const { channels, duplicates } = parseM3U(m3u);
  assert.equal(channels.length, 1);
  assert.equal(duplicates, 1);
});

test("ignora comentarios e tags desconhecidas sem interromper o parse", () => {
  const m3u = [
    "#EXTM3U",
    "# apenas um comentario",
    "#EXT-X-ALGO-DESCONHECIDO:valor",
    "#EXTINF:-1,Canal",
    "http://exemplo.com/a.m3u8",
  ].join("\n");
  const { channels } = parseM3U(m3u);
  assert.equal(channels.length, 1);
});

test("ignora entradas sem URL http valida", () => {
  const m3u = ["#EXTM3U", "#EXTINF:-1,Canal sem url", "nao-e-uma-url"].join("\n");
  const { channels, warnings } = parseM3U(m3u);
  assert.equal(channels.length, 0);
  assert.ok(warnings.length > 0);
});

test("respeita o limite maxChannels", () => {
  const lines = ["#EXTM3U"];
  for (let i = 0; i < 5; i++) {
    lines.push(`#EXTINF:-1,Canal ${i}`, `http://exemplo.com/${i}.m3u8`);
  }
  const { channels, warnings } = parseM3U(lines.join("\n"), { maxChannels: 2 });
  assert.equal(channels.length, 2);
  assert.ok(warnings.some((w) => w.includes("Limite")));
});
