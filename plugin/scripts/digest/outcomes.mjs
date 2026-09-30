// Registro degli esiti (§12.1, §29.6): ogni DEC con effetti dichiara un esito atteso; un passo
// successivo lo verifica. Chi verifica: l'esecuzione, un umano, una contraddizione, il tempo
// (nessuna verifica entro 2 release → non-verificabile, esclusa dai tassi).
//
// Scrive `<root>/outcomes/<DEC>.out.yaml` (§12.1) e la riga `outcomes` del DB nella stessa
// transazione. Mai dall'agente che ha deciso (§29.6): `record` rifiuta se `verified_by` coincide con
// l'agente registrato nella DEC. Idempotente per codice: lo stesso esito non riscrive nulla; un
// esito diverso da quello già registrato è rifiutato (l'esito è storia, non si corregge in silenzio).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { openDb } from "../kb/db.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";

export const RESULTS = ["confermata", "smentita", "parziale", "non-verificabile"];
export const EXPIRE_AFTER_RELEASES = 2;
const DEC_RE = /^L\.[A-Z0-9]{4}\.[A-Z0-9]{3}\.DEC\.\d{4}(\.v\d+)?$/;

export class OutcomeInputError extends Error { constructor(m) { super(m); this.name = "OutcomeInputError"; } }
export class OutcomePolicyError extends Error { constructor(m) { super(m); this.name = "OutcomePolicyError"; } }

// "jaggaer-virtual-consultant:adm-expert" e "adm-expert" sono lo stesso agente.
export const agentName = (s) => (typeof s === "string" ? s.slice(s.lastIndexOf(":") + 1).trim().toLowerCase() : "");

export function declareExpected(db, { dec, expect, lesson = null, session = null, release = null, at = new Date().toISOString() }) {
  if (!DEC_RE.test(dec ?? "")) throw new OutcomeInputError(`codice DEC non valido: ${dec}`);
  if (typeof expect !== "string" || !expect.trim()) throw new OutcomeInputError(`esito atteso vuoto per ${dec}`);
  db.prepare(`insert into expected_outcomes(decision_code,expect,lesson_code,session,release_ref,declared_at) values (?,?,?,?,?,?)
    on conflict(decision_code) do update set expect=excluded.expect, lesson_code=coalesce(excluded.lesson_code, lesson_code),
      session=coalesce(excluded.session, session), release_ref=coalesce(excluded.release_ref, release_ref)`)
    .run(dec, expect.trim(), lesson, session, release, at);
}

export function record(db, root, { dec, result, verified_by, evidence = null, note = null, at = new Date().toISOString() } = {}) {
  if (!RESULTS.includes(result)) throw new OutcomeInputError(`esito '${result}' fuori vocabolario (${RESULTS.join(" · ")})`);
  if (!DEC_RE.test(dec ?? "")) throw new OutcomeInputError(`codice DEC non valido: ${dec}`);
  if (typeof verified_by !== "string" || !verified_by.trim()) throw new OutcomeInputError("verified_by mancante");
  if (!root) throw new OutcomeInputError("root del cliente mancante (dove scrivere outcomes/)");
  const decision = db.prepare("select code, agent from decisions where code=?").get(dec);
  if (!decision) throw new OutcomeInputError(`DEC inesistente: ${dec}`);
  if (decision.agent && agentName(decision.agent) === agentName(verified_by)) {
    throw new OutcomePolicyError(`§29.6: l'esito di ${dec} non può essere registrato dall'agente che ha deciso (${decision.agent})`);
  }
  const file = join(root, "outcomes", `${dec}.out.yaml`);
  const existing = db.prepare("select result from outcomes where decision_code=?").get(dec);
  if (existing) {
    if (existing.result === result) return { dec, result, file, unchanged: true };
    throw new OutcomePolicyError(`esito di ${dec} già registrato (${existing.result}): non si sovrascrive con '${result}'`);
  }
  const expected = db.prepare("select expect from expected_outcomes where decision_code=?").get(dec)?.expect ?? null;
  const doc = { decision: dec };
  if (expected) doc.expected = expected;
  Object.assign(doc, { verified_at: at, verified_by: verified_by.trim(), result });
  if (evidence) doc.evidence = evidence;
  if (note) doc.note = note;
  db.transaction(() => {
    db.prepare("insert into outcomes(decision_code,verified_at,verified_by,result,evidence_code,note) values (?,?,?,?,?,?)")
      .run(dec, at, verified_by.trim(), result, evidence, note);
    mkdirSync(join(root, "outcomes"), { recursive: true });
    writeFileSync(file, YAML.stringify(doc));
  })();
  return { dec, result, file, unchanged: false };
}

export function pending(db, { session } = {}) {
  const where = ["o.decision_code is null"];
  const args = [];
  if (session) { where.push("e.session = ?"); args.push(session); }
  return db.prepare(`select e.decision_code as dec, e.expect, e.session, e.lesson_code as lesson, coalesce(e.release_ref, c.release_ref) as release,
      d.table_code as "table", d.agent
    from expected_outcomes e
    left join decisions d on d.code = e.decision_code
    left join decision_context c on c.decision_code = e.decision_code
    left join outcomes o on o.decision_code = e.decision_code
    where ${where.join(" and ")} order by e.decision_code`).all(...args);
}

