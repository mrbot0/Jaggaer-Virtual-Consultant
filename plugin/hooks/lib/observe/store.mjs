// observe-append, stadio "registrazione" (29/10/2026, punto 7): OBS nel DB della conoscenza (codice dal SEQ, conferme per
// firma di pagina, ERR grezzi con conteggio) e file YAML degli ERR grezzi. Fail-open in record(): un guasto qui non tocca
// il legame dei ref né i guard.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomic } from "../fsx.mjs";
import { toYaml } from "../../../scripts/lib/yaml-lite.mjs";

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");

export function writeDb(ws, customer, scope, doc, errors, now) {
  return import("../../../scripts/kb/db.mjs").then(async ({ openDb }) => {
    const { assignSeq, formatCode } = await import("../../../scripts/kb/assign-seq.mjs");
    mkdirSync(join(ws, "customers", customer), { recursive: true });
    const db = openDb(join(ws, "customers", customer, "knowledge.db"));
    try {
      return db.transaction(() => {
        const key = { level: "L", customer, scope, type: "OBS" };
        const code = formatCode({ ...key, seq: assignSeq(db, key, { table: "observations" }) });
        const confirmed = doc.page_signature ? (db.prepare("select count(*) as n from observations where page_sig = ?").get(doc.page_signature).n + 1) : 1;
        doc.id = code;
        doc.confirmed_count = confirmed;
        const errs = [];
        for (const e of errors) {
          const hash = sha(`${e.category}|${e.code ?? ""}|${e.message.toLowerCase()}`).slice(0, 16);
          const raw_id = `ERR-RAW.${hash.slice(0, 8)}`;
          const row = db.prepare("select * from errors_raw where hash = ?").get(hash);
          const ts = now.toISOString();
          if (row) {
            const sessions = [...new Set([...JSON.parse(row.sessions), doc.session])];
            db.prepare("update errors_raw set last_seen=?, count=count+1, sessions=?, last_obs=? where hash=?").run(ts, JSON.stringify(sessions), code, hash);
            errs.push({ ...e, hash, raw_id, file: row.file, count: row.count + 1, first_seen: row.first_seen, sessions, repeat: true });
          } else {
            const file = `customers/${customer}/kb/scopes/${scope}/errors/_raw/${stamp(now)}${errs.length ? `-${errs.length}` : ""}.yaml`;
            db.prepare(`insert into errors_raw(hash,raw_id,customer,scope,message,code,category,kind,blocking,lang,page_sig,file,first_seen,last_seen,count,sessions,last_obs)
              values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(hash, raw_id, customer, scope, e.message, e.code, e.category, e.kind, e.blocking ? 1 : 0, e.lang, doc.page_signature, file, ts, ts, JSON.stringify([doc.session]), code);
            errs.push({ ...e, hash, raw_id, file, count: 1, first_seen: ts, sessions: [doc.session], repeat: false });
          }
        }
        doc.errors = errs.map((e) => ({ raw_id: e.raw_id, code: e.code, category: e.category, kind: e.kind, count: e.count }));
        const payload = JSON.stringify(doc);
        db.prepare("insert into observations(code, session, scope, page_sig, payload, confirmed_count) values (?,?,?,?,?,?)")
          .run(code, doc.session, scope, doc.page_signature, payload, confirmed);
        return { code, errs, payload };
      }).immediate();
    } finally { db.close(); }
  });
}

export function writeErrFile(ws, e, doc, scope, now) {
  const abs = join(ws, ...e.file.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  const body = {
    raw_id: e.raw_id, type: "ERR", status: "grezzo", scope,
    message: { [e.lang]: e.message, [e.lang === "it" ? "en" : "it"]: null },
    code: e.code, category: e.category, kind: e.kind, blocking: e.blocking,
    page_signature: doc.page_signature,
    trigger: { plan: doc.at_step?.plan ?? null, step: doc.at_step?.n ?? null, tool: doc.tool },
    observed: { first: e.first_seen, last: now.toISOString(), count: e.count, sessions: e.sessions, last_obs: doc.id },
    hash: e.hash,
    note: "ERR grezzo scritto da observe-append (§20.6.2): il digester dello scope lo completa (meaning, resolution, related) e ne assegna il codice.",
  };
  writeFileAtomic(abs, toYaml(body));
}

