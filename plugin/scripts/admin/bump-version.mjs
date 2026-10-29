// admin bump-version (29/10/2026, decisione dell'utente: «quando viene creato un nuovo branch alza la versione in
// plugin/.claude-plugin/plugin.json»). Claude Code tiene i plugin in cache per versione: con la stessa versione la copia
// installata non si rinnova. Alza la versione (semver) in plugin/.claude-plugin/plugin.json, plugin/package.json,
// plugin/package-lock.json (radice e pacchetto "") e nella voce del plugin di .claude-plugin/marketplace.json alla radice del
// repository (se c'è), aggiunge in testa a plugin/CHANGELOG.md una voce da completare e rigenera integrity.json.
//   node scripts/admin/bump-version.mjs [patch|minor|major] [--branch <nome>] [--dry-run|--check] [--json] [--help]
// Lo chiama l'hook git .githooks/post-checkout alla creazione di un branch (core.hooksPath = .githooks).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isMain } from "../lib/is-main.mjs";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(PLUGIN, "..");
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(v, kind = "minor") {
  const m = SEMVER.exec(String(v ?? ""));
  if (!m) throw new Error(`versione non semver: ${v}`);
  const [maj, min, pat] = m.slice(1).map(Number);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  if (kind === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`tipo di aumento ignoto: ${kind} (patch, minor, major)`);
}

const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const writeJson = (f, o) => writeFileSync(f, `${JSON.stringify(o, null, 2)}\n`);

export function bump({ plugin = PLUGIN, repo = REPO, kind = "minor", branch = null, dryRun = false, integrity = true, today = new Date().toISOString().slice(0, 10) } = {}) {
  const pj = join(plugin, ".claude-plugin", "plugin.json");
  const manifest = readJson(pj);
  const from = manifest.version;
  const to = nextVersion(from, kind);
  const files = [];
  const set = (file, fn) => { if (!existsSync(file)) return; if (!dryRun) fn(file); files.push(file); };
  set(pj, (f) => { const o = readJson(f); o.version = to; writeJson(f, o); });
  set(join(plugin, "package.json"), (f) => { const o = readJson(f); o.version = to; writeJson(f, o); });
  set(join(plugin, "package-lock.json"), (f) => { const o = readJson(f); o.version = to; if (o.packages?.[""]) o.packages[""].version = to; writeJson(f, o); });
  set(join(repo, ".claude-plugin", "marketplace.json"), (f) => {
    const o = readJson(f);
    for (const p of Array.isArray(o.plugins) ? o.plugins : []) if (p && (p.name === manifest.name || p.source === "./plugin") && "version" in p) p.version = to;
    if (o.metadata && "version" in o.metadata) o.metadata.version = to;
    writeJson(f, o);
  });
  const cl = join(plugin, "CHANGELOG.md");
  const entry = `## ${to} — ${today}\n\n- ${branch ? `branch \`${branch}\`: ` : ""}da completare con le modifiche del rilascio.\n`;
  if (!dryRun) {
    const old = existsSync(cl) ? readFileSync(cl, "utf8") : "# Changelog\n";
    const i = old.indexOf("\n## ");
    writeFileSync(cl, i >= 0 ? `${old.slice(0, i + 1)}${entry}\n${old.slice(i + 1)}` : `${old.trimEnd()}\n\n${entry}`);
    const r = integrity ? spawnSync(process.execPath, [join(plugin, "scripts", "admin", "integrity.mjs"), "build"], { encoding: "utf8" }) : { status: 0 };
    if (r.status !== 0) throw new Error(`integrity build non riuscito: ${r.stderr || r.stdout}`);
  }
  files.push(cl);
  return { from, to, kind, files: files.map((f) => f.slice(repo.length + 1).replace(/\\/g, "/")), dry_run: dryRun };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("uso: node scripts/admin/bump-version.mjs [patch|minor|major] [--branch <nome>] [--dry-run] [--json]\n\nAlza la versione del plugin (plugin.json, package.json, package-lock.json, marketplace.json), aggiunge la voce in CHANGELOG.md e rigenera integrity.json. Default: minor.");
    process.exit(0);
  }
  const kind = ["patch", "minor", "major"].find((k) => args.includes(k)) ?? "minor";
  const bi = args.indexOf("--branch");
  try {
    // --check (l'unico argomento che guard-config-scope ammette per un generatore in sessione) = prova a secco: non scrive mai
    const r = bump({ kind, branch: bi >= 0 ? args[bi + 1] : null, dryRun: args.includes("--dry-run") || args.includes("--check") });
    console.log(args.includes("--json") ? JSON.stringify(r) : `versione del plugin: ${r.from} → ${r.to}${r.dry_run ? " (prova a secco)" : ""}\n${r.files.join("\n")}`);
  } catch (err) { console.error(String(err.message ?? err)); process.exit(1); }
}
