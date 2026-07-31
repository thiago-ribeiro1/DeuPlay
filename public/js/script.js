const videoElement = document.getElementById('videoPlayer');
const fileInput = document.getElementById('m3uFile');
const urlInput = document.getElementById('m3uUrl');
const fileNameLabel = document.getElementById('fileName');

const heroSection = document.getElementById('hero');
const workspace = document.getElementById('workspace');

const channelList = document.getElementById('channelList');
const channelsEmpty = document.getElementById('channelsEmpty');
const channelCount = document.getElementById('channelCount');
const groupFilter = document.getElementById('groupFilter');
const searchField = document.getElementById('channelSearch');

const playerState = document.getElementById('playerState');
const playerStateText = document.getElementById('playerStateText');
const btnRetry = document.getElementById('btnRetry');
const nowPlayingName = document.getElementById('nowPlayingName');
const nowPlayingGroup = document.getElementById('nowPlayingGroup');
const liveBadge = document.getElementById('liveBadge');

const menuToggle = document.getElementById('menuToggle');
const topbarMenu = document.getElementById('topbarMenu');
const addButton = document.getElementById('btnAddPlaylist');
const toast = document.getElementById('toast');

const PAGE_SIZE = 60;

const ATTEMPT_TIMEOUT = 12000;
const MAX_RECOVERIES = 2;
const BACKEND_HEARTBEAT_MS = 8000;
const BACKEND_TIMEOUT = 25000;

const STRATEGY_LABELS = {
  direct: 'reprodução direta',
  http_proxy: 'proxy HTTP',
  hls_proxy: 'proxy HLS',
  remux: 'remux local',
  copy_video_transcode_audio: 'conversão de áudio',
  transcode_video_copy_audio: 'conversão de vídeo',
  transcode_all: 'transcodificação completa',
  audio_only: 'somente áudio',
};

// Estrategias que efetivamente sobem um processo FFmpeg no backend (as
// demais — direct/http_proxy/hls_proxy — nao passam por FFmpeg).
const FFMPEG_STRATEGIES = new Set([
  'remux',
  'copy_video_transcode_audio',
  'transcode_video_copy_audio',
  'transcode_all',
  'audio_only',
]);

const HLS_CONFIG = {
  manifestLoadingTimeOut: 8000,
  manifestLoadingMaxRetry: 2,
  levelLoadingTimeOut: 8000,
  fragLoadingTimeOut: 12000,
  fragLoadingMaxRetry: 3,
  maxBufferLength: 20,
  liveSyncDurationCount: 3,
};

let playlists = {
  all: 'https://iptv-org.github.io/iptv/index.m3u',
  br: 'Listas_IPTV/Canais_Abertos_BR.m3u',
};

let channels = [];
let visibleChannels = [];
let currentChannel = null;
let hlsInstance = null;
let renderCursor = 0;
let listObserver = null;
let nativeSource = null;
let toastTimer = null;
let attempts = [];
let attemptIndex = 0;
let recoveries = 0;
let watchdog = null;
let lastFailure = '';
let playbackMode = 'backend_only'; // mesmo default do backend; sobrescrito abaixo
let triedBackendFallback = false;
let currentSession = null;
let heartbeatTimer = null;

// loadChannel aguarda esta promise antes de decidir o fluxo de reproducao,
// entao nunca ha corrida entre "clicou no canal" e "ainda nao sei o modo".
const configReady = fetch('/api/config')
  .then((response) => (response.ok ? response.json() : null))
  .then((data) => {
    if (data && data.playbackMode) playbackMode = data.playbackMode;
    console.info('[iptv] modo de reprodução:', playbackMode);
  })
  .catch(() => {
    console.warn('[iptv] /api/config indisponível, mantendo modo padrão:', playbackMode);
  });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addPlaylist() {
  const newUrl = urlInput.value.trim();
  if (!newUrl) {
    showToast('Cole o endereço de uma lista M3U para continuar.', 'error');
    urlInput.focus();
    return;
  }
  playlists.custom = newUrl;
  loadPlaylist('custom');
}

