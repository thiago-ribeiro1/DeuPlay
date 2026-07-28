import { newId } from "./utils/ids.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import * as processManager from "./services/processManager.js";

/** Armazenamento inteiramente em memoria: uma unica instancia, um unico usuario. */
const playlists = new Map();
const channels = new Map();
const sessions = new Map();

export function importPlaylist({ name, sourceType, sourceRef, parsed }) {
  const id = newId();
  const now = new Date().toISOString();

  for (const channel of parsed.channels) {
    channels.set(channel.id, channel);
  }

  const record = {
    id,
    name: name || sourceRef || "Playlist",
    sourceType,
    sourceRef,
    channelIds: parsed.channels.map((c) => c.id),
    warnings: parsed.warnings,
    duplicates: parsed.duplicates,
    epgUrl: parsed.playlistMeta?.epgUrl || undefined,
    importedAt: now,
  };
  playlists.set(id, record);
  logger.info("playlist_imported", { id, channels: record.channelIds.length, duplicates: record.duplicates });
  return record;
}

export function listPlaylists() {
  return [...playlists.values()];
}

export function getPlaylist(id) {
  return playlists.get(id);
}

export function listChannelsForPlaylist(playlistId) {
  const playlist = playlists.get(playlistId);
  if (!playlist) return undefined;
  return playlist.channelIds.map((id) => channels.get(id)).filter(Boolean);
}

export function getChannel(id) {
  return channels.get(id);
}

export function listChannels() {
  return [...channels.values()];
}

// Permite registrar um canal avulso (URL solta enviada pelo player) sem
// exigir importacao completa de playlist antes de testar/reproduzir.
export function upsertAdHocChannel({ name, sourceUrl, sourceHeaders, id }) {
  const now = new Date().toISOString();
  const existing = id ? channels.get(id) : undefined;
  const channel = existing || {
    id: id || newId(),
    name: name || sourceUrl,
    group: "Avulso",
    sourceUrl,
    sourceHeaders,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  channel.updatedAt = now;
  channels.set(channel.id, channel);
  return channel;
}

export function createSession({ channelId, viewerId, strategy, status, playbackUrl, processKey }) {
  const id = newId();
  const now = Date.now();
  const session = {
    id,
    channelId,
    viewerId: viewerId || id,
    strategy,
    status,
    playbackUrl,
    processKey,
    startedAt: now,
    lastHeartbeatAt: now,
    expiresAt: now + config.viewerSessionTimeoutMs,
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id) {
  return sessions.get(id);
}

export function updateSession(id, patch) {
  const session = sessions.get(id);
  if (!session) return undefined;
  Object.assign(session, patch);
  return session;
}

export function heartbeatSession(id) {
  const session = sessions.get(id);
  if (!session) return undefined;
  session.lastHeartbeatAt = Date.now();
  session.expiresAt = session.lastHeartbeatAt + config.viewerSessionTimeoutMs;
  return session;
}

export function deleteSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.processKey) {
    processManager.removeViewer(session.processKey, session.viewerId);
  }
  sessions.delete(id);
  return true;
}

export function listSessions() {
  return [...sessions.values()];
}

/** Varredura periodica: expira sessoes sem heartbeat recente. */
export function startSessionSweep() {
  return setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (session.status === "expired") continue;
      if (now > session.expiresAt) {
        session.status = "expired";
        if (session.processKey) {
          processManager.removeViewer(session.processKey, session.viewerId);
        }
        logger.info("session_expired", { id: session.id, channelId: session.channelId });
      }
    }
  }, 5000);
}
