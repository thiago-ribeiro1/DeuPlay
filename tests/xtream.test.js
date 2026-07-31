import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  parseXtreamInput,
  authenticate,
  importLiveCatalog,
  maskStreamUrl,
  XtreamError,
} from "../server/services/xtreamClient.js";

const USER = "usuario_teste";
const PASS = "senha_teste";

let server;
let baseUrl;

/** Painel Xtream falso: responde como os paineis reais, incluindo os erros. */
function createPanel() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/nao-json") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>painel inexistente</html>");
      return;
    }

    if (url.pathname !== "/player_api.php") {
      res.writeHead(404);
      res.end();
      return;
    }

    const username = url.searchParams.get("username");
    const password = url.searchParams.get("password");
    const action = url.searchParams.get("action");

    if (username !== USER || password !== PASS) {
      return json(200, { user_info: { auth: 0 } });
    }

    if (!action) {
      return json(200, {
        user_info: {
          username,
          auth: 1,
          status: "Active",
          exp_date: "1790000000",
          is_trial: "0",
          active_cons: "1",
          max_connections: "2",
          allowed_output_formats: ["m3u8", "ts"],
        },
        server_info: { url: "painel.teste", port: "8080", server_protocol: "http" },
      });
    }

    if (action === "get_live_categories") {
      return json(200, [
        { category_id: "1", category_name: "Abertos", parent_id: 0 },
        { category_id: "2", category_name: "Esportes", parent_id: 0 },
      ]);
    }

    if (action === "get_live_streams") {
      return json(200, [
        {
          num: 1,
          name: "Canal Um HD",
          stream_type: "live",
          stream_id: 101,
          stream_icon: "http://logo/1.png",
          epg_channel_id: "canal.um",
          category_id: "1",
          tv_archive: 1,
          tv_archive_duration: 3,
        },
        {
          num: 2,
          name: "Canal Dois, com virgula",
          stream_id: 102,
          category_id: "2",
          tv_archive: 0,
        },
        // direct_source: o painel ja entrega a URL pronta
        {
          num: 3,
          name: "Canal Tres",
          stream_id: 103,
          category_id: "99",
          direct_source: "http://outrocdn.com/tres.m3u8",
        },
        // sem stream_id: deve virar warning, nao quebrar a importacao
        { num: 4, name: "Canal Quebrado", category_id: "1" },
      ]);
    }

    return json(200, []);
  });
}

before(async () => {
  server = createPanel();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("aceita host sem protocolo", () => {
  const parsed = parseXtreamInput("painel.exemplo.com:8080", "u", "p");
  assert.equal(parsed.baseUrl, "http://painel.exemplo.com:8080");
  assert.equal(parsed.username, "u");
});

test("extrai credenciais de uma URL get.php colada inteira", () => {
  const parsed = parseXtreamInput(
    "http://painel.exemplo.com:8080/get.php?username=abc&password=xyz&type=m3u_plus"
  );
  assert.equal(parsed.baseUrl, "http://painel.exemplo.com:8080");
  assert.equal(parsed.username, "abc");
  assert.equal(parsed.password, "xyz");
});

test("exige usuario e senha", () => {
  assert.throws(() => parseXtreamInput("http://painel.exemplo.com", "", ""), XtreamError);
});

test("autentica e devolve o estado da conta", async () => {
  const account = await authenticate(baseUrl, USER, PASS);
  assert.equal(account.status, "Active");
  assert.equal(account.maxConnections, 2);
  assert.equal(account.activeConnections, 1);
  assert.ok(account.expiresAt.startsWith("20"));
  assert.deepEqual(account.allowedFormats, ["m3u8", "ts"]);
});

test("credencial errada vira erro unauthorized", async () => {
  await assert.rejects(
    () => authenticate(baseUrl, USER, "errada"),
    (err) => err instanceof XtreamError && err.code === "unauthorized"
  );
});

test("servidor que responde HTML em player_api.php vira erro not_xtream", async () => {
  const htmlServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>nao sou um painel</html>");
  });
  await new Promise((resolve) => htmlServer.listen(0, "127.0.0.1", resolve));
  const htmlUrl = `http://127.0.0.1:${htmlServer.address().port}`;

  try {
    await assert.rejects(
      () => authenticate(htmlUrl, USER, PASS),
      (err) => err instanceof XtreamError && err.code === "not_xtream"
    );
  } finally {
    htmlServer.close();
  }
});

test("importa o catalogo no mesmo formato do parser M3U", async () => {
  const account = await authenticate(baseUrl, USER, PASS);
  const parsed = await importLiveCatalog({
    baseUrl,
    username: USER,
    password: PASS,
    account,
  });

  assert.equal(parsed.channels.length, 3);

  const [um, dois, tres] = parsed.channels;

  assert.equal(um.name, "Canal Um HD");
  assert.equal(um.group, "Abertos");
  assert.equal(um.logoUrl, "http://logo/1.png");
  assert.equal(um.tvgId, "canal.um");
  assert.equal(um.sourceUrl, `${baseUrl}/live/${USER}/${PASS}/101.m3u8`);
  assert.equal(um.metadata.hasArchive, true);
  assert.equal(um.enabled, true);
  assert.ok(um.id);

  assert.equal(dois.name, "Canal Dois, com virgula");
  assert.equal(dois.group, "Esportes");

  assert.equal(tres.sourceUrl, "http://outrocdn.com/tres.m3u8");
  assert.equal(tres.group, "Sem categoria");

  assert.equal(parsed.warnings.length, 1);
  assert.ok(parsed.playlistMeta.epgUrl.includes("xmltv.php"));
});

test("respeita o limite de canais", async () => {
  const account = await authenticate(baseUrl, USER, PASS);
  const parsed = await importLiveCatalog({
    baseUrl,
    username: USER,
    password: PASS,
    account,
    maxChannels: 2,
  });
  assert.equal(parsed.channels.length, 2);
  assert.ok(parsed.warnings.some((w) => w.includes("Limite")));
});

test("mascara usuario e senha embutidos no caminho", () => {
  const masked = maskStreamUrl("http://painel:8080/live/joao/1234/55.m3u8");
  assert.equal(masked, "http://painel:8080/live/<redacted>/<redacted>/55.m3u8");
  assert.ok(!masked.includes("joao"));
  assert.ok(!masked.includes("1234"));
});

test("sem protocolo explicito, tenta http e https", () => {
  const parsed = parseXtreamInput("painel.exemplo.com:8080", "u", "p");
  assert.deepEqual(parsed.baseUrlCandidates, [
    "http://painel.exemplo.com:8080",
    "https://painel.exemplo.com:8080",
  ]);
});

test("com protocolo explicito, respeita a escolha do usuario", () => {
  const parsed = parseXtreamInput("https://painel.exemplo.com", "u", "p");
  assert.deepEqual(parsed.baseUrlCandidates, ["https://painel.exemplo.com"]);
});

test("host inexistente vira erro de DNS legivel", async () => {
  await assert.rejects(
    () => authenticate("http://nao-existe-mesmo-12345.invalid", USER, PASS),
    (err) => {
      assert.equal(err.code, "unreachable");
      assert.match(err.message, /DNS|nao existe/i);
      return true;
    }
  );
});

test("porta fechada vira erro de conexao recusada", async () => {
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));

  await assert.rejects(
    () => authenticate(`http://127.0.0.1:${port}`, USER, PASS),
    (err) => {
      assert.equal(err.code, "unreachable");
      assert.match(err.message, /recusou|inacessivel|respondeu/i);
      return true;
    }
  );
});