async function loadPlaylist(type) {
  const playlistURL = playlists[type];
  if (!playlistURL) return;

  setPlaylistLoading(true, type);

  try {
    const response = await fetch(playlistURL);
    if (!response.ok) throw new Error('HTTP ' + response.status);

    const count = await parseM3U(await response.text(), type);

    if (count) {
      showToast(count + ' canais carregados.');
    } else {
      showToast('A lista foi lida, mas nenhum canal válido foi encontrado.', 'error');
    }
  } catch (error) {
    console.error('Falha ao carregar a lista:', error);
    showToast('Não foi possível carregar essa lista. Verifique o endereço e a conexão.', 'error');
  } finally {
    setPlaylistLoading(false, type);
  }
}

function loadLocalFile() {
  const file = fileInput.files[0];
  if (!file) return;

  fileNameLabel.textContent = file.name;
  fileNameLabel.dataset.loaded = 'true';

  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const count = await parseM3U(event.target.result, file.name);
      if (count) {
        showToast(count + ' canais carregados de ' + file.name + '.');
      } else {
        showToast('Nenhum canal válido foi encontrado nesse arquivo.', 'error');
      }
    } catch (error) {
      console.error('Falha ao importar o arquivo no servidor local:', error);
      showToast('Não foi possível importar esse arquivo no servidor local.', 'error');
    }
  };
  reader.onerror = () => showToast('Não foi possível ler o arquivo selecionado.', 'error');
  reader.readAsText(file);
}

// Parser M3U roda no BACKEND (server/services/m3uParser.js): frontend e
// backend enxergam o mesmo catalogo e os mesmos IDs de canal, permitindo
// referenciar o canal por ID no playback em vez de reenviar a URL solta.
async function parseM3U(m3uText, name) {
  const importResponse = await fetch('/api/playlists/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceType: 'text', name, text: m3uText }),
  });
  const imported = await importResponse.json();
  if (!importResponse.ok) {
    throw new Error(imported.error || 'Falha ao importar a playlist no servidor local.');
  }

  return renderImportedPlaylist(imported.id);
}

// Compartilhado por M3U e Xtream: os dois importam pelo backend e caem no
// mesmo /api/playlists/:id/channels, entao a renderizacao e identica.
async function renderImportedPlaylist(playlistId) {
  const channelsResponse = await fetch('/api/playlists/' + playlistId + '/channels');
  if (!channelsResponse.ok) {
    throw new Error('Falha ao carregar os canais importados.');
  }

  channels = await channelsResponse.json();
  currentChannel = null;
  stopPlayback();

  buildGroupOptions();
  searchField.value = '';
  applyFilters();
  showWorkspace(channels.length > 0);

  if (channels.length) {
    nowPlayingName.textContent = 'Nenhum canal selecionado';
    nowPlayingGroup.hidden = true;
    setPlayerState('idle', 'Escolha um canal na lista para começar');
  }

  console.info(
    '[iptv] playlist importada pelo backend:',
    playlistId,
    '-',
    channels.length,
    'canais'
  );
  return channels.length;
}

function detectQuality(name) {
  const match = name.match(/\b(4K|UHD|FHD|HD²|HD2|HD|SD)\b/i);
  return match ? match[1].toUpperCase() : '';
}

function cleanName(name, quality) {
  if (!quality) return name;
  return name.replace(new RegExp('[\\[\\(]\\s*' + quality + '\\s*[\\]\\)]\\s*$', 'i'), '').trim();
}

function buildGroupOptions() {
  const groups = [...new Set(channels.map((channel) => channel.group))].sort((a, b) =>
    a.localeCompare(b, 'pt-BR')
  );

  groupFilter.innerHTML = '<option value="">Todas as categorias</option>';
  groups.forEach((group) => {
    const option = document.createElement('option');
    option.value = group;
    option.textContent = group;
    groupFilter.appendChild(option);
  });
}

function applyFilters() {
  const term = normalize(searchField.value.trim());
  const group = groupFilter.value;

  visibleChannels = channels.filter((channel) => {
    const matchesGroup = !group || channel.group === group;
    const matchesTerm = !term || normalize(channel.name).includes(term);
    return matchesGroup && matchesTerm;
  });

  channelCount.textContent = visibleChannels.length;
  channelsEmpty.hidden = visibleChannels.length > 0 || channels.length === 0;

  channelList.innerHTML = '';
  renderCursor = 0;
  renderNextPage();
  channelList.scrollTop = 0;
}

