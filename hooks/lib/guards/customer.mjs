// guard-customer (FAIL-CLOSED): solo il cliente attivo + product/ (§1.3,
// §54.3, T3). Percorsi sotto customers/<X>/ con X ≠ cliente attivo ⇒ deny,
// anche fuori dal workspace (copie, altri repository). Bash/PowerShell: ricerca
// di customers/<X>, --customer <X>, --db …customers/<X>/… anche offuscati
// (virgolette, escape, backtick, URL-encoding, sosia unicode, percorsi
// relativi alla cwd). Eccezione: weekly-digest legge
// customers/*/{lessons,decisions,outcomes,observations,kb}. Nessun cliente
// attivo ⇒ customers/** negato, salvo `node …session.mjs use customer …`.
import { posix } from "node:path";
import { intersects, subset, segs, bases, skeleton, PathPolicyError } from "../paths.mjs";
import { guarded, denyAudited, targetsOf, shellPaths, pluginSessionCommand, PATH_TOOLS, SHELL_TOOLS, READ_TOOLS } from "./common.mjs";
import { WEEKLY_READ } from "./scope.mjs";

const G = "guard-customer";
const NO_CUSTOMER = "nessun cliente attivo: customers/** è negato finché non esegui /jaggaer-virtual-consultant:use customer <ID>";

function checkRel(ctx, p) {
  if (!intersects(p, "customers/**")) return null;
  const s = segs(p);
  if (!ctx.customerLc) return NO_CUSTOMER;
  if (s[0] === "customers" && s.length >= 2 && s[1] === ctx.customerLc) return null;
  if (ctx.agentType === "weekly-digest" && READ_TOOLS.has(ctx.tool) && WEEKLY_READ.some((q) => subset(p, q))) return null;
  const other = s[0] === "customers" && s[1] ? s[1].toUpperCase() : "*";
  return `accesso a un altro cliente (${other}) negato: il cliente attivo è ${ctx.customer}; la conoscenza fra clienti passa solo dal livello prodotto (§1.3). Percorso: ${p}`;
}

const CUST_IN_PATH = /(?:^|\/)customers(?:\/+([^/]*)|$)/g;
function checkOutsideAbs(ctx, abs) {
  for (const m of abs.matchAll(CUST_IN_PATH)) {
    const x = (m[1] ?? "").toLowerCase();
    if (!ctx.customerLc) return NO_CUSTOMER;
    if (x !== ctx.customerLc) return `percorso customers/${x || "*"} fuori dal workspace negato (cliente attivo ${ctx.customer}): ${abs}`;
  }
  return null;
}

function checkFileTool(ctx) {
  const T = targetsOf(ctx);
  for (const p of T.ws) { const r = checkRel(ctx, p); if (r) return r; }
  const wsBases = bases(ctx.ws);
  for (const a of T.abs) {
    if (wsBases.some((b) => a === b || a.startsWith(`${b}/`))) continue;
    const r = checkOutsideAbs(ctx, a); if (r) return r;
  }
  return null;
}

// ---- shell ----

function shellVariants(cmd) {
  const out = new Set([cmd]);
  const unq = cmd.replace(/["'`]/g, "");
  out.add(unq);
  out.add(unq.replace(/\\(?=[^\s\\/])/g, ""));
  for (const v of [...out]) {
    if (/%[0-9a-f]{2}/i.test(v)) { try { out.add(decodeURIComponent(v)); } catch { /* ignora */ } }
    out.add(skeleton(v));
  }
  return [...out];
}

function checkShell(ctx) {
  const cmd = ctx.ti.command;
  if (typeof cmd !== "string" || !cmd.trim()) return null;
  if (cmd.includes("\0")) throw new PathPolicyError("comando con byte NUL");
  // Senza cliente: solo `node <plugin>/scripts/admin/session.mjs use customer …` (fix round 1 #13).
  if (!ctx.customerLc) { const sc = pluginSessionCommand(cmd, { cwd: ctx.cwd, plugin: ctx.plugin }); if (sc?.action === "use" && sc.what === "customer") return null; }
  const refs = new Set();
  for (const v of shellVariants(cmd)) {
    for (const m of v.matchAll(/--customer(?:=|\s+)([^\s;|&<>()]+)/gi)) refs.add(m[1].toLowerCase());
    for (const tok of v.split(/[\s;|&<>()=,]+/)) {
      if (!tok) continue;
      const t = tok.replace(/\\/g, "/");
      if (/customers/i.test(t)) for (const m of posix.normalize(t).matchAll(CUST_IN_PATH)) refs.add((m[1] ?? "").toLowerCase());
    }
  }
  for (const x of refs) {
    if (!ctx.customerLc) return NO_CUSTOMER;
    if (x !== ctx.customerLc) return `il comando fa riferimento a un altro cliente (${x ? x.toUpperCase() : "customers/*"}): il cliente attivo è ${ctx.customer}`;
  }
  return checkRelativeWithCwd(ctx, cmd);
}

function checkRelativeWithCwd(ctx, cmd) {
  const c2 = { ...ctx, tool: "Bash" };
  for (const { rels, cd } of shellPaths(ctx, cmd)) {
    for (const p of rels) { const r = checkRel(c2, p); if (r) return cd ? `cambio di cartella verso un percorso non consentito: ${r}` : r; }
  }
  return null;
}

export const decide = guarded(G, (ctx) => {
  let reason = null;
  if (SHELL_TOOLS.has(ctx.tool)) reason = checkShell(ctx);
  else reason = checkFileTool(ctx);
  return reason ? denyAudited(ctx, G, reason) : null;
}, { tools: new Set([...PATH_TOOLS, ...SHELL_TOOLS]) });
