import { randomUUID, createHash } from "node:crypto";

export function newId() {
  return randomUUID();
}

// ID estavel derivado da URL + headers: a mesma origem gera sempre a mesma chave,
// permitindo reutilizar processo/registro entre importacoes repetidas da playlist.
export function stableChannelId(sourceUrl, headers) {
  const basis = sourceUrl + "|" + JSON.stringify(headers || {});
  return createHash("sha1").update(basis).digest("hex").slice(0, 20);
}