function renderNextPage() {
  const slice = visibleChannels.slice(renderCursor, renderCursor + PAGE_SIZE);
  const fragment = document.createDocumentFragment();

  slice.forEach((channel, offset) => {
    fragment.appendChild(createChannelItem(channel, renderCursor + offset));
  });

  renderCursor += slice.length;
  channelList.appendChild(fragment);
  updateSentinel();
}

function createChannelItem(channel, index) {
  const item = document.createElement('li');
  item.className = 'channel';

  const quality = detectQuality(channel.name);
  const displayName = cleanName(channel.name, quality) || channel.name;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'channel__btn';
  button.dataset.index = index;
  button.setAttribute('aria-current', channel === currentChannel ? 'true' : 'false');

  const logo = document.createElement('span');
  logo.className = 'channel__logo';
  logo.textContent = displayName.charAt(0).toUpperCase();
  if (channel.logoUrl) {
    const image = document.createElement('img');
    image.src = channel.logoUrl;
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.remove());
    logo.appendChild(image);
  }

  const meta = document.createElement('span');
  meta.className = 'channel__meta';

  const name = document.createElement('span');
  name.className = 'channel__name';
  name.textContent = displayName;

  const group = document.createElement('span');
  group.className = 'channel__group';
  group.textContent = channel.group;

  meta.append(name, group);
  button.append(logo, meta);

  if (quality) {
    const qualityBadge = document.createElement('span');
    qualityBadge.className = 'channel__quality';
    qualityBadge.textContent = quality;
    button.appendChild(qualityBadge);
  }

  const equalizer = document.createElement('span');
  equalizer.className = 'eq';
  equalizer.setAttribute('aria-hidden', 'true');
  equalizer.innerHTML = '<i></i><i></i><i></i>';
  button.appendChild(equalizer);

  item.appendChild(button);
  return item;
}

// Renderização em blocos: listas públicas passam de 10 mil canais.
function updateSentinel() {
  const existing = channelList.querySelector('.sentinel');
  if (existing) existing.remove();

  if (renderCursor >= visibleChannels.length) return;

  const sentinel = document.createElement('li');
  sentinel.className = 'sentinel';
  sentinel.setAttribute('aria-hidden', 'true');
  channelList.appendChild(sentinel);

  if (!listObserver) {
    listObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) renderNextPage();
      },
      { root: channelList, rootMargin: '300px' }
    );
  }
  listObserver.observe(sentinel);
}

function normalize(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

async function loadChannel(channel) {
  const target = channel || currentChannel;
  if (!target) return;

  currentChannel = target;
  updateSelection();
  updateNowPlaying(target);
  endBackendSession(false);

  // Nunca decide o fluxo antes de saber o PLAYBACK_MODE real do backend:
  // evita a corrida "usuário clicou antes do /api/config responder" que
  // fazia a reprodução direta antiga rodar por engano.
  setPlayerState('loading', 'Analisando…');
  await configReady;
  if (target !== currentChannel) return; // usuário já trocou de canal

  triedBackendFallback = playbackMode !== 'direct_preferred';
  attempts = playbackMode === 'direct_preferred' ? buildAttempts(target) : [];
  attemptIndex = 0;
  lastFailure = '';

  if (!attempts.length) {
    startBackendPlayback(target);
    return;
  }

  startAttempt();
}

// Uma unica tentativa direta por canal. Em pagina HTTPS a URL em HTTP e
// descartada (mixed content). So usado em PLAYBACK_MODE=direct_preferred;
// nos demais modos o backend decide o proxy sozinho (httpProxy.js/hlsProxy.js).
function buildAttempts(channel) {
  const url = channel.sourceUrl;
  if (!url) return [];

  const pageIsHttps = location.protocol === 'https:';
  const blockedByMixedContent = pageIsHttps && url.startsWith('http://');
  return blockedByMixedContent ? [] : [{ url }];
}

function startAttempt() {
  const attempt = attempts[attemptIndex];
  const source = attempt.url;

  clearAttemptResources();
  recoveries = 0;
  setPlayerState('loading', describeAttempt());
  watchdog = setTimeout(nextAttempt, ATTEMPT_TIMEOUT);

  if (isHlsUrl(attempt.url) && window.Hls && Hls.isSupported()) {
    hlsInstance = new Hls(HLS_CONFIG);
    hlsInstance.loadSource(source);
    hlsInstance.attachMedia(videoElement);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, playSafely);
    hlsInstance.on(Hls.Events.ERROR, (event, data) => {
      if (data && data.fatal) recoverOrAdvance(data);
    });
    return;
  }

  // mp4, ts progressivo ou HLS nativo no Safari: o hls.js não serve aqui.
  nativeSource = source;
  videoElement.src = source;
  playSafely();
}

