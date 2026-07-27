const videoElement = document.getElementById("videoPlayer");
const fileInput = document.getElementById("m3uFile");
const urlInput = document.getElementById("m3uUrl");
const fileNameLabel = document.getElementById("fileName");

const heroSection = document.getElementById("hero");
const workspace = document.getElementById("workspace");

const channelList = document.getElementById("channelList");
const channelsEmpty = document.getElementById("channelsEmpty");
const channelCount = document.getElementById("channelCount");
const groupFilter = document.getElementById("groupFilter");
const searchField = document.getElementById("channelSearch");

const playerState = document.getElementById("playerState");
const playerStateText = document.getElementById("playerStateText");
const btnRetry = document.getElementById("btnRetry");
const nowPlayingName = document.getElementById("nowPlayingName");
const nowPlayingGroup = document.getElementById("nowPlayingGroup");
const liveBadge = document.getElementById("liveBadge");

const menuToggle = document.getElementById("menuToggle");
const topbarMenu = document.getElementById("topbarMenu");
const addButton = document.getElementById("btnAddPlaylist");
const toast = document.getElementById("toast");

const PAGE_SIZE = 60;

// Preencha para habilitar o proxy (ver api/stream.js). Ex.: "/api/stream?url="
const STREAM_PROXY = "";

const ATTEMPT_TIMEOUT = 12000;
const MAX_RECOVERIES = 2;

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
  all: "https://iptv-org.github.io/iptv/index.m3u",
  br: "Listas_IPTV/Canais_Abertos_BR.m3u",
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
let lastFailure = "";

function addPlaylist() {
  const newUrl = urlInput.value.trim();
  if (!newUrl) {
    showToast("Cole o endereço de uma lista M3U para continuar.", "error");
    urlInput.focus();
    return;
  }
  playlists.custom = newUrl;
  loadPlaylist("custom");
}

async function loadPlaylist(type) {
  const playlistURL = playlists[type];
  if (!playlistURL) return;

  setPlaylistLoading(true, type);

  try {
    const response = await fetch(playlistURL);
    if (!response.ok) throw new Error("HTTP " + response.status);

    parseM3U(await response.text());

    if (channels.length) {
      showToast(channels.length + " canais carregados.");
    } else {
      showToast("A lista foi lida, mas nenhum canal válido foi encontrado.", "error");
    }
  } catch (error) {
    console.error("Falha ao carregar a lista:", error);
    showToast(
      "Não foi possível carregar essa lista. Verifique o endereço e a conexão.",
      "error"
    );
  } finally {
    setPlaylistLoading(false, type);
  }
}

function loadLocalFile() {
  const file = fileInput.files[0];
  if (!file) return;

  fileNameLabel.textContent = file.name;
  fileNameLabel.dataset.loaded = "true";

  const reader = new FileReader();
  reader.onload = (event) => {
    parseM3U(event.target.result);
    if (channels.length) {
      showToast(channels.length + " canais carregados de " + file.name + ".");
    } else {
      showToast("Nenhum canal válido foi encontrado nesse arquivo.", "error");
    }
  };
  reader.onerror = () => showToast("Não foi possível ler o arquivo selecionado.", "error");
  reader.readAsText(file);
}

function parseM3U(m3uText) {
  const lines = m3uText.split(/\r?\n/);
  const byChannel = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXTINF")) continue;

    const separator = findNameSeparator(line);
    if (separator === -1) continue;

    const attributes = line.slice(0, separator);
    const rawName = line.slice(separator + 1).trim();

    let url = "";
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (!candidate || candidate.startsWith("#")) continue;
      url = candidate;
      break;
    }

    if (!url.startsWith("http")) continue;

    const quality = detectQuality(rawName);
    const name = cleanName(rawName, quality) || "Canal sem nome";
    const key = normalize(name) + "|" + quality;
    const existing = byChannel.get(key);

    if (existing) {
      if (!existing.urls.includes(url)) existing.urls.push(url);
      continue;
    }

    byChannel.set(key, {
      name,
      urls: [url],
      logo: getAttribute(attributes, "tvg-logo"),
      group: getAttribute(attributes, "group-title") || "Sem categoria",
      quality,
    });
  }

  channels = [...byChannel.values()];
  currentChannel = null;
  stopPlayback();

  buildGroupOptions();
  searchField.value = "";
  applyFilters();
  showWorkspace(channels.length > 0);

  if (channels.length) {
    nowPlayingName.textContent = "Nenhum canal selecionado";
    nowPlayingGroup.hidden = true;
    setPlayerState("idle", "Escolha um canal na lista para começar");
  }
}

