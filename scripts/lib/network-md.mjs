// NETWORK.md (§53.2) del pacchetto: tabella "categoria | host | quando | dichiarato in", host fra backtick, "none" per
// nessuno. Solo le righe della tabella contano (mai il testo libero). Letta da doctor --network e dall'AlmAdapter
// (WP09c giro 1, C1 c: un host Jira/Xray è ammesso solo se è SIA in config/xray.yaml SIA nella categoria alm).
// Solo moduli built-in.
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const NETWORK_CATEGORIES = ["jaggaer", "alm", "npm", "claude", "telemetry"];

// → { ok, categories: { <id>: { hosts[], none } }, error? }
export function parseNetworkMd(plugin = PLUGIN_ROOT) {
  let text;
  try { text = readFileSync(join(plugin, "NETWORK.md"), "utf8"); } catch { return { ok: false, categories: {}, error: "NETWORK.md assente nel pacchetto" }; }
  const categories = {};
  for (const line of text.split(/\r?\n/)) {
    const cells = /^\s*\|(.+)\|\s*$/.exec(line)?.[1].split("|").map((c) => c.trim());
    if (!cells || cells.length < 2 || !/^[a-z][a-z0-9-]*$/.test(cells[0]) || cells[0] === "categoria") continue;
    const hosts = [...cells[1].matchAll(/`(\*?\.?[a-z0-9-]+(?:\.[a-z0-9-]+)+)`/gi)].map((m) => m[1].toLowerCase());
    categories[cells[0]] = { hosts, none: /^none$/i.test(cells[1]) };
  }
  return Object.keys(categories).length ? { ok: true, categories } : { ok: false, categories, error: "NETWORK.md senza la tabella delle categorie" };
}

// "*.dominio" ammette i sottodomini (non il dominio nudo); altrimenti uguaglianza esatta.
export const hostMatches = (host, patterns) => patterns.some((p) => (p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p));

export function almHosts(plugin = PLUGIN_ROOT) { return parseNetworkMd(plugin).categories.alm?.hosts ?? []; }