function recoverOrAdvance(data) {
  lastFailure = describeFailure(data);

  if (recoveries < MAX_RECOVERIES && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
    recoveries++;
    hlsInstance.startLoad();
    return;
  }
  if (recoveries < MAX_RECOVERIES && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
    recoveries++;
    hlsInstance.recoverMediaError();
    return;
  }
  nextAttempt();
}

// O código HTTP separa canal morto de bloqueio: sem isso todo erro vira
// "fora do ar" e você não sabe se o problema é da origem ou do navegador.
function describeFailure(data) {
  const code = data.response && data.response.code;

  if (code === 404) return 'A origem respondeu 404: esse canal não existe mais no servidor.';
  if (code === 401 || code === 403)
    return 'A origem respondeu ' + code + ': acesso negado, geobloqueio ou credencial expirada.';
  if (code >= 500) return 'A origem respondeu ' + code + ': servidor com problema.';
  if (/TimeOut$/i.test(data.details || '')) return 'A origem não respondeu a tempo.';
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR)
    return 'Requisição bloqueada antes de sair do navegador: CORS ou conteúdo misto.';
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR)
    return 'O navegador não conseguiu decodificar esse stream.';

  return 'Não foi possível reproduzir este canal.';
}

function nextAttempt() {
  clearTimeout(watchdog);
  attemptIndex++;

  if (attemptIndex < attempts.length) {
    startAttempt();
    return;
  }

  if (!triedBackendFallback) {
    triedBackendFallback = true;
    startBackendPlayback(currentChannel);
    return;
  }

  stopPlayback();
  const reason = lastFailure || 'Não foi possível reproduzir este canal.';
  setPlayerState(
    'error',
    attempts.length > 1 ? 'Nenhuma das ' + attempts.length + ' fontes respondeu. ' + reason : reason
  );
}

// Pede ao servidor local (ffprobe + FFmpeg) para decidir e preparar a
// reprodução deste canal. O canal já existe no backend com este ID
// (parseM3U), entao usamos POST /api/channels/:id/playback em vez da URL solta.
async function startBackendPlayback(channel) {
  if (!channel) return;

  if (!channel.id) {
    setPlayerState('error', 'Este canal ainda não foi importado pelo servidor local.');
    return;
  }

  clearAttemptResources();
  setPlayerState('loading', 'Analisando…');
  console.info('[iptv] POST /api/channels/' + channel.id + '/playback (' + channel.name + ')');

  let response;
  let data;
  try {
    response = await fetch('/api/channels/' + channel.id + '/playback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    data = await response.json();
  } catch {
    setPlayerState('error', 'Falha ao contatar o servidor local.');
    return;
  }

  if (channel !== currentChannel) return; // usuário já trocou de canal

  if (!response.ok || data.status !== 'ready') {
    const message =
      data && data.diagnosticMessage
        ? data.diagnosticMessage
        : 'O servidor local não conseguiu reproduzir este canal.';
    console.warn(
      '[iptv] playback falhou:',
      data && data.reason,
      '| estratégias tentadas:',
      data && data.attemptedProfiles
    );
    setPlayerState('error', message);
    return;
  }

  console.info(
    '[iptv] estratégia escolhida:',
    data.strategy,
    '| sessão:',
    data.sessionId,
    '| url:',
    data.playbackUrl
  );
  currentSession = { id: data.sessionId };

  // Narra estágios que já aconteceram no backend (probe → decisão → FFmpeg
  // pronto): o pedido é síncrono, aqui só exibimos a sequência, não progresso real.
  setPlayerState('loading', 'Estratégia: ' + describeStrategy(data.strategy));
  await sleep(200);
  if (channel !== currentChannel) return;

  if (FFMPEG_STRATEGIES.has(data.strategy)) {
    setPlayerState('loading', 'Iniciando FFmpeg…');
    await sleep(200);
    if (channel !== currentChannel) return;

    setPlayerState('loading', 'Aguardando segmentos…');
    await sleep(150);
    if (channel !== currentChannel) return;
  }

  startHeartbeat();
  playBackendUrl(data.playbackUrl, data.strategy);
}

function describeStrategy(strategy) {
  return STRATEGY_LABELS[strategy] || strategy || 'servidor local';
}

function playBackendUrl(url, strategy) {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    setPlayerState('error', 'O servidor local demorou demais para iniciar este canal.');
  }, BACKEND_TIMEOUT);

  // playbackUrl vem sempre relativa (ex.: /api/playback/<sessão>/index.m3u8
  // ou /proxy) — o navegador resolve para a origem local, nunca a URL externa.
  console.info('[iptv] HLS.js carregando URL local:', url, '(estratégia ' + strategy + ')');

  if (window.Hls && Hls.isSupported()) {
    hlsInstance = new Hls(HLS_CONFIG);
    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(videoElement);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      clearTimeout(watchdog);
      setPlayerState('loading', 'Reproduzindo HLS local…');
      playSafely();
    });
    hlsInstance.on(Hls.Events.ERROR, (event, data) => {
      if (!data || !data.fatal) return;
      clearTimeout(watchdog);
      lastFailure = describeFailure(data);
      console.warn('[iptv] erro fatal do HLS.js na URL local:', lastFailure);
      endBackendSession(false);
      setPlayerState('error', lastFailure);
    });
    return;
  }

  nativeSource = url;
  videoElement.src = url;
  playSafely();
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!currentSession) return;
    fetch('/api/playback/' + currentSession.id + '/heartbeat', { method: 'POST' }).catch(() => {});
  }, BACKEND_HEARTBEAT_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// useBeacon=true ao fechar a aba (sendBeacon sobrevive a navegacao/unload);
