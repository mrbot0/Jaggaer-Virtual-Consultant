// admin customer purge <ID> (§54.4, §54.5, §56.8) — WP09d. L'UNICA cancellazione del plugin (diritto alla cancellazione,
// fine contratto): rimuove customers/<ID>/ (e con essa il suo DB), sostituisce promoted_from in product/ con un token
// irreversibile, produce un certificato di purge (percorsi rimossi con sha256 e dimensione, orario, approvazioni).
//
// Forma esatta (l'unica che guard-destructive ammette, policy/deny-rules.yaml DR-OK-001, tokenizzatore hooks/lib/exact-argv):
//   node <plugin>/scripts/admin/purge.mjs <ID> [--execute] --approval-1 <token> --approval-2 <token> [--session <id>] [--json]
// Senza --execute è una prova a secco (inventario, nessuna scrittura). Con --execute servono DUE approvazioni con frase
// `APPROVO PURGE <ID> DA <Nome Cognome>` da due nomi dichiarati diversi, registrate SOLO da approval-capture nel registro
// della sessione (catena di hash), non consumate, entro la finestra; lo script le verifica e le consuma. Altrimenti exit 3.
// Il workspace viene dall'ambiente (JVC_WORKSPACE > CLAUDE_PROJECT_DIR > cwd): nessun argomento di percorso.
import { readFileSync, writeFileSync, readdirSync, lstatSync, existsSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import YAML from "yaml";
import { approvalsFile, readApprovals, findGrant, consumeGrants, normName } from "./approvals.mjs";
import { readPointer, writePointer, CUSTOMER_RE } from "../../hooks/lib/workspace.mjs";
import { appendAudit } from "../../hooks/lib/audit.mjs";
import { withLock } from "../kb/lock.mjs";
import { canonical } from "../digest/align.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";

export class PurgeRefusal extends Error { constructor(m) { super(m); this.name = "PurgeRefusal"; } }
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const rel = (ws, p) => relative(ws, p).split(sep).join("/");

// Inventario dei file (senza seguire link): percorso, sha256, byte. I link sono voci a sé (si rimuove il link).
export function inventory(ws, dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out.push({ path: rel(ws, p), link: true, sha256: null, bytes: 0 });
      else if (st.isDirectory()) walk(p);
      else out.push({ path: rel(ws, p), sha256: sha(readFileSync(p)), bytes: st.size });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// Item di product/ promossi da questo cliente (promoted_from C.<ID>.… / L.<ID>.…).
export function promotedFrom(ws, id) {
  const hits = [];
  const re = new RegExp(`^[CL]\\.${id}\\.`);
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(e.name)) {
        const text = readFileSync(p, "utf8");
        if (!text.includes(`.${id}.`)) continue;
        let o;
        try { o = YAML.parse(text); } catch { continue; }
        if (typeof o?.promoted_from === "string" && re.test(o.promoted_from)) hits.push({ file: p, item: o.id ?? null, promoted_from: o.promoted_from });
      }
    }
  };
  walk(join(ws, "product", "kb"));
  walk(join(ws, "product", "analysis"));
  return hits;
}