// releasesNow: release ordinate dalla più vecchia, l'ultima è la corrente (nomi o { name }).
export function expire(db, releasesNow, { root, at = new Date().toISOString() } = {}) {
  const names = (releasesNow ?? []).map((r) => (typeof r === "string" ? r : r?.name)).filter(Boolean);
  if (!names.length) throw new OutcomeInputError("expire: elenco delle release vuoto");
  const idx = new Map(names.map((n, i) => [n, i]));
  const cur = names.length - 1;
  const expired = [];
  for (const p of pending(db)) {
    if (!p.release || !idx.has(p.release)) continue;          // release ignota: non si può dire, si lascia pendente
    const age = cur - idx.get(p.release);
    if (age < EXPIRE_AFTER_RELEASES) continue;
    record(db, root, { dec: p.dec, result: "non-verificabile", verified_by: "tempo", at,
      note: `nessuna verifica entro ${EXPIRE_AFTER_RELEASES} release (${p.release} → ${names[cur]})` });
    expired.push({ dec: p.dec, release: p.release, age });
  }
  return expired;
}

export function listOutcomes(db, { session, since } = {}) {
  const where = ["1=1"];
  const args = [];
  if (session) { where.push("d.session = ?"); args.push(session); }
  if (since) { where.push("o.verified_at >= ?"); args.push(since); }
  return db.prepare(`select o.decision_code as dec, o.result, o.verified_at, o.verified_by, o.evidence_code as evidence, o.note,
      d.table_code as "table", d.outcome, d.session
    from outcomes o left join decisions d on d.code = o.decision_code
    where ${where.join(" and ")} order by o.decision_code`).all(...args);
}

export const HELP = `uso: learn outcomes [--week | --session SES…] [--confirm <DEC> | --disprove <DEC> | --partial <DEC>]
                [--by <chi>] [--evidence <codice>] [--note "…"] [--expire --releases R1,R2,…]
                --db <knowledge.db> --root <cartella del cliente> [--json] [--help]

Registro degli esiti (§12.1, §29.6).
  senza azione   DEC con esito atteso ancora da verificare (pending) ed esiti registrati
                 (--week: ultimi 7 giorni; --session: della sessione)
  --confirm      esito 'confermata' · --disprove 'smentita' · --partial 'parziale'
                 --by: chi verifica (esecuzione · umano · contraddizione; default umano);
                 mai l'agente che ha preso la DEC (exit 3)
  --expire       DEC senza verifica da ${EXPIRE_AFTER_RELEASES} release → non-verificabile (--releases dalla più vecchia)
Scrive <root>/outcomes/<DEC>.out.yaml e la riga outcomes del DB.

Exit code: 0 ok · 1 errore utente (argomenti, DEC inesistente, esito fuori vocabolario, DB assente)
· 2 errore di sistema · 3 rifiutato per policy (autore della DEC, esito già registrato diverso).`;

export function run(argv) {
  const { opts } = parseArgs(argv, { flags: ["week", "expire"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.db) return fail(asJson, 1, "richiesto --db <file>");
  let db;
  try { db = openDb(opts.db, { createIfMissing: false }); } catch (e) { return fail(asJson, 1, String(e.message ?? e)); }
  try {
    const action = opts.confirm ? ["confermata", opts.confirm] : opts.disprove ? ["smentita", opts.disprove] : opts.partial ? ["parziale", opts.partial] : null;
    if (action) {
      if (!opts.root) return fail(asJson, 1, "--confirm/--disprove/--partial richiedono --root");
      const r = record(db, opts.root, { dec: action[1], result: action[0], verified_by: opts.by ?? "umano", evidence: opts.evidence ?? null, note: opts.note ?? null });
      console.log(JSON.stringify(asJson ? { ok: true, ...r } : r));
      return 0;
    }
    if (opts.expire) {
      if (!opts.root || !opts.releases) return fail(asJson, 1, "--expire richiede --root e --releases R1,R2,…");
      const r = expire(db, String(opts.releases).split(",").map((s) => s.trim()).filter(Boolean), { root: opts.root });
      console.log(JSON.stringify(asJson ? { ok: true, expired: r } : r));
      return 0;
    }
    const since = opts.week ? new Date(Date.now() - 7 * 86400000).toISOString() : undefined;
    const out = { pending: pending(db, { session: opts.session }), outcomes: listOutcomes(db, { session: opts.session, since }) };
    console.log(JSON.stringify(asJson ? { ok: true, ...out } : out));
    return 0;
  } catch (e) {
    if (e instanceof OutcomePolicyError) return fail(asJson, 3, e.message);
    if (e instanceof OutcomeInputError) return fail(asJson, 1, e.message);
    return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`);
  } finally { db.close(); }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