// useBeacon=false ao trocar de canal, onde um fetch normal ja e suficiente.
function endBackendSession(useBeacon) {
  stopHeartbeat();
  if (!currentSession) return;
  const id = currentSession.id;
  currentSession = null;

  if (useBeacon && navigator.sendBeacon) {
    navigator.sendBeacon('/api/playback/' + id + '/stop');
  } else {
    fetch('/api/playback/' + id, { method: 'DELETE', keepalive: true }).catch(() => {});
  }
}

function describeAttempt() {
  return 'Conectando ao canal…';
}

function isHlsUrl(url) {
  return /\.m3u8(\?|#|$)/i.test(url);
}

function clearAttemptResources() {
  clearTimeout(watchdog);
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  nativeSource = null;
  videoElement.pause();
}

function stopPlayback() {
  clearAttemptResources();
  endBackendSession(false);
  videoElement.removeAttribute('src');
  videoElement.load();
}

function playSafely() {
  const attempt = videoElement.play();
  if (attempt && typeof attempt.catch === 'function') {
    attempt.catch((error) => {
      // Só o bloqueio de autoplay é benigno; o resto deixa a cadeia seguir.
      if (error && error.name === 'NotAllowedError') {
        clearTimeout(watchdog);
        setPlayerState('idle', 'Toque em play para iniciar a transmissão');
      }
    });
  }
}

function updateSelection() {
  channelList.querySelectorAll('.channel__btn').forEach((button) => {
    const channel = visibleChannels[Number(button.dataset.index)];
    button.setAttribute('aria-current', channel === currentChannel ? 'true' : 'false');
  });
}

function updateNowPlaying(channel) {
  nowPlayingName.textContent = channel.name;
  nowPlayingGroup.textContent = channel.group;
  nowPlayingGroup.hidden = !channel.group;
}

function setPlayerState(state, message) {
  playerState.dataset.state = state;
  if (message) playerStateText.textContent = message;
  btnRetry.hidden = state !== 'error';
  liveBadge.hidden = state !== 'playing';
}

function showWorkspace(hasChannels) {
  heroSection.hidden = hasChannels;
  workspace.hidden = !hasChannels;
}

function setPlaylistLoading(isLoading, type) {
  document.querySelectorAll('[data-playlist]').forEach((button) => {
    button.disabled = isLoading;
    if (button.dataset.playlist === type) {
      button.setAttribute('aria-current', isLoading ? 'true' : 'false');
    }
  });
  addButton.disabled = isLoading;
  addButton.textContent = isLoading ? 'Carregando…' : 'Adicionar lista';
}

function showToast(message, tone) {
  toast.textContent = message;
  toast.dataset.tone = tone || 'info';
  toast.hidden = false;
  requestAnimationFrame(() => (toast.dataset.visible = 'true'));

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.dataset.visible = 'false';
    setTimeout(() => (toast.hidden = true), 250);
  }, 4200);
}

