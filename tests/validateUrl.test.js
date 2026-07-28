import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSourceUrl, UrlValidationError } from "../server/security/validateUrl.js";

test("aceita http e https", () => {
  assert.doesNotThrow(() => validateSourceUrl("http://exemplo.com/live.m3u8"));
  assert.doesNotThrow(() => validateSourceUrl("https://exemplo.com/live.m3u8"));
});

test("rejeita protocolo fora da allowlist", () => {
  assert.throws(() => validateSourceUrl("ftp://exemplo.com/arquivo"), UrlValidationError);
});

test("rejeita URL malformada", () => {
  assert.throws(() => validateSourceUrl("nao e uma url"), UrlValidationError);
});

test("rejeita URL vazia", () => {
  assert.throws(() => validateSourceUrl(""), UrlValidationError);
  assert.throws(() => validateSourceUrl(undefined), UrlValidationError);
});

test("bloqueia hosts privados/loopback por padrao (protecao contra SSRF)", () => {
  for (const host of ["http://localhost/x", "http://127.0.0.1/x", "http://192.168.1.10/x", "http://10.0.0.5/x"]) {
    assert.throws(() => validateSourceUrl(host), UrlValidationError, host);
  }
});
