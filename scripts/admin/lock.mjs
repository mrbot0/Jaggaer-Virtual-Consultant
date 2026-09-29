// admin lock (§56.8, §58) — WP09d. I lock della conoscenza (knowledge.lock di product/ e di ogni cliente, scritti da
// scripts/kb/lock.mjs withLock durante digestione, promozione e purge): proprietario (pid), scadenza, processo vivo.
// --clear-expired toglie SOLO i lock scaduti il cui processo non è più vivo (un lock scaduto di un processo vivo resta:
// il processo sta ancora lavorando). Un lock è stato operativo, non dato: toglierlo non cancella conoscenza.
import { readFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
}

export function listLocks(ws, { now = Date.now() } = {}) {
  const dirs = [join(ws, "product")];
  try { for (const e of readdirSync(join(ws, "customers"), { withFileTypes: true })) if (e.isDirectory()) dirs.push(join(ws, "customers", e.name)); } catch { /* nessun cliente */ }
  const out = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith(".lock"))) {
      const file = join(d, f);
      let info = null;
      try { info = JSON.parse(readFileSync(file, "utf8")); } catch { info = null; }
      const expires = Number(info?.expires);
      out.push({ file: relative(ws, file).split(sep).join("/"), name: f.replace(/\.lock$/, ""), pid: info?.pid ?? null, expires: Number.isFinite(expires) ? new Date(expires).toISOString() : null,
        expired: !Number.isFinite(expires) || expires <= now, pid_alive: pidAlive(info?.pid), readable: !!info });
    }
  }
  return out;
}

export function clearExpired(ws, { now = Date.now() } = {}) {
  const cleared = [];
  const kept = [];
  for (const l of listLocks(ws, { now })) {
    if (l.expired && !l.pid_alive) { unlinkSync(join(ws, ...l.file.split("/"))); cleared.push(l); } else kept.push({ ...l, why: l.expired ? "scaduto ma il processo è vivo" : "non scaduto" });
  }
  return { cleared, kept };
}

export const HELP = `uso: node scripts/admin/lock.mjs [show | --clear-expired] [--workspace <dir>] [--json]

Lock della conoscenza (product/ e clienti): proprietario, scadenza, processo vivo. --clear-expired toglie i soli lock
scaduti di processi non più vivi.

Exit code: 0 ok · 1 argomenti non validi · 2 errore di sistema.`;

export function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv, { flags: ["clear-expired"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (positional.length && positional[0] !== "show") return fail(asJson, 1, `azione sconosciuta: ${positional[0]}`);
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    const r = opts["clear-expired"] ? clearExpired(ws) : { locks: listLocks(ws) };
    console.log(JSON.stringify({ ok: true, ...r }));
    return 0;
  } catch (err) { return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`); }
}

if (isMain(import.meta.url)) process.exitCode = run(process.argv.slice(2));