function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

function openMenuIfCollapsed() {
  if (window.matchMedia('(max-width: 980px)').matches) {
    topbarMenu.dataset.open = 'true';
    menuToggle.setAttribute('aria-expanded', 'true');
  }
}

document.querySelectorAll('[data-playlist]').forEach((button) => {
  button.addEventListener('click', () => loadPlaylist(button.dataset.playlist));
});

addButton.addEventListener('click', addPlaylist);

urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addPlaylist();
});

fileInput.addEventListener('change', loadLocalFile);

document.getElementById('heroUrl').addEventListener('click', () => {
  openMenuIfCollapsed();
  urlInput.focus();
});

document.getElementById('heroFile').addEventListener('click', () => fileInput.click());

searchField.addEventListener('input', debounce(applyFilters, 140));
groupFilter.addEventListener('change', applyFilters);

channelList.addEventListener('click', (event) => {
  const button = event.target.closest('.channel__btn');
  if (!button) return;
  const channel = visibleChannels[Number(button.dataset.index)];
  if (channel) loadChannel(channel);
});

channelList.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const buttons = [...channelList.querySelectorAll('.channel__btn')];
  const index = buttons.indexOf(document.activeElement);
  if (index === -1) return;
  event.preventDefault();
  const next = buttons[index + (event.key === 'ArrowDown' ? 1 : -1)];
  if (next) next.focus();
});

btnRetry.addEventListener('click', () => loadChannel());

videoElement.addEventListener('playing', () => {
  clearTimeout(watchdog);
  setPlayerState('playing');
});

videoElement.addEventListener('waiting', () =>
  setPlayerState('loading', 'Carregando transmissão…')
);

videoElement.addEventListener('error', () => {
  if (!currentChannel || !nativeSource || videoElement.src !== nativeSource) return;
  nextAttempt();
});

menuToggle.addEventListener('click', () => {
  const isOpen = topbarMenu.dataset.open === 'true';
  topbarMenu.dataset.open = String(!isOpen);
  menuToggle.setAttribute('aria-expanded', String(!isOpen));
});

window.addEventListener('pagehide', () => endBackendSession(true));
window.addEventListener('beforeunload', () => endBackendSession(true));

/* ---------------------------- Login Xtream ---------------------------- */

const xtreamPanel = document.getElementById('xtreamPanel');
const xtreamForm = document.getElementById('xtreamForm');
const xtreamHost = document.getElementById('xtreamHost');
const xtreamUser = document.getElementById('xtreamUser');
const xtreamPass = document.getElementById('xtreamPass');
const xtreamRemember = document.getElementById('xtreamRemember');
const xtreamStatus = document.getElementById('xtreamStatus');
const xtreamSubmit = document.getElementById('btnXtreamSubmit');
const xtreamForget = document.getElementById('btnXtreamForget');
const xtreamPassphrase = document.getElementById('xtreamPassphrase');
const xtreamPassphraseBlock = document.getElementById('xtreamPassphraseBlock');
const xtreamPassphraseHint = document.getElementById('xtreamPassphraseHint');
const xtreamCredentialFields = document.getElementById('xtreamCredentialFields');

let hasSavedCredentials = false;

function openXtream() {
  xtreamPanel.hidden = false;
  document.getElementById('btnXtreamOpen').setAttribute('aria-expanded', 'true');
  loadSavedCredentials();
  xtreamHost.focus();
}

function closeXtream() {
  xtreamPanel.hidden = true;
  document.getElementById('btnXtreamOpen').setAttribute('aria-expanded', 'false');
  xtreamStatus.textContent = '';
  xtreamStatus.dataset.tone = '';
}

