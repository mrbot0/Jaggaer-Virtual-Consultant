// Intento in linguaggio naturale → elementi estratti → esito DT-026 (K6.4, §29.5, §57.1, §61).
// Estrazione lessicale deterministica (italiano e inglese): nessun modello, nessuna ipotesi. Se un
// elemento critico manca o è ambiguo (nessun ambiente, due scope plausibili senza un primario, nessun
// cliente) l'esito è `chiedi`.
//
//   parseIntent(text, { customers, session, autonomy }) → { customer, env, scopes[], mode, task, actions: [ACT-*],
//     entities[], data{}, stop_at, risk_max, missing[], outcome, reason, dt }
import { readdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { ACT, envColumn } from "../../hooks/lib/act-classes.mjs";
import { LEVELS, autonomyLevel, minLevel, capFor } from "../../hooks/lib/autonomy.mjs";
import { requiredApprovals } from "../../hooks/lib/guards/config-scope.mjs";
import { evaluate, loadTable } from "./dt-eval.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { readTextFile, inputBase } from "../lib/text-file.mjs";

const RISK_RANK = { R0: 0, R1: 1, R2: 2, R3: 3 };
// Ops veloce (spec 2026-10-06 §3.3, §3.6): ACT-DELETE è negato solo in produzione; in sandbox e pre-produzione entra in un piano.
export const DELETE_REFUSAL = "In produzione non si cancella mai; in sandbox e pre-produzione sì, dentro un piano (posso anche annullare con la compensazione cancel)";

const norm = (s) => String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ");

// Scope (§29.5): parola chiave → cella. Le espressioni più lunghe prima.
const SCOPE_WORDS = [
  ["ADM", /\b(campo obbligatorio|configura\w*|workflow|ruol[oi]|utent[ei]|notific\w*|user|role|notification)\b/g],
  ["P2P", /\b(rda|richiest[ae] d'acquisto|richiest[ae] di acquisto|requisitions?|purchase orders?|ordin[ei]|order|ricezion\w*|receipt)\b/g],
  ["CAT", /\b(catalog[oh]?\w*|articol[oi]|listin[oi]|items?)\b/g],
  ["SRC", /\b(gar[ae]|eventi|evento|rdo|ast[ae]|sourcing|tender|auction)\b/g],
  ["VEN", /\b(fornitor[ei]|anagrafic\w*|qualific\w*|supplier\w*|vendor\w*)\b/g],
  ["CON", /\b(contratt[oi]|contracts?)\b/g],
  ["INV", /\b(fattur[ae]|invoices?)\b/g],
  ["QLT", /\b(non conformit\w+|audit|quality)\b/g],
  ["ANL", /\b(query|report|analytics|tabell[ae])\b/g],
];
const SCOPE_CODES = /\b(CAT|SRC|VEN|CON|P2P|INV|QLT|ANL|ADM)\b/g;

// Verbi → classi del catalogo (§29.4), con i pronomi enclitici italiani (mandala, lasciala…).
const VERBS = [
  ["ACT-DELETE", /\b(cancell[ai]\w*|elimin[ai]\w*|delete|remove|rimuov\w*)\b/g],
  ["ACT-READ", /\bchi deve approvar\w*|\bwho (must|has to) approve\b/g],
  ["ACT-SUBMIT", /\b(invia(la|lo|le|li)?|mand(a|ala|alo|arla)|porta(la|lo)? in approvazione|sottometti\w*|submit\w*|send (it )?for approval)\b/g],
  ["ACT-APPROVE", /\b(approva(la|lo|re)?|approve)\b/g],
  ["ACT-PUBLISH", /\b(pubblica(la|lo|re)?|publish)\b/g],
  ["ACT-CLOSE", /\b(annull(a|ala|alo|are)|chiudi(la|lo)?|cancel|close)\b/g],
  ["ACT-TRANSMIT", /\b(trasmetti(la|lo)?|transmit)\b/g],
  // revisione finale (I3): l'import massivo (template) è ACT-BULK, prima di "carica" (ACT-UPLOAD, un allegato)
  ["ACT-BULK", /\b(importa(re|li|le|lo|la)?|import|bulk( import| upload)?|caric(a|are|ali|ale) in massa|caricamento massivo|in massa|massiv[oaie])\b/g],
  ["ACT-UPLOAD", /\b(caric(a|ala|alo)|alleg(a|ala|alo)|upload|attach)\b/g],
  ["ACT-CFG-CHANGE", /\b(configur(a|are)|rendi obbligatori[oa]|make (it )?mandatory|attiv(a|are)|disattiv(a|are)|imposta|enable|disable|configure)\b/g],
  ["ACT-CFG-READ", /\b(confronta (la )?configurazione|baseline|compare (the )?configuration)\b/g],
  ["ACT-CREATE", /\b(crea(re|la|lo|li|le)?|create|nuov[ao] (rda|richiesta|ordine))\b/g],
  ["ACT-UPDATE", /\b(modific(a|ala|alo|are)|aggiorn(a|ala|alo|are)|update|modify|change)\b/g],
  ["ACT-QRY", /\b(quant[ie]|estrai|query|how many|extract)\b/g],
  ["ACT-OBS", /\b(dimmi|apri(la|lo)?|mostra(mi)?|verifica|leggi|guarda|show|open|tell me|check|why)\b|\bperch[eé](?![a-zà-ù])/g],
];
const TASKS = [
  ["nrt-author", /\bgener\w* (un |dei |uno )?test\b|\bgenerate (a )?test\b/],
  ["nrt-run", /\besegui\w* (la |il |i )?(regressione|collaudo|test)\b|\brun (the )?(regression|tests)\b/],
  ["anl-learn", /\bimpara\b|\blearn the tables\b/],
  ["kb-epistemic", /\bcosa sappiamo\b|\bwhat do we know\b/],
  ["kb-knowledge", /^(quali|quale|che cos|cos'è|what are|which)\b/],
];

function findAll(re, text) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) out.push({ index: m.index, text: m[0] });
  return out;
}

function detectEnv(t) {
  if (/\b(pre-?produzione|pre-?prod|preprod|pre prod|staging)\b/.test(t)) return "preprod";
  if (/\b(produzione|prod|production)\b/.test(t)) return "prod";
  if (/\b(sandbox|sbx|test environment)\b/.test(t)) return "sandbox";
  return null;
}

function detectCustomer(text, known) {
  const set = new Set((known ?? []).map((c) => String(c).toUpperCase()));
  for (const m of text.matchAll(/\b([A-Z0-9]{4})\b/g)) if (set.has(m[1])) return m[1];
  const m = /\b(?:su|di|per|on|for|at)\s+([A-Z][A-Z0-9]{3})\b/.exec(text);
  return m && !/^(SEL|RDA|PLAN)$/.test(m[1]) && (!set.size || set.has(m[1])) ? m[1] : null;
}

function parseAmount(num, k) {
  const n = Number(String(num).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * (k ? 1000 : 1) * 100) / 100 : null;
}
function extractData(text, t) {
  const data = {};
  const q = /\b(\d{1,4})\s+(?!€|eur|euro|k\b|giorni|days)([a-zà-ù]{3,}(?:\s+da\s+catalogo)?)/i.exec(text);
  if (q) { data.quantity = Number(q[1]); data.item = q[2].replace(/\s+da\s+catalogo$/i, "").toLowerCase(); }
  const cc = /\b(?:cdc|centro di costo|cost cent(?:er|re))\s*:?\s*([A-Z]{2}-\d{3,6})\b/i.exec(text) ?? /\b([A-Z]{2}-\d{4})\b/.exec(text);
  if (cc) data.cost_center = cc[1].toUpperCase();
  const am = /(?:€|eur)\s*(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:,\d+)?)\s*(k)?|(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:,\d+)?)\s*(k)?\s*(?:€|eur\b|euro\b)/i.exec(text);
  if (am) data.amount = parseAmount(am[1] ?? am[3], am[2] ?? am[4]);
  const days = /\bultimi\s+(\d+)\s+giorni\b|\blast\s+(\d+)\s+days\b/i.exec(text);
  if (days) data.period_days = Number(days[1] ?? days[2]);
  const doc = /\b(\d{10})\b/.exec(text);
  if (doc) data.document = doc[1];
  const ref = /\b(NRT-[A-Z0-9-]+)\b/.exec(text);
  if (ref) data.ref = ref[1];
  const rel = /\brelease\s+(R\d{2}\.\d+)\b/i.exec(text) ?? /\b(R\d{2}\.\d)\b/.exec(text);
  if (rel) data.release = rel[1];
  const role = /\bcome\s+([A-Z][A-Z_]{2,})\b|\bas\s+([A-Z][A-Z_]{2,})\b/.exec(text);
  if (role) data.role = role[1] ?? role[2];
  const date = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/.exec(text);
  if (date) data.date = date[1];
  if (/\bdi prova\b|\bdi test\b|\btest (order|requisition)\b/.test(t)) data.test_entity = true;
  return data;
}

const ENTITY = [["requisition", /\b(rda|richiest[ae] d'acquisto|requisition)\b/], ["purchase_order", /\b(ordin[ei]|order)\b/], ["catalog", /\bcatalog/],
  ["supplier", /\b(fornitor|supplier)/], ["contract", /\bcontratt/], ["invoice", /\bfattur/], ["sourcing_event", /\b(gar[ae]|evento|rdo|asta)\b/], ["user", /\butent[ei]\b/], ["notification", /\bnotific/]];

// `autonomy`: livello effettivo (basso|medio|alto) che il chiamante ha calcolato con autonomyLevel; assente ⇒ alto
// (il tetto dell'ambiente si applica qui: in produzione al massimo medio).
export function parseIntent(text, { customers = [], session = null, autonomy = null } = {}) {
  const raw = String(text ?? "").trim();
  const t = norm(raw);
  const missing = [];
  const customer = detectCustomer(raw, customers) ?? session?.customer ?? null;
  const envText = detectEnv(t);
  const env = envText ?? (session?.env?.type ? (session.env.type === "dev" ? "sandbox" : session.env.type) : null);

  // compito (task) e verbi → classi, in ordine di apparizione
  const task = TASKS.find(([, re]) => re.test(t))?.[0] ?? null;
  let actions = [];
  let masked = t;
  const hits = [];
  if (!["nrt-author", "kb-epistemic", "kb-knowledge"].includes(task)) {
    for (const [cls, re] of VERBS) {
      for (const h of findAll(re, masked)) { hits.push({ cls, index: h.index }); masked = masked.slice(0, h.index) + " ".repeat(h.text.length) + masked.slice(h.index + h.text.length); }
    }
  }
  hits.sort((a, b) => a.index - b.index);
  actions = [...new Set(hits.map((h) => h.cls))];
  if (task === "nrt-run") actions = [];
  if (task === "anl-learn") actions = ["ACT-OBS"];
  if (actions.includes("ACT-CFG-READ")) actions = actions.filter((a) => a !== "ACT-OBS");
  if (/\bperch[eé](?![a-zà-ù])|\bwhy\b/.test(t) && actions.includes("ACT-OBS") && !actions.includes("ACT-QRY")) actions.splice(actions.indexOf("ACT-OBS") + 1, 0, "ACT-QRY");
  if (actions.includes("ACT-CREATE") && /\bda catalogo\b|\bcerca\b|\bricerca\b|\bfrom (the )?catalog\b/.test(t) && !actions.includes("ACT-OBS")) actions.unshift("ACT-OBS");
  // l'import massivo carica il file compilato e crea i record: un solo ACT-BULK (come il piano di compose-plan)
  if (actions.includes("ACT-BULK")) actions = actions.filter((a) => a !== "ACT-UPLOAD" && a !== "ACT-CREATE");
  if (actions.includes("ACT-DELETE")) actions = ["ACT-DELETE"];

  // scope: primario + gli altri (handoff); ambiguità esplicita ("un contratto o un ordine") ⇒ chiedi
  const found = [];
  for (const [s, re] of SCOPE_WORDS) for (const h of findAll(re, t)) found.push({ s, index: h.index, len: h.text.length });
  for (const m of raw.matchAll(SCOPE_CODES)) found.push({ s: m[1], index: m.index, len: m[0].length, explicit: true });
  if (/\bscope\s+sourcing\b/.test(t)) found.push({ s: "SRC", index: t.indexOf("sourcing"), len: 8, explicit: true });
  found.sort((a, b) => a.index - b.index);
  const uniq = [...new Set(found.map((f) => f.s))];
  let primary = null;
  let ambiguous = false;
  const explicit = found.find((f) => f.explicit);
  if (explicit) primary = explicit.s;
  else if (actions.includes("ACT-CFG-CHANGE") || actions.includes("ACT-CFG-READ")) primary = "ADM";
  else if (actions.includes("ACT-QRY") && /\b(quant[ie]|how many|analytics|report)\b/.test(t) && !/\bperch[eé](?![a-zà-ù])/.test(t)) primary = uniq.includes("VEN") && !/\b(quant[ie]|how many)\b/.test(t) ? "VEN" : "ANL";
  else if (task === "anl-learn") primary = "ANL";
  else if (task === "nrt-author") primary = found.at(-1)?.s ?? null;
  else if (uniq.length) {
    const firstVerb = hits.find((h) => h.cls !== "ACT-OBS")?.index ?? hits[0]?.index ?? 0;
    primary = (found.find((f) => f.index >= firstVerb) ?? found[0]).s;
  }
  for (let i = 0; i + 1 < found.length; i++) {
    const x = found[i]; const y = found[i + 1];
    const btw = t.slice(x.index + x.len, y.index).replace(/l'/g, " ").replace(/\b(un|una|uno|il|la|lo|i|gli|le|a|an|the)\b/g, " ").trim();
    if (x.s !== y.s && /^(o|oppure|or)$/.test(btw)) ambiguous = true;
  }
  if (!primary && !uniq.length && actions.some((a) => a !== "ACT-DELETE") && !task) ambiguous = true;
  const scopes = primary ? [primary, ...uniq.filter((s) => s !== primary)] : uniq;
  if (ambiguous) missing.push("scope");

  // modalità (§61)
  const mode = actions.includes("ACT-DELETE") ? null
    : task === "kb-knowledge" || task === "kb-epistemic" ? "conoscenza"
    : task === "nrt-author" || task === "nrt-run" ? "nrt"
    : task === "anl-learn" ? "apprendimento"
    : actions.includes("ACT-CFG-CHANGE") ? "configurazione"
    : actions.includes("ACT-CFG-READ") ? "audit"
    : /\bperch[eé](?![a-zà-ù])|\bwhy\b/.test(t) && actions.length ? "diagnosi"
    : actions.includes("ACT-QRY") && primary === "ANL" ? "analytics"
    : "operativa";

  // rischio
  const riskOf = (cls) => (cls === "ACT-CFG-CHANGE" ? "R2" : String(ACT[cls]?.risk ?? "R3").split("/").pop());
  const risks = actions.map(riskOf);   // ACT-DELETE conta R3: in sandbox e pre-produzione entra in un piano da approvare
  if (task === "nrt-run") risks.push("R2");   // la corsia guidata esegue piani con passi R2 (§27.4): piano mostrato
  const risk_max = risks.length ? risks.reduce((a, b) => (RISK_RANK[b] > RISK_RANK[a] ? b : a)) : "R0";

  // fin dove (§57.1): in bozza ⇒ dopo CREATE; in approvazione ⇒ PENDING_APPROVAL; default il più conservativo
  const stop_at = actions.includes("ACT-SUBMIT") ? "PENDING_APPROVAL" : /\bin bozza\b|\bas (a )?draft\b/.test(t) || actions.includes("ACT-CREATE") ? (actions.some((a) => ["ACT-CREATE", "ACT-UPDATE"].includes(a)) ? "bozza" : null) : null;

  // WP07 giro 1 (spec I5, §57.1): senza "cosa fare" riconosciuto si chiede, non si avvia
  if (!actions.length && !task) missing.push("action");
  const needsBrowser = actions.length > 0 || task === "nrt-run";
  if (needsBrowser && !env) missing.push("env");
  if ((needsBrowser || task) && !customer) missing.push("customer");
  const data = extractData(raw, t);
  if (actions.includes("ACT-CREATE") && scopes[0] === "P2P" && data.quantity == null) missing.push("data:quantity");
  const entities = ENTITY.filter(([, re]) => re.test(t)).map(([type]) => ({ type, ...(type === "requisition" && data.ref ? { ref: data.ref } : {}), ...(type === "purchase_order" && data.document ? { ref: data.document } : {}) }));

  // esito (DT-026), spec 2026-10-06 §3.5, §3.6: dipende dal livello di autonomia e dall'ambiente
  const col = envColumn(env ?? "prod");
  const notAllowed = actions.filter((a) => ACT[a]?.[col] === "never" || !ACT[a]);
  const isDelete = actions.includes("ACT-DELETE");
  const critical = missing.includes("env") || missing.includes("customer") || missing.includes("scope") || missing.includes("action");
  const lvl = minLevel(LEVELS.includes(autonomy) ? autonomy : "alto", capFor(env));
  // Il piano chiede almeno un'approvazione col livello attuale, con la stessa regola di step-check (planNeedsApproval):
  // prod sempre; pre-produzione se il livello non è alto; altrimenti un passo della classe che chiede A1/A2/A3 secondo
  // requiredApprovals (config e cancellazioni sempre; massivi se non alto; R2 in pre-produzione) — revisione finale (I3):
  // niente formula duplicata a mano. La corsia guidata dei collaudi (nrt-run) mostra sempre il piano.
  const stepNeeds = (a) => {
    if (!ACT[a]) return false;
    const r = requiredApprovals(a, { action_class: a }, { type: env ?? "prod", policy: {} }, a === "ACT-CFG-CHANGE" ? "rosso" : null, lvl);
    return r.a1 || r.a2 || r.a3;
  };
  const needsApproval = env === "prod" || task === "nrt-run" || (env === "preprod" && lvl !== "alto") || actions.some(stepNeeds);
  const dt = evaluate(loadTable("DT-026"), {
    critical_missing: critical,
    action_class_allowed: notAllowed.length === 0 || !env,
    config_change: actions.includes("ACT-CFG-CHANGE"),
    max_risk: risk_max,
    environment: env ?? "prod",
    needs_approval: needsApproval,
  });
  const outcome = dt.outcome;
  let reason;
  if (isDelete && env === "prod") reason = DELETE_REFUSAL;
  else if (outcome === "chiedi") {
    const ask = [];
    if (missing.includes("env")) ask.push("in quale ambiente (sandbox, pre-produzione, produzione)?");
    if (missing.includes("customer")) ask.push("per quale cliente?");
    if (missing.includes("action")) ask.push("che cosa devo fare (crea, modifica, invia, approva, annulla, mostra, …)?");
    if (missing.includes("scope")) ask.push(`su quale oggetto (${uniq.join(" o ")})?`);
    reason = `Serve un chiarimento prima di qualunque passo (§29.5): ${ask.join(" ")}`;
  } else if (outcome === "rifiuta") reason = `${notAllowed.join(", ")} non è ammessa in ${env} (§29.4)`;
  else if (outcome === "mostra-piano") reason = `Piano da approvare in ${env} (autonomia ${lvl})`;
  else reason = `Parte subito con autonomia ${lvl} in ${env ?? "nessun ambiente"}${risk_max === "R0" ? " (R0: osservazione e lettura)" : ""}`;

  return { customer, env, scopes, mode, task, actions, entities, data, stop_at, risk_max, missing, outcome, reason,
    dt: { table: dt.table, version: dt.table_version, outcome: dt.outcome, score: dt.score, rule: dt.rule } };
}

const HELP = `uso: node scripts/decide/intent.mjs (--text "<intento>" | --text-file <file>) [--customers ACME,BETA] [--session <id>] [--workspace <dir>] [--json]

Estrae cliente, ambiente, scope, classi d'azione, dati e decide con DT-026: avvia · mostra-piano ·
rifiuta · chiedi. Il livello di autonomia (frase, file del cliente, alto) decide se il piano parte da solo. I clienti noti: --customers, altrimenti le cartelle customers/ del
workspace; cliente e ambiente attivi in sessione valgono se l'intento non li nomina. --text-file: il testo dell'utente da
un file (relativo al workspace, ≤ 64 KB) — la forma dei comandi del plugin (i guard negano virgole, accenti, ? in linea).
Exit: 0 esito prodotto · 1 argomenti · 2 errore di sistema.`;

export async function run(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.text && !opts["text-file"]) return fail(asJson, 1, "richiesto --text o --text-file");
  if (opts.text && opts["text-file"]) return fail(asJson, 1, "--text e --text-file sono alternativi");
  try {
    const ws = resolvePath(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
    let text = opts.text;
    if (opts["text-file"]) { const t = readTextFile(inputBase(env), opts["text-file"]); if (t.error) return fail(asJson, 1, t.error); text = t.text; }
    let customers = opts.customers ? String(opts.customers).split(",").map((s) => s.trim()).filter(Boolean) : null;
    if (!customers) { try { customers = readdirSync(join(ws, "customers")).filter((d) => /^[A-Z0-9]{4}$/.test(d)); } catch { customers = []; } }
    let session = null;
    try {
      const { resolveSessionId, loadSession } = await import("../admin/session.mjs");
      const sid = resolveSessionId({ workspace: ws, arg: opts.session, env });
      if (sid) session = loadSession(ws, sid).session;
    } catch { session = null; }
    let r = parseIntent(text, { customers, session });
    // Livello di autonomia dalla sessione (frase nel registro > file del cliente > alto), col tetto dell'ambiente.
    if (session && r.customer && r.env) {
      try {
        const { resolveSessionId } = await import("../admin/session.mjs");
        const { readApprovals, approvalsFile } = await import("../admin/approvals.mjs");
        const sid = resolveSessionId({ workspace: ws, arg: opts.session, env });
        // revisione finale (I3): i RECORD del registro (readApprovals restituisce { ok, records }); registro corrotto ⇒ nessuna frase
        const reg = sid ? readApprovals(approvalsFile(ws, r.customer, sid)) : null;
        const a = autonomyLevel({ ws, customer: r.customer, records: reg?.ok ? reg.records : [], envType: r.env });
        r = parseIntent(text, { customers, session, autonomy: a.level });
      } catch { /* senza registro vale alto (poi il tetto dell'ambiente) */ }
    }
    console.log(asJson ? JSON.stringify(r) : `${r.outcome} — ${r.reason}\n${r.customer ?? "?"} · ${r.env ?? "?"} · ${r.scopes.join("+") || "?"} · ${r.actions.join(" → ") || r.task || "—"}`);
    return 0;
  } catch (err) { return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`); }
}

if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
