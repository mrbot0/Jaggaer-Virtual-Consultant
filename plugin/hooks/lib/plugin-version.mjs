// Versione del plugin in uso (doctor plugin-version e riga di SessionStart).
// 29/10/2026 (decisione dell'utente, punto 1 del piano): Claude Code tiene i plugin in cache per versione
// (~/.claude/plugins/cache/<marketplace>/<plugin>/<versione>/) e la versione era ferma a 0.1.0 da centinaia di commit,
// quindi gli utenti hanno usato per giorni codice vecchio senza saperlo. Si confronta la versione in uso (plugin.json
// della radice in esecuzione) con integrity.json (deve coincidere: rosso se no) e con la copia del plugin nei marketplace
// installati (known_marketplaces.json → installLocation, o marketplaces/*): giallo se lì c'è una versione più nuova
// (reinstallare). File mancanti ⇒ giallo «non verificabile», mai un'eccezione. Solo letture di pochi JSON piccoli
// (SessionStart: nessuna operazione pesante). Cartella dei plugin di Claude Code: $CLAUDE_CONFIG_DIR/plugins, se no
// ~/.claude/plugins.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

// -1 | 0 | 1, oppure null se una delle due non è una versione x.y.z (es. lo SHA che Claude Code usa senza version)
export function compareVersions(a, b) {
  const x = SEMVER.exec(String(a ?? "").trim());
  const y = SEMVER.exec(String(b ?? "").trim());
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d) return Math.sign(d); }
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1;    // 1.0.0 > 1.0.0-rc.1
  if (!y[4]) return -1;
  return x[4] < y[4] ? -1 : 1;
}

export function claudePluginsDir(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR) return resolve(env.CLAUDE_CONFIG_DIR, "plugins");
  return join(env.USERPROFILE || env.HOME || homedir(), ".claude", "plugins");
}

// Copie del plugin `name` nei marketplace installati → [{ marketplace, root, version }]
export function marketplaceCopies(name, env = process.env) {
  const dir = claudePluginsDir(env);
  const locs = new Map();
  const known = readJson(join(dir, "known_marketplaces.json"));
  if (known && typeof known === "object") for (const [mk, v] of Object.entries(known)) if (typeof v?.installLocation === "string" && v.installLocation) locs.set(resolve(v.installLocation), mk);
  try { for (const e of readdirSync(join(dir, "marketplaces"), { withFileTypes: true })) if (e.isDirectory()) { const p = resolve(dir, "marketplaces", e.name); if (!locs.has(p)) locs.set(p, e.name); } } catch { /* nessuna cartella dei marketplace */ }
  const out = [];
  for (const [loc, mk] of locs) {
    const m = readJson(join(loc, ".claude-plugin", "marketplace.json"));
    const entry = Array.isArray(m?.plugins) ? m.plugins.find((p) => p?.name === name) : null;
    if (m && Array.isArray(m.plugins) && !entry) continue;   // marketplace che non distribuisce questo plugin
    // sorgente relativa del marketplace (questo repository: "./plugin"); in mancanza, il percorso convenzionale plugin/
    const roots = [typeof entry?.source === "string" ? resolve(loc, entry.source) : null, join(loc, "plugin"), loc].filter(Boolean);
    let found = null;
    for (const root of roots) {
      const pj = readJson(join(root, ".claude-plugin", "plugin.json"));
      if (pj?.name === name && typeof pj.version === "string") { found = { marketplace: mk, root, version: pj.version }; break; }
    }
    if (!found && typeof entry?.version === "string") found = { marketplace: mk, root: loc, version: entry.version };
    if (found) out.push(found);
  }
  return out;
}

// → { status: green|yellow|red, running, integrity, available: [{ marketplace, root, version }], detail, fix }
export function pluginVersionStatus(plugin, env = process.env) {
  const manifest = readJson(join(plugin, ".claude-plugin", "plugin.json"));
  const running = typeof manifest?.version === "string" ? manifest.version : null;
  const name = typeof manifest?.name === "string" ? manifest.name : "jaggaer-virtual-consultant";
  if (!running) return { status: "yellow", running: null, integrity: null, available: [], detail: "versione del plugin in uso non verificabile: .claude-plugin/plugin.json illeggibile o senza version", fix: "reinstallare il plugin dal marketplace" };
  const im = readJson(join(plugin, "integrity.json"));
  const integrity = typeof im?.version === "string" ? im.version : null;
  let available = [];
  try { available = marketplaceCopies(name, env); } catch { available = []; }
  const base = { running, integrity, available };
  if (integrity && integrity !== running) {
    return { ...base, status: "red", detail: `plugin.json dice ${running} ma integrity.json ${integrity}: pacchetto incoerente`, fix: "reinstallare il plugin dal marketplace; nel repository del plugin: node scripts/admin/integrity.mjs build dopo aver cambiato la versione" };
  }
  const newer = available.filter((c) => compareVersions(c.version, running) === 1).sort((a, b) => compareVersions(b.version, a.version));
  if (newer.length) {
    const n = newer[0];
    return { ...base, status: "yellow", detail: `reinstalla il plugin: la copia in uso è ${running}, disponibile ${n.version} (marketplace ${n.marketplace})`, fix: `/plugin → ${name}@${n.marketplace}: aggiorna (o disinstalla e reinstalla), poi riavvia Claude Code; la copia in uso sta in ${plugin}` };
  }
  const missing = [integrity ? null : "integrity.json assente o illeggibile", available.length ? null : "nessun marketplace installato con il plugin"].filter(Boolean);
  const where = available.map((c) => `${c.marketplace} ${c.version}`).join(", ");
  if (missing.length) return { ...base, status: "yellow", detail: `versione in uso ${running}; non verificabile: ${missing.join("; ")}${where ? ` (marketplace: ${where})` : ""}`, fix: integrity ? "nessuna azione se il plugin gira dal repository (sviluppo); altrimenti reinstallarlo dal marketplace" : "reinstallare il plugin dal marketplace" };
  return { ...base, status: "green", detail: `versione in uso ${running}, concorde con integrity.json; marketplace: ${where}` };
}