// Primeira vírgula fora de aspas: nomes de canal podem conter vírgula.
function findNameSeparator(line) {
  let insideQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') insideQuotes = !insideQuotes;
    else if (char === "," && !insideQuotes) return i;
  }
  return -1;
}

function getAttribute(source, key) {
  const match = source.match(new RegExp(key + '="([^"]*)"', "i"));
  return match ? match[1].trim() : "";
}

function detectQuality(name) {
  const match = name.match(/\b(4K|UHD|FHD|HD²|HD2|HD|SD)\b/i);
  return match ? match[1].toUpperCase() : "";
}

function cleanName(name, quality) {
  if (!quality) return name;
  return name
    .replace(new RegExp("[\\[\\(]\\s*" + quality + "\\s*[\\]\\)]\\s*$", "i"), "")
    .trim();
}

function buildGroupOptions() {
  const groups = [...new Set(channels.map((channel) => channel.group))].sort((a, b) =>
    a.localeCompare(b, "pt-BR")
  );

  groupFilter.innerHTML = '<option value="">Todas as categorias</option>';
  groups.forEach((group) => {
    const option = document.createElement("option");
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

  channelList.innerHTML = "";
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
  const item = document.createElement("li");
  item.className = "channel";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "channel__btn";
  button.dataset.index = index;
  button.setAttribute("aria-current", channel === currentChannel ? "true" : "false");

  const logo = document.createElement("span");
  logo.className = "channel__logo";
  logo.textContent = channel.name.charAt(0).toUpperCase();
  if (channel.logo) {
    const image = document.createElement("img");
    image.src = channel.logo;
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.remove());
    logo.appendChild(image);
  }

  const meta = document.createElement("span");
  meta.className = "channel__meta";

  const name = document.createElement("span");
  name.className = "channel__name";
  name.textContent = channel.name;

  const group = document.createElement("span");
  group.className = "channel__group";
  group.textContent = channel.group;

  meta.append(name, group);
  button.append(logo, meta);

  if (channel.quality) {
    const quality = document.createElement("span");
    quality.className = "channel__quality";
    quality.textContent = channel.quality;
    button.appendChild(quality);
  }

  const equalizer = document.createElement("span");
  equalizer.className = "eq";
  equalizer.setAttribute("aria-hidden", "true");
  equalizer.innerHTML = "<i></i><i></i><i></i>";
  button.appendChild(equalizer);

  item.appendChild(button);
  return item;
}

// Renderização em blocos: listas públicas passam de 10 mil canais.
function updateSentinel() {
  const existing = channelList.querySelector(".sentinel");
  if (existing) existing.remove();

  if (renderCursor >= visibleChannels.length) return;

  const sentinel = document.createElement("li");
  sentinel.className = "sentinel";
  sentinel.setAttribute("aria-hidden", "true");
  channelList.appendChild(sentinel);

  if (!listObserver) {
    listObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) renderNextPage();
      },
      { root: channelList, rootMargin: "300px" }
    );
  }
  listObserver.observe(sentinel);
}

function normalize(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function loadChannel(channel) {
  const target = channel || currentChannel;
  if (!target) return;

  currentChannel = target;
  updateSelection();
  updateNowPlaying(target);

  attempts = buildAttempts(target);
  attemptIndex = 0;
  lastFailure = "";

  if (!attempts.length) {
    setPlayerState("error", "Este canal só tem fontes em HTTP, bloqueadas em páginas HTTPS.");
    return;
  }

  startAttempt();
}

// Cada fonte vira até duas tentativas: direta e, se houver proxy, através dele.
// Em página HTTPS a tentativa direta em HTTP é descartada: o navegador bloqueia.
function buildAttempts(channel) {
  const list = [];
  const pageIsHttps = location.protocol === "https:";

  channel.urls.forEach((url) => {
    const blockedByMixedContent = pageIsHttps && url.startsWith("http://");
    if (!blockedByMixedContent) list.push({ url, viaProxy: false });
    if (STREAM_PROXY) list.push({ url, viaProxy: true });
  });

  return list;
}

function startAttempt() {
  const attempt = attempts[attemptIndex];
  const source = attempt.viaProxy
    ? STREAM_PROXY + encodeURIComponent(attempt.url)
    : attempt.url;

  clearAttemptResources();
  recoveries = 0;
  setPlayerState("loading", describeAttempt());
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

  if (code === 404) return "A origem respondeu 404: esse canal não existe mais no servidor.";
  if (code === 401 || code === 403)
    return "A origem respondeu " + code + ": acesso negado, geobloqueio ou credencial expirada.";
  if (code >= 500) return "A origem respondeu " + code + ": servidor com problema.";
  if (/TimeOut$/i.test(data.details || "")) return "A origem não respondeu a tempo.";
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR)
    return "Requisição bloqueada antes de sair do navegador: CORS ou conteúdo misto.";
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR)
    return "O navegador não conseguiu decodificar esse stream.";

  return "Não foi possível reproduzir este canal.";
}