export function verifyApprovals(ws, id, { sid, a1, a2, now = Date.now() }) {
  if (!a1 || !a2) throw new PurgeRefusal("servono due approvazioni: --approval-1 <token> --approval-2 <token> (frasi `APPROVO PURGE " + id + " DA <Nome Cognome>` di due persone)");
  if (!sid) throw new PurgeRefusal("nessuna sessione: le approvazioni vivono nel registro della sessione (--session o sessione corrente)");
  const ptr = readPointer(ws, sid);
  if (!ptr?.customer) throw new PurgeRefusal(`la sessione ${sid} non ha un cliente attivo: nessun registro delle approvazioni`);
  // giro 1 (m9): la purge si approva e si esegue nella sessione del cliente da cancellare (il registro, le frasi e l'audit
  // sono di quel cliente); una sessione di un altro cliente non purga
  if (ptr.customer !== id) throw new PurgeRefusal(`il cliente della sessione (${ptr.customer}) non è ${id}: la purge si esegue in una sessione di ${id} (/use customer ${id})`);
  const file = approvalsFile(ws, ptr.customer, sid);
  const reg = readApprovals(file);
  if (!reg.ok) throw new PurgeRefusal(`registro delle approvazioni non valido: ${reg.reason}`);
  const g1 = findGrant(reg.records, { kind: "purge", target: id, token: a1, now });
  if (!g1.ok) throw new PurgeRefusal(`approvazione 1: ${g1.reason}`);
  const g2 = findGrant(reg.records, { kind: "purge", target: id, token: a2, now });
  if (!g2.ok) throw new PurgeRefusal(`approvazione 2: ${g2.reason}`);
  if (g1.record.hash === g2.record.hash) throw new PurgeRefusal("le due approvazioni sono lo stesso record");
  const n1 = normName(g1.record.approver_declared);
  const n2 = normName(g2.record.approver_declared);
  if (!n1 || !n2) throw new PurgeRefusal("ogni approvazione della purge dichiara chi approva (DA <Nome Cognome>)");
  if (n1 === n2) throw new PurgeRefusal(`le due approvazioni vengono dalla stessa persona (${g1.record.approver_declared}): servono due nomi diversi`);
  return { file, grants: [g1.record, g2.record] };
}

export async function purge({ ws, id, execute = false, a1 = null, a2 = null, sid = null, now = new Date() }) {
  if (!CUSTOMER_RE.test(String(id ?? ""))) throw new Error(`codice cliente non valido: ${id}`);
  const dir = join(ws, "customers", id);
  if (!existsSync(dir)) throw new Error(`cliente inesistente: customers/${id}`);
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new PurgeRefusal(`customers/${id} non è una cartella reale (link o file): purge rifiutata`);
  const realCustomers = realpathSync.native(join(ws, "customers"));
  if (!realpathSync.native(dir).startsWith(realCustomers + sep)) throw new PurgeRefusal(`customers/${id} risolve fuori da customers/`);
  const files = inventory(ws, dir);
  const promoted = promotedFrom(ws, id);
  const summary = { customer: id, files: files.length, bytes: files.reduce((a, f) => a + f.bytes, 0), product_items: promoted.map((p) => p.item) };
  if (!execute) {
    let approvals;
    try { verifyApprovals(ws, id, { sid, a1, a2, now: now.getTime() }); approvals = { ok: true }; } catch (err) { approvals = { ok: false, reason: err.message }; }
    return { dry_run: true, ...summary, approvals };
  }
  const { file, grants } = verifyApprovals(ws, id, { sid, a1, a2, now: now.getTime() });
  mkdirSync(join(ws, "product"), { recursive: true });
  // lock su product/ e sul cliente: nessuna digestione o promozione in corso durante la purge
  return withLock(join(ws, "product"), "knowledge", 10 * 60000, () => withLock(dir, "knowledge", 10 * 60000, () => {
    // 1. consumo delle approvazioni (monouso) PRIMA di cancellare: il registro può stare dentro il cliente
    consumeGrants(file, grants, { date: now });
    // inventario definitivo (dopo il consumo, che può toccare un registro dentro il cliente)
    const removed = inventory(ws, dir);
    summary.files = removed.length;
    summary.bytes = removed.reduce((a, f) => a + f.bytes, 0);
    // 2. certificato (prima "in-corso", poi completato)
    const cdir = join(ws, ".jvc", "purge-certificates");
    mkdirSync(cdir, { recursive: true });
    const cfile = join(cdir, `${id}-${now.toISOString().replace(/[:.]/g, "-")}.json`);
    const cert = { kind: "customer-purge", customer: id, status: "in-corso", started_at: now.toISOString(), executed_at: null, session: sid,
      approvals: grants.map((g) => ({ hash: g.hash, approver_declared: g.approver_declared, ts: g.ts })), removed,
      removed_count: removed.length, bytes_total: summary.bytes, product_rewritten: [], pointers_reset: [] };
    writeFileSync(cfile, JSON.stringify(cert, null, 2) + "\n");
    // 3. product/: promoted_from → token irreversibile (casuale: nessun sale, nessuna tabella di corrispondenza)
    for (const p of promoted) {
      const before = readFileSync(p.file, "utf8");
      const o = YAML.parse(before);
      const token = `PURGED-${sha(randomBytes(32)).slice(0, 12)}`;
      o.promoted_from = token;
      const after = YAML.stringify(o);
      writeFileSync(p.file, after);
      cert.product_rewritten.push({ path: rel(ws, p.file), item: p.item, promoted_from: token, sha256_before: sha(before), sha256_after: sha(after) });
    }
    // 4. la cancellazione: customers/<ID>/ (file, DB, sessioni, audit del cliente)
    rmSync(dir, { recursive: true, force: false, maxRetries: 3 });
    if (existsSync(dir)) throw new Error(`customers/${id} non rimosso completamente`);
    // 5. puntatori di sessione che nominavano il cliente → nessun cliente
    const sdir = join(ws, ".jvc", "sessions");
    if (existsSync(sdir)) for (const f of readdirSync(sdir).filter((x) => x.endsWith(".json"))) {
      const s = f.slice(0, -5);
      let ptr = null;
      try { ptr = readPointer(ws, s); } catch { ptr = null; }
      if (ptr?.customer === id) { writePointer(ws, s, null); cert.pointers_reset.push(s); }
    }
    cert.status = "completata";
    cert.executed_at = new Date().toISOString();
    cert.certificate_sha256 = sha(canonical({ ...cert, certificate_sha256: undefined }));
    writeFileSync(cfile, JSON.stringify(cert, null, 2) + "\n");
    try {
      appendAudit(ws, { session: sid, customer: null, kind: "decision", actor: "script:admin-purge",
        payload: { purge: id, removed: removed.length, bytes: summary.bytes, product_rewritten: cert.product_rewritten.length, certificate: rel(ws, cfile), certificate_sha256: cert.certificate_sha256 } });
    } catch { /* il certificato resta la prova */ }
    // 6. l'indice di product/ si riallinea agli hash nuovi
    let reindexed = null;
    if (promoted.length && existsSync(join(ws, "product", "kb"))) {
      return import("../kb/reindex.mjs").then(({ reindex }) => { reindexed = reindex(join(ws, "product"), join(ws, "product", "knowledge.db")); return { dry_run: false, ...summary, certificate: cfile, certificate_sha256: cert.certificate_sha256, reindexed }; });
    }
    return { dry_run: false, ...summary, certificate: cfile, certificate_sha256: cert.certificate_sha256, reindexed };
  }));
}

