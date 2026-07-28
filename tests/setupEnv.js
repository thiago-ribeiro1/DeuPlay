// Import isto ANTES de qualquer modulo de server/*: config.js le process.env
// uma unica vez no import, entao as variaveis precisam existir primeiro.
// ALLOW_PRIVATE_HOSTS=true e necessario porque os testes usam um fixture
// server local (127.0.0.1), que a validacao de URL bloqueia por padrao.
process.env.ALLOW_PRIVATE_HOSTS = "true";
process.env.LOG_LEVEL = "error";
process.env.STREAM_START_TIMEOUT_MS = "4000";
process.env.STREAM_IDLE_TIMEOUT_MS = "3000";
process.env.PROBE_TIMEOUT_MS = "4000";
