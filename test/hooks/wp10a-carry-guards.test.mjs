// WP10a — riporti sui guard (ruling del controller 1a): DR-SHELL-008 non nega più le invocazioni benigne che contengono
// la parola `promote` (kb find --text promote, promote --help); la promozione resta ammessa solo nella forma esatta, con
// `promote` come primo argomento dopo lo script, e l'uso programmatico dei moduli (import/require + promote) resta negato.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runHook, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";
import { ws09d, withSession, say, script } from "../helpers/wp09d.mjs";

const KB = script("scripts/kb/kb.mjs");
const LEARN = script("scripts/digest/learn.mjs");
const LIFE = script("scripts/kb/lifecycle.mjs");
const guard = (ws, command, transcript_path) => runHook("guard-destructive", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...(transcript_path ? { transcript_path } : {}) }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";

test("DR-SHELL-008: la parola promote in un'invocazione benigna non è negata (kb find --text promote, units --query promote)", () => {
  const ws = ws09d(); withSession(ws);
  for (const cmd of [
    `node "${KB}" find --text promote --json`,
    `node "${KB}" resolve promote --top 5 --json`,
    `node "${KB}" units --query promote --json`,
    `node "${LEARN}" outcomes --note promote --json`,
  ]) { const r = guard(ws, cmd); assert.ok(silent(r), `${cmd}: ${reasonOf(r)}`); }
});

test("DR-SHELL-008: promote --help (sola lettura) è ammesso per kb.mjs, lifecycle.mjs e learn.mjs", () => {
  const ws = ws09d(); withSession(ws);
  for (const s of [KB, LIFE, LEARN]) { const r = guard(ws, `node "${s}" promote --help`); assert.ok(silent(r), `${s}: ${reasonOf(r)}`); }
});

test("DR-SHELL-008: la promozione resta a forma esatta — catene, opzioni estranee, token senza frase e uso programmatico negati", () => {
  const ws = ws09d(); withSession(ws);
  const p = say(ws, "APPROVO PROMOZIONE L.ACME.CAT.FLW.0001");
  const pt = p.last.hash.slice(0, 16);
  assert.ok(silent(guard(ws, `node "${KB}" promote L.ACME.CAT.FLW.0001 --customer ACME --to product --approval ${pt} --json`, p.transcript)), "forma esatta con frase nel transcript");
  assert.ok(denied(guard(ws, `cd x && node "${KB}" promote L.ACME.CAT.FLW.0001 --customer ACME --to product --approval ${pt}`, p.transcript)), "catena");
  assert.ok(denied(guard(ws, `node "${KB}" promote --help ; node "${KB}" promote L.ACME.CAT.FLW.0001 --customer ACME --to product --approval ${pt}`, p.transcript)), "help in catena");
  assert.ok(denied(guard(ws, `node "${KB}" promote --help --to product`)), "help con altre opzioni");
  assert.ok(denied(guard(ws, `node "${LEARN}" promote L.ACME.CAT.FLW.0001 --customer ACME --approval 0123456789abcdef`)), "token inesistente");
  assert.ok(denied(guard(ws, `node -e "import('${KB.replace(/\\/g, "/")}').then((m) => m.runAsync(['promote','L.ACME.CAT.FLW.0001','--customer','ACME']))"`)), "uso programmatico con import");
  assert.ok(denied(guard(ws, `node --input-type=module -e "const m = await import('./scripts/kb/lifecycle.mjs'); await m.main('promote', [])"`)), "lifecycle via import");
  assert.ok(denied(guard(ws, `node "${KB}" promote L.ACME.CAT.FLW.0001 --customer ACME --workspace C:\\`)), "opzione non ammessa");
});