export const HELP = `uso: node <plugin>/scripts/admin/purge.mjs <ID> [--execute] --approval-1 <token> --approval-2 <token> [--session <id>] [--json]

admin customer purge (§54.4): l'UNICA cancellazione del plugin. Senza --execute: inventario (file, byte, item promossi
in product/) e verifica delle approvazioni, nessuna scrittura. Con --execute: due approvazioni con frase
\`APPROVO PURGE <ID> DA <Nome Cognome>\` da due persone diverse (registrate da approval-capture; token = hash del
record o un suo prefisso di ≥ 12 cifre), consumate; certificato in <workspace>/.jvc/purge-certificates/; rimozione di
customers/<ID>/; promoted_from in product/ sostituito da un token; puntatori di sessione del cliente azzerati.

Exit code: 0 ok · 1 argomenti non validi o cliente inesistente · 2 errore di sistema · 3 approvazioni mancanti o non valide.`;

export async function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv, { flags: ["execute"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const id = positional[0];
  if (positional.length !== 1 || !CUSTOMER_RE.test(String(id))) return fail(asJson, 1, "uso: purge.mjs <ID cliente di 4 caratteri> [--execute] --approval-1 <token> --approval-2 <token>");
  const ws = resolve(env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    const { resolveSessionId } = await import("./session.mjs");
    const sid = resolveSessionId({ workspace: ws, arg: opts.session, env });
    const r = await purge({ ws, id, execute: !!opts.execute, a1: opts["approval-1"] ?? null, a2: opts["approval-2"] ?? null, sid });
    console.log(JSON.stringify({ ok: true, ...r }));
    return 0;
  } catch (err) {
    if (err instanceof PurgeRefusal) return fail(asJson, 3, err.message);
    if (/non valido|inesistente/.test(String(err?.message))) return fail(asJson, 1, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 2; });
