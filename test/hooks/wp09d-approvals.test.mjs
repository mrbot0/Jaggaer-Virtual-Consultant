// WP09d — approvazioni amministrative (§54.4, §56.8, §22.2): le frasi APPROVO PURGE <ID> DA <Nome>,
// APPROVO PROMOZIONE <codice>, APPROVO RETENTION <ID> nascono SOLO dal prompt dell'utente (approval-capture); il modello
// non può scriverle in nessun input di strumento (guard-phrase, guard-config-scope).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runHook, decisionOf, ROOT } from "../helpers/hook-env.mjs";
import { ws09d, withSession, say } from "../helpers/wp09d.mjs";
import { parseApprovalPrompt, findGrant } from "../../scripts/admin/approvals.mjs";
import { validateWith } from "../../scripts/lib/schemas.mjs";

const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const guard = (name, ws, tool, ti) => runHook(name, { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input: ti }, E(ws));

test("parseApprovalPrompt: purge (con e senza DA), promozione, retention", () => {
  assert.deepEqual(parseApprovalPrompt("APPROVO PURGE ACME DA Mario Rossi"), { kind: "purge", target: "ACME", approver: "Mario Rossi" });
  assert.deepEqual(parseApprovalPrompt("APPROVO PURGE ACME"), { kind: "purge", target: "ACME", approver: null });
  assert.deepEqual(parseApprovalPrompt("APPROVO PROMOZIONE L.ACME.CAT.FLW.0001"), { kind: "promote", target: "L.ACME.CAT.FLW.0001", approver: null });
  assert.deepEqual(parseApprovalPrompt("APPROVO RETENTION ACME DA Anna Bianchi."), { kind: "retention", target: "ACME", approver: "Anna Bianchi" });
  assert.equal(parseApprovalPrompt("approvo purge acme").kind, "attempt", "minuscole: non è la frase");
});

test("approval-capture: purge solo con DA <Nome>, due nomi diversi, cliente esistente; record conforme allo schema", () => {
  const ws = ws09d(); withSession(ws);
  let s = say(ws, "APPROVO PURGE ACME");
  assert.equal(s.records.length, 0); assert.match(s.context, /DA <Nome Cognome>/);
  s = say(ws, "APPROVO PURGE ZZZZ DA Mario Rossi");
  assert.equal(s.records.length, 0); assert.match(s.context, /non esiste/);
  s = say(ws, "APPROVO PURGE ACME DA Mario Rossi");
  assert.equal(s.last.kind, "purge"); assert.equal(s.last.target, "ACME"); assert.equal(s.last.approver_declared, "Mario Rossi");
  assert.match(s.context, /token [0-9a-f]{16}/);
  s = say(ws, "APPROVO PURGE ACME DA mario  rossi");
  assert.equal(s.records.length, 1, "stessa persona: rifiutata"); assert.match(s.context, /persona diversa/);
  s = say(ws, "APPROVO PURGE ACME DA Anna Bianchi");
  assert.equal(s.records.length, 2);
  for (const r of s.records) assert.deepEqual(validateWith("approval.schema.json", r).errors, []);
});

test("approval-capture: retention e promozione registrate con il bersaglio; findGrant controlla tipo, bersaglio, monouso e finestra", () => {
  const ws = ws09d(); withSession(ws);
  mkdirSync(join(ws, "customers", "ACME", "runs"), { recursive: true });
  const r = say(ws, "APPROVO RETENTION ACME");
  assert.equal(r.last.kind, "retention");
  const p = say(ws, "APPROVO PROMOZIONE C.ACME.CAT.FLW.0001");
  assert.equal(p.last.kind, "promote");
  const recs = p.records;
  assert.equal(findGrant(recs, { kind: "retention", target: "ACME", token: r.last.hash.slice(0, 12) }).ok, true);
  assert.match(findGrant(recs, { kind: "purge", target: "ACME", token: r.last.hash.slice(0, 12) }).reason, /non purge/);
  assert.match(findGrant(recs, { kind: "retention", target: "BETA", token: r.last.hash }).reason, /approva ACME/);
  assert.match(findGrant(recs, { kind: "retention", target: "ACME", token: "abc" }).reason, /token non valido/);
  assert.match(findGrant(recs, { kind: "retention", target: "ACME", token: r.last.hash, now: Date.now() + 2 * 3600000 }).reason, /scaduta/);
  const consumed = [...recs, { kind: "consume", ref: r.last.hash, hash: "f".repeat(64) }];
  assert.match(findGrant(consumed, { kind: "retention", target: "ACME", token: r.last.hash }).reason, /già stata usata/);
});

test("guard-phrase e guard-config-scope: il modello non scrive le frasi amministrative in nessun input di strumento", () => {
  const ws = ws09d(); withSession(ws);
  for (const phrase of ["APPROVO PURGE ACME DA Mario Rossi", "APPROVO PROMOZIONE C.ACME.CAT.FLW.0001", "APPROVO RETENTION ACME"]) {
    assert.equal(decisionOf(guard("guard-phrase", ws, "SendMessage", { message: phrase })), "deny", phrase);
    assert.equal(decisionOf(guard("guard-phrase", ws, "mcp__x__send", { payload: { text: `ok ${phrase}` } })), "deny", phrase);
    assert.equal(decisionOf(guard("guard-config-scope", ws, "Write", { file_path: join(ws, "note.md"), content: phrase })), "deny", phrase);
  }
  assert.equal(guard("guard-phrase", ws, "SendMessage", { message: "la purge richiede due approvazioni" }).stdout.trim(), "", "citare la purge senza la frase è ammesso");
});
