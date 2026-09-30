// Raggio d'azione di una modifica a un campo (§19.6.2 "lineage", §19.6.5, §19.6.6 config-designer):
// "se rendo opzionale questo campo, cosa si rompe a valle?".
//
//   impact(db, code, { if? }) → { code, if, downstream[], breaks[], unknown[] }
//     downstream: tutto ciò che il campo alimenta, per relations (propagates_to, required_by,
//                 derived_from all'inverso), a qualsiasi profondità, con i dettagli di field_lineage;
//     if:        "mandatory.kind = never" (o "removed"/"rimosso": il campo sparisce) — il campo può
//                arrivare vuoto a valle. Si rompe:
//                · un mapping INT con mandatory_there (il messaggio è rifiutato o parte vuoto, §27.2);
//                · un FLD/LCY che lo richiede (required_by, con la nota);
//                · un FLD a valle obbligatorio (propagates_to/derived_from) che riceverebbe vuoto;
//                il vuoto prosegue oltre i campi a valle NON obbligatori (transitivo);
//                "mandatory.kind = always|conditional|undocumented": nessuna rottura a valle.
//     unknown:   campi a valle non modellati (nessuna riga in fields): da verificare.
import { MANDATORY_KINDS } from "./validate-fld.mjs";
import { parseCode } from "./codes.mjs";
import { InvalidInputError, NotFoundError } from "./fields.mjs";

const IF_RE = /^\s*mandatory\.kind\s*=\s*([a-z]+)\s*$/;
const typeOf = (c) => parseCode(String(c))?.type ?? null;

export function parseIf(expr) {
  if (expr === undefined || expr === null || expr === "") return null;
  const s = String(expr).trim();
  if (/^(removed|rimosso|remove|rimuovi)$/i.test(s)) return { kind: "removed" };
  const m = IF_RE.exec(s);
  if (!m || !MANDATORY_KINDS.includes(m[1])) throw new InvalidInputError(`--if non riconosciuto: «${expr}» (ammessi: "mandatory.kind = ${MANDATORY_KINDS.join("|")}", "removed")`);
  return { kind: "mandatory", value: m[1] };
}

export function impact(db, code, { if: cond } = {}) {
  const hyp = parseIf(cond);
  const known = db.prepare("select 1 from fields where code = ? union select 1 from items where code = ? union select 1 from relations where from_code = ? limit 1").get(code, code, code);
  if (!known) throw new NotFoundError(`campo inesistente: ${code}`);
  const out = db.prepare(`select r.from_code, r.to_code, r.kind, l.document, l.transform, l.mapping, l.mandatory_there, l.note, l.reason_kind
    from relations r left join field_lineage l on l.from_code = r.from_code and l.to_code = r.to_code and l.kind = r.kind
    where r.from_code = ? and r.kind in ('propagates_to','required_by')`);
  const derived = db.prepare("select from_code as code from relations where to_code = ? and kind = 'derived_from'");
  const fieldOf = db.prepare("select mandatory_kind, document from fields where code = ?");
  const downstream = [];
  const seen = new Set([code]);
  const queue = [{ code, depth: 0, carriesEmpty: true }];
  const breaks = [];
  const unknown = [];
  const breaking = hyp && (hyp.kind === "removed" || hyp.value === "never");
  while (queue.length) {
    const cur = queue.shift();
    const edges = [...out.all(cur.code).map((e) => ({ ...e, to: e.to_code })),
      ...derived.all(cur.code).map((d) => ({ from_code: cur.code, to: d.code, kind: "derived_from", transform: null }))];
    for (const e of edges) {
      const target = fieldOf.get(e.to);
      const step = { code: e.to, from: cur.code, via: e.kind, depth: cur.depth + 1, document: e.document ?? target?.document ?? null, transform: e.transform ?? null,
        mapping: e.mapping ?? null, mandatory_there: e.mandatory_there === null || e.mandatory_there === undefined ? null : !!e.mandatory_there, note: e.note ?? null };
      downstream.push(step);
      let emptyContinues = false;
      if (breaking && cur.carriesEmpty) {
        const t = typeOf(e.to);
        let why = null;
        if (e.kind === "required_by" && t === "INT") {
          if (e.mandatory_there) why = `mapping obbligatorio ${e.mapping ?? ""} in ${e.to}: il messaggio sarà rifiutato o partirà con il campo vuoto`.replace("  ", " ");
        } else if (e.kind === "required_by") {
          why = e.note ? `richiesto a valle: ${e.note}` : `richiesto da ${e.to}${e.reason_kind ? ` (${e.reason_kind})` : ""}`;
        } else if (t === "FLD") {
          if (!target) { if (!unknown.some((u) => u.code === e.to)) unknown.push({ code: e.to, from: cur.code, via: e.kind, reason: "campo a valle non modellato: verificare se è obbligatorio" }); }
          else if (target.mandatory_kind && target.mandatory_kind !== "never") why = `campo a valle obbligatorio (${target.mandatory_kind}) riceverebbe il valore vuoto${e.transform ? ` (${e.transform})` : ""}`;
          else emptyContinues = true;   // a valle opzionale: il vuoto prosegue
        }
        if (why && !breaks.some((b) => b.code === e.to)) breaks.push({ ...step, why });
      }
      if (!seen.has(e.to)) { seen.add(e.to); queue.push({ code: e.to, depth: cur.depth + 1, carriesEmpty: emptyContinues }); }
    }
  }
  const brokenCodes = new Set(breaks.map((b) => b.code));
  return { code, if: hyp ? (hyp.kind === "removed" ? "removed" : `mandatory.kind = ${hyp.value}`) : null, downstream, breaks,
    unknown: breaking ? unknown.filter((u) => !brokenCodes.has(u.code)) : [] };
}