// O backend so informa SE existe credencial salva: host, usuario e senha
// ficam cifrados e nem ele consegue ler sem a senha de protecao.
async function loadSavedCredentials() {
  try {
    const response = await fetch('/api/xtream/saved');
    const saved = await response.json();

    hasSavedCredentials = Boolean(saved.saved);
    xtreamForget.hidden = !hasSavedCredentials;
    xtreamCredentialFields.hidden = hasSavedCredentials;
    xtreamPassphraseBlock.hidden = false;

    if (hasSavedCredentials) {
      xtreamPassphraseHint.textContent =
        'Digite a senha de proteção para desbloquear as credenciais salvas.';
      xtreamPassphrase.focus();
    } else {
      xtreamPassphraseHint.textContent =
        'Na próxima vez, use apenas esta senha para entrar. Se esquecê-la, será necessário digitar todos os dados novamente.';
    }
  } catch {
    hasSavedCredentials = false;
    xtreamForget.hidden = true;
  }
}

async function forgetCredentials() {
  await fetch('/api/xtream/saved', { method: 'DELETE' });
  hasSavedCredentials = false;
  xtreamForget.hidden = true;
  xtreamCredentialFields.hidden = false;
  xtreamHost.value = '';
  xtreamUser.value = '';
  xtreamPass.value = '';
  xtreamPassphrase.value = '';
  xtreamRemember.checked = false;
  xtreamStatus.dataset.tone = '';
  xtreamStatus.textContent = 'Credenciais removidas do servidor.';
  loadSavedCredentials();
}

function describeAccount(account) {
  if (!account) return '';
  const parts = [];
  if (account.expiresAt) {
    const date = new Date(account.expiresAt);
    const days = Math.ceil((date - Date.now()) / 86400000);
    parts.push(
      'assinatura até ' +
        date.toLocaleDateString('pt-BR') +
        (days <= 7 && days >= 0 ? ' (faltam ' + days + ' dias)' : '')
    );
  }
  if (account.maxConnections) {
    parts.push(account.activeConnections + '/' + account.maxConnections + ' conexões em uso');
  }
  if (account.isTrial) parts.push('conta de teste');
  return parts.join(' · ');
}

async function submitXtream(event) {
  event.preventDefault();

  const host = xtreamHost.value.trim();
  const username = xtreamUser.value.trim();
  const password = xtreamPass.value;
  const passphrase = xtreamPassphrase.value;

  // Com credencial salva o formulario pede so a senha de protecao.
  const useSaved = hasSavedCredentials;

  if (useSaved && !passphrase) {
    xtreamStatus.textContent = 'Digite a senha de proteção.';
    xtreamStatus.dataset.tone = 'error';
    return;
  }
  if (!useSaved && !host) {
    xtreamStatus.textContent = 'Informe o endereço do servidor.';
    xtreamStatus.dataset.tone = 'error';
    return;
  }
  if (!useSaved && xtreamRemember.checked && !passphrase) {
    xtreamStatus.textContent = 'Defina uma senha de proteção para salvar as credenciais.';
    xtreamStatus.dataset.tone = 'error';
    return;
  }

  const payload = useSaved
    ? { useSaved: true, passphrase }
    : { host, username, password, remember: xtreamRemember.checked, passphrase };

  xtreamSubmit.disabled = true;
  xtreamSubmit.textContent = 'Conectando…';
  xtreamStatus.dataset.tone = '';
  xtreamStatus.textContent = 'Autenticando no painel…';

  try {
    const response = await fetch('/api/xtream/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Falha ao conectar ao painel.');
    }

    const count = await renderImportedPlaylist(result.id);

    xtreamPassphrase.value = '';
    xtreamPass.value = '';
    closeXtream();
    const summary = describeAccount(result.account);
    showToast(count + ' canais carregados' + (summary ? ' · ' + summary : '') + '.');
  } catch (error) {
    xtreamStatus.textContent = error.message;
    xtreamStatus.dataset.tone = 'error';
  } finally {
    xtreamSubmit.disabled = false;
    xtreamSubmit.textContent = 'Conectar';
  }
}

document.getElementById('btnXtreamOpen').addEventListener('click', () => {
  if (xtreamPanel.hidden) openXtream();
  else closeXtream();
});

document.getElementById('btnXtreamCancel').addEventListener('click', closeXtream);
xtreamForget.addEventListener('click', forgetCredentials);
xtreamForm.addEventListener('submit', submitXtream);

xtreamPanel.addEventListener('click', (event) => {
  if (event.target === xtreamPanel) closeXtream();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !xtreamPanel.hidden) closeXtream();
});
