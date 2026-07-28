import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFfmpegLikeError, DiagnosticCode } from "../server/services/diagnostics.js";

test("classifica DNS, timeout, connection refused a partir do stderr", () => {
  assert.equal(
    classifyFfmpegLikeError("Name or service not known").code,
    DiagnosticCode.DNS_RESOLUTION_FAILED
  );
  assert.equal(classifyFfmpegLikeError("Connection timed out").code, DiagnosticCode.TIMEOUT);
  assert.equal(
    classifyFfmpegLikeError("Connection refused").code,
    DiagnosticCode.CONNECTION_REFUSED
  );
});

test("extrai o status HTTP quando presente", () => {
  const result = classifyFfmpegLikeError("HTTP error 404 Not Found");
  assert.equal(result.code, DiagnosticCode.HTTP_STATUS);
  assert.match(result.detail, /404/);
});

test("401/403 viram auth_required em vez de http_status generico", () => {
  assert.equal(classifyFfmpegLikeError("HTTP error 403 Forbidden").code, DiagnosticCode.AUTH_REQUIRED);
});

test("sem correspondencia e exit code != 0 vira ffmpeg_exited", () => {
  assert.equal(classifyFfmpegLikeError("qualquer coisa sem padrao", 1).code, DiagnosticCode.FFMPEG_EXITED);
});

test("sem correspondencia e sem exit code vira unknown_error", () => {
  assert.equal(classifyFfmpegLikeError("").code, DiagnosticCode.UNKNOWN_ERROR);
});
