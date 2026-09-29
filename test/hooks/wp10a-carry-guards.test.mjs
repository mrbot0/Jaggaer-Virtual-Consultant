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

// WP10a — difetto trovato rendendo i comandi contro i guard veri: guard-config-scope trattava ogni build-*.mjs come un
// generatore del pacchetto e negava build-report.mjs (/nrt report, RPT degli agenti) e build-payload.mjs (Xray).
const cfgGuard = (ws, command) => runHook("guard-config-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
test("guard-config-scope: build-report e build-payload non sono generatori del pacchetto; i generatori restano negati (salvo --check/--help)", () => {
  const ws = ws09d(); withSession(ws);
  assert.ok(silent(cfgGuard(ws, `node "${script("scripts/report/build-report.mjs")}" --kind test --title Regressione --run RUN.ACME.20260923.1000.CAT --json`)), "build-report");
  assert.ok(silent(cfgGuard(ws, `node "${script("scripts/xray/build-payload.mjs")}" --run RUN.ACME.20260923.1000.CAT --json`)), "build-payload");
  for (const g of ["scripts/admin/build-deny-rules.mjs", "scripts/lib/build-session-validator.mjs", "scripts/chrome/build-error-patterns.mjs"]) {
    assert.ok(denied(cfgGuard(ws, `node "${script(g)}"`)), g);
    assert.ok(silent(cfgGuard(ws, `node "${script(g)}" --check`)), `${g} --check`);
  }
  assert.ok(denied(cfgGuard(ws, `node "${script("scripts/admin/integrity.mjs")}" build`)), "integrity build");
});

// Giro di correzione 1 (I1): il primo argomento dopo kb|lifecycle|learn.mjs si decide DOPO lo scioglimento della shell
// (backslash, virgolette, ^ di cmd, backtick di PowerShell), con lo stesso tokenizzatore di hooks/lib/exact-argv.mjs:
// un `promote` mascherato non salta più la forma esatta (DR-OK-003..005: conferma nel transcript, argomenti validati).
test("I1 DR-SHELL-008: promote mascherato da backslash, virgolette, ^ o backtick ⇒ deny; dentro bash -c e con jolly nel nome dello script", () => {
  const ws = ws09d(); withSession(ws);
  const B = String.fromCharCode(92); // backslash
  const T = String.fromCharCode(96); // backtick
  const kbDir = KB.slice(0, -"kb.mjs".length - 1);
  const C = "L.ACME.CAT.FLW.0001 --customer ACME";
  const probes = [
    `node "${KB}" ${B}promote ${C} --to product`,
    `node "${LEARN}" pro${B}mote ${C}`,
    `node "${KB}" p${B}romote ${C}`,
    `node "${KB}" promot${B}e ${C}`,
    `node "${KB}" "pro"mote ${C}`,
    `node "${KB}" pro'mo'te ${C}`,
    `node "${KB}" ${B}"promote${B}" ${C}`,
    `node "${KB}" "${B}promote" ${C}`,
    `node "${LIFE}" pro^mote ${C}`,
    `node "${KB}" pro${T}mote ${C}`,
    `node "${KB}" ${B}\npromote ${C}`,
    `bash -c "node '${KB.split(B).join("/")}' pro${B}${B}mote ${C}"`,
    `node "${kbDir}/k?.mjs" promote ${C}`,
    `node --no-warnings "${KB}" ${B}promote ${C}`,
  ];
  for (const cmd of probes) { const r = guard(ws, cmd); assert.ok(denied(r), `non negato: ${cmd}`); assert.match(reasonOf(r), /DR-SHELL-008|DR-OK-00[345]/, cmd); }
  // restano ammessi: promote come valore di un'opzione (anche mascherato) e la forma esatta L → C
  for (const cmd of [`node "${KB}" find --text ${B}promote --json`, `node "${KB}" resolve pro${B}mote --json`, `node "${KB}" promote L.ACME.CAT.FLW.0001 --customer ACME --json`]) {
    const r = guard(ws, cmd); assert.ok(silent(r), `${cmd}: ${reasonOf(r)}`);
  }
});
