import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePlaybackStrategy, Profile } from "../server/services/strategy.js";

function mediaInfo(overrides = {}) {
  return {
    reachable: true,
    hasVideo: true,
    hasAudio: true,
    videoCodec: "h264",
    audioCodec: "aac",
    probeDurationMs: 10,
    errors: [],
    ...overrides,
  };
}

test("origem inacessivel retorna unavailable com o motivo do probe", () => {
  const decision = decidePlaybackStrategy({ reachable: false, errorCode: "timeout" }, {}, {});
  assert.equal(decision.unavailable, true);
  assert.equal(decision.reason, "timeout");
  assert.deepEqual(decision.profiles, []);
});

test("sem video e sem audio e considerado indisponivel", () => {
  const decision = decidePlaybackStrategy(mediaInfo({ hasVideo: false, hasAudio: false }), {}, {});
  assert.equal(decision.unavailable, true);
  assert.equal(decision.reason, "no_playable_streams");
});

test("h264+aac em HLS (preferBackend=false): tenta direct, depois hls_proxy, depois remux", () => {
  const decision = decidePlaybackStrategy(mediaInfo(), { url: "http://x/live.m3u8" }, { preferBackend: false });
  assert.deepEqual(decision.profiles, [Profile.DIRECT, Profile.HLS_PROXY, Profile.REMUX]);
});

test("origem nao-HLS compativel (preferBackend=false) usa http_proxy em vez de hls_proxy", () => {
  const decision = decidePlaybackStrategy(mediaInfo(), { url: "http://x/stream.ts" }, { preferBackend: false });
  assert.deepEqual(decision.profiles, [Profile.DIRECT, Profile.HTTP_PROXY, Profile.REMUX]);
});

test("sem clientCapabilities explicito, o default vem de PLAYBACK_MODE (backend_only nos testes exclui direct)", () => {
  const decision = decidePlaybackStrategy(mediaInfo(), { url: "http://x/live.m3u8" }, {});
  assert.ok(!decision.profiles.includes(Profile.DIRECT));
});

test("video incompativel + audio compativel: copia audio, transcodifica video", () => {
  const decision = decidePlaybackStrategy(
    mediaInfo({ videoCodec: "mpeg2video" }),
    { url: "http://x/live.m3u8" },
    {}
  );
  assert.deepEqual(decision.profiles, [Profile.TRANSCODE_VIDEO_COPY_AUDIO, Profile.TRANSCODE_ALL]);
});

test("video compativel + audio incompativel: copia video, transcodifica audio", () => {
  const decision = decidePlaybackStrategy(
    mediaInfo({ audioCodec: "ac3" }),
    { url: "http://x/live.m3u8" },
    {}
  );
  assert.deepEqual(decision.profiles, [Profile.COPY_VIDEO_TRANSCODE_AUDIO, Profile.TRANSCODE_ALL]);
});

test("video e audio incompativeis: transcodificacao completa direto", () => {
  const decision = decidePlaybackStrategy(
    mediaInfo({ videoCodec: "mpeg2video", audioCodec: "ac3" }),
    { url: "http://x/live.m3u8" },
    {}
  );
  assert.deepEqual(decision.profiles, [Profile.TRANSCODE_ALL]);
});

test("apenas audio (radio): direct/proxy compativel e fallback audio_only", () => {
  const decision = decidePlaybackStrategy(
    mediaInfo({ hasVideo: false, videoCodec: undefined }),
    { url: "http://x/radio.m3u8" },
    { preferBackend: false }
  );
  assert.deepEqual(decision.profiles, [Profile.DIRECT, Profile.HLS_PROXY, Profile.AUDIO_ONLY]);
});

test("preferBackend=true remove a estrategia direct da cadeia", () => {
  const decision = decidePlaybackStrategy(
    mediaInfo(),
    { url: "http://x/live.m3u8" },
    { preferBackend: true }
  );
  assert.ok(!decision.profiles.includes(Profile.DIRECT));
  assert.deepEqual(decision.profiles, [Profile.HLS_PROXY, Profile.REMUX]);
});
