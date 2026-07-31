import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "iptv-cred-"));

const { saveCredentials, loadCredentials, describeCredentials, clearCredentials, DecryptError } =
  await import("../server/services/credentialStore.js");
const { seal, open } = await import("../server/services/secretBox.js");
const { config } = await import("../server/config.js");

const FILE = path.join(config.dataDir, "xtream-credentials.enc.json");
const CRED = { host: "http://painel:8080", username: "joao", password: "segredo-do-painel" };
const PASS = "minha-frase-secreta";

beforeEach(async () => {
  await clearCredentials();
});

after(async () => {
  await fs.rm(config.dataDir, { recursive: true, force: true });
});

test("ida e volta: cifra e recupera com a senha correta", async () => {
  await saveCredentials(CRED, PASS);
  const loaded = await loadCredentials(PASS);
  assert.equal(loaded.username, "joao");
  assert.equal(loaded.password, "segredo-do-painel");
});

test("senha errada falha em vez de devolver lixo", async () => {
  await saveCredentials(CRED, PASS);
  await assert.rejects(
    () => loadCredentials("frase-errada"),
    (err) => err instanceof DecryptError
  );
});

test("nenhum dado sensivel aparece em claro no arquivo", async () => {
  await saveCredentials(CRED, PASS);
  const raw = await fs.readFile(FILE, "utf8");
  for (const segredo of ["segredo-do-painel", "joao", "painel:8080", PASS]) {
    assert.ok(!raw.includes(segredo), `vazou "${segredo}" no arquivo`);
  }
});

test("arquivo alterado e detectado pela tag de autenticacao", async () => {
  await saveCredentials(CRED, PASS);
  const envelope = JSON.parse(await fs.readFile(FILE, "utf8"));
  const bytes = Buffer.from(envelope.data, "base64");
  bytes[0] ^= 0xff;
  envelope.data = bytes.toString("base64");
  await fs.writeFile(FILE, JSON.stringify(envelope));

  await assert.rejects(
    () => loadCredentials(PASS),
    (err) => err instanceof DecryptError
  );
});

test("salt e iv mudam a cada gravacao com a mesma senha", async () => {
  await saveCredentials(CRED, PASS);
  const primeiro = JSON.parse(await fs.readFile(FILE, "utf8"));
  await saveCredentials(CRED, PASS);
  const segundo = JSON.parse(await fs.readFile(FILE, "utf8"));

  assert.notEqual(primeiro.salt, segundo.salt);
  assert.notEqual(primeiro.iv, segundo.iv);
  assert.notEqual(primeiro.data, segundo.data);
});

test("describeCredentials nao revela nada alem da existencia", async () => {
  await saveCredentials(CRED, PASS);
  const described = await describeCredentials();
  assert.deepEqual(described, { saved: true, encrypted: true });
});

test("sem credencial salva, describe responde saved:false", async () => {
  assert.deepEqual(await describeCredentials(), { saved: false });
});

test("salvar sem senha de protecao e recusado", async () => {
  await assert.rejects(() => saveCredentials(CRED, ""), DecryptError);
});

test("clearCredentials remove o arquivo do disco", async () => {
  await saveCredentials(CRED, PASS);
  assert.equal(await clearCredentials(), true);
  await assert.rejects(() => fs.stat(FILE));
});

test("secretBox aceita acentos e emoji na senha", async () => {
  const frase = "çãõ-senha-difícil-🔐";
  const envelope = await seal({ a: 1 }, frase);
  assert.deepEqual(await open(envelope, frase), { a: 1 });
});

test("arquivo gravado sem permissao para grupo e outros", async (t) => {
  if (process.platform === "win32") return t.skip("modo POSIX nao se aplica ao Windows");
  await saveCredentials(CRED, PASS);
  const stats = await fs.stat(FILE);
  assert.equal(stats.mode & 0o777, 0o600);
});
