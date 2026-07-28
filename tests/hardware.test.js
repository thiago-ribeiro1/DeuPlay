import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { detectEncoder } from "../server/services/hardware.js";

function ffmpegInstalled() {
  const result = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]);
  return !result.error && result.status === 0;
}

test("detectEncoder cai para libx264 quando ffmpeg nao esta disponivel", { skip: ffmpegInstalled() }, async () => {
  const result = await detectEncoder();
  assert.equal(result.encoder, "libx264");
  assert.equal(result.hardware, false);
});

test(
  "detectEncoder retorna um encoder valido quando ffmpeg esta disponivel",
  { skip: !ffmpegInstalled() },
  async () => {
    const result = await detectEncoder();
    assert.ok(["libx264", "h264_nvenc", "h264_qsv", "h264_vaapi", "h264_videotoolbox", "h264_amf"].includes(result.encoder));
  }
);
