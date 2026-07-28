import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

/** Remove qualquer diretorio de stream deixado por uma execucao anterior (orfaos). */
export async function wipeStreamsOnBoot() {
  await fs.mkdir(config.streamsDir, { recursive: true });
  const entries = (await fs.readdir(config.streamsDir)).filter((entry) => entry !== ".gitkeep");
  await Promise.all(
    entries.map((entry) => fs.rm(path.join(config.streamsDir, entry), { recursive: true, force: true }))
  );
  if (entries.length) {
    logger.info("orphan_streams_cleared", { count: entries.length });
  }
}

export function getStreamsDiskUsageBytes() {
  let total = 0;

  function walk(dir) {
    let items;
    try {
      items = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else {
        try {
          total += fsSync.statSync(full).size;
        } catch {
          // Arquivo pode ter sido removido pelo proprio FFmpeg (delete_segments) entre a listagem e o stat.
        }
      }
    }
  }

  walk(config.streamsDir);
  return total;
}
