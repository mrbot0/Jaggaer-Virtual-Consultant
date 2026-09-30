// xray retry-queued (ADR-22, §47 E2): ripete le voci pendenti della coda offline del cliente (customers/<C>/queue/)
// con l'AlmAdapter della factory. Le voci inviate passano a sent (con la chiave ottenuta), quelle con un errore non di
// rete a failed (da guardare: non si ripetono da sole); nessuna voce si cancella. --status: solo lo stato della coda.
//
// CLI: node scripts/xray/retry-queued.mjs [--status] [--customer C] [--workspace <dir>] [--json]
// Exit: 0 ok (anche se qualcosa resta in coda: la rete è ancora giù) · 1 argomenti o configurazione · 2 errore di
//       sistema · 3 almeno una voce fallita.
import { parseArgs } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { xrayContext, recordCreated, audit, failWith } from "./common.mjs";

const HELP = `uso: node scripts/xray/retry-queued.mjs [--status] [--customer C] [--workspace <dir>] [--json] [--help]

Ripete le pubblicazioni e i Defect rimasti in coda offline (Jira/Xray irraggiungibili). --status: solo lo stato.

Exit code: 0 ok (anche con voci ancora in coda) · 1 argomenti o configurazione · 2 errore di sistema · 3 voci fallite.`;

export async function run(argv, env = process.env) {
  const { opts } = parseArgs(argv, { flags: ["status"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  try {
    const c = await xrayContext(opts, env);
    if (opts.status) { const s = c.queue.status(); console.log(asJson ? JSON.stringify({ ok: true, ...s }) : `coda ${c.customer}: ${s.pending} pendenti · ${s.failed} fallite · ${s.sent} inviate`); return 0; }
    const r = await c.queue.retryQueued(c.adapter);
    // WP09c giro 1 (I1): in session.alm.created solo ciò che il plugin ha CREATO ora, mai chiavi lette dalla coda
    for (const s of r.sent.filter((x) => x.created)) await recordCreated(c.ws, env, s.key, s.op === "defect" ? "defect" : "execution", "xray-retry-queued");
    if (r.sent.length || r.failed.length) await audit(c.ws, env, c.customer, { action: "xray-retry-queued", sent: r.sent, failed: r.failed.map((f) => f.id), still_queued: r.still_queued.length }, "xray-retry-queued");
    console.log(asJson ? JSON.stringify({ ok: r.failed.length === 0, ...r }) : `inviate ${r.sent.length} · ancora in coda ${r.still_queued.length} · fallite ${r.failed.length}${r.failed.length ? ` (${r.failed.map((f) => `${f.id}: ${f.error}`).join("; ")})` : ""}`);
    return r.failed.length ? 3 : 0;
  } catch (err) { return failWith(asJson, err); }
}

// exitCode, non process.exit: su Windows (Node 24) process.exit dopo più fetch termina il processo con 0xC0000409
if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 2; });