function nextAttempt() {
  clearTimeout(watchdog);
  attemptIndex++;

  if (attemptIndex < attempts.length) {
    startAttempt();
    return;
  }

  stopPlayback();
  const reason = lastFailure || "Não foi possível reproduzir este canal.";
  setPlayerState(
    "error",
    attempts.length > 1
      ? "Nenhuma das " + attempts.length + " fontes respondeu. " + reason
      : reason
  );
}

function describeAttempt() {
  const attempt = attempts[attemptIndex];
  if (attemptIndex === 0) return "Conectando ao canal…";
  const suffix = attempt.viaProxy ? " (via proxy)" : "";
  return "Tentando outra fonte " + (attemptIndex + 1) + "/" + attempts.length + suffix + "…";
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
  videoElement.removeAttribute("src");
  videoElement.load();
}

function playSafely() {
  const attempt = videoElement.play();
  if (attempt && typeof attempt.catch === "function") {
    attempt.catch((error) => {
      // Só o bloqueio de autoplay é benigno; o resto deixa a cadeia seguir.
      if (error && error.name === "NotAllowedError") {
        clearTimeout(watchdog);
        setPlayerState("idle", "Toque em play para iniciar a transmissão");
      }
    });
  }
}

function updateSelection() {
  channelList.querySelectorAll(".channel__btn").forEach((button) => {
    const channel = visibleChannels[Number(button.dataset.index)];
    button.setAttribute("aria-current", channel === currentChannel ? "true" : "false");
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
  btnRetry.hidden = state !== "error";
  liveBadge.hidden = state !== "playing";
}

function showWorkspace(hasChannels) {
  heroSection.hidden = hasChannels;
  workspace.hidden = !hasChannels;
}

function setPlaylistLoading(isLoading, type) {
  document.querySelectorAll("[data-playlist]").forEach((button) => {
    button.disabled = isLoading;
    if (button.dataset.playlist === type) {
      button.setAttribute("aria-current", isLoading ? "true" : "false");
    }
  });
  addButton.disabled = isLoading;
  addButton.textContent = isLoading ? "Carregando…" : "Adicionar lista";
}

function showToast(message, tone) {
  toast.textContent = message;
  toast.dataset.tone = tone || "info";
  toast.hidden = false;
  requestAnimationFrame(() => (toast.dataset.visible = "true"));

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.dataset.visible = "false";
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
  if (window.matchMedia("(max-width: 980px)").matches) {
    topbarMenu.dataset.open = "true";
    menuToggle.setAttribute("aria-expanded", "true");
  }
}

document.querySelectorAll("[data-playlist]").forEach((button) => {
  button.addEventListener("click", () => loadPlaylist(button.dataset.playlist));
});

addButton.addEventListener("click", addPlaylist);

urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addPlaylist();
});

fileInput.addEventListener("change", loadLocalFile);

document.getElementById("heroUrl").addEventListener("click", () => {
  openMenuIfCollapsed();
  urlInput.focus();
});

document.getElementById("heroFile").addEventListener("click", () => fileInput.click());

searchField.addEventListener("input", debounce(applyFilters, 140));
groupFilter.addEventListener("change", applyFilters);

channelList.addEventListener("click", (event) => {
  const button = event.target.closest(".channel__btn");
  if (!button) return;
  const channel = visibleChannels[Number(button.dataset.index)];
  if (channel) loadChannel(channel);
});

channelList.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const buttons = [...channelList.querySelectorAll(".channel__btn")];
  const index = buttons.indexOf(document.activeElement);
  if (index === -1) return;
  event.preventDefault();
  const next = buttons[index + (event.key === "ArrowDown" ? 1 : -1)];
  if (next) next.focus();
});

btnRetry.addEventListener("click", () => loadChannel());

videoElement.addEventListener("playing", () => {
  clearTimeout(watchdog);
  setPlayerState("playing");
});

videoElement.addEventListener("waiting", () =>
  setPlayerState("loading", "Carregando transmissão…")
);

videoElement.addEventListener("error", () => {
  if (!currentChannel || !nativeSource || videoElement.src !== nativeSource) return;
  nextAttempt();
});

menuToggle.addEventListener("click", () => {
  const isOpen = topbarMenu.dataset.open === "true";
  topbarMenu.dataset.open = String(!isOpen);
  menuToggle.setAttribute("aria-expanded", String(!isOpen));
});
