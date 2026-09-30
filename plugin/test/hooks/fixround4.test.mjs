// Fix round 4 (re-review del giro 3): i comandi di scrittura di sed (`w`, `W`,
// flag `w` di `s///`) e le scritture di perl/ruby senza -i passano dal guard
// delle scritture via shell; il riconoscimento di -i è preciso (niente falsi
// positivi su -Ilib / -Mstrict). Ogni probe del revisore è un caso di test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { mkWs, seedSession, runHook, decisionOf, ROOT } from "../helpers/hook-env.mjs";

const SUB = { agent_id: "a1", agent_type: "scope-expert" };
const env = (ws) => ({ CLAUDE_PROJECT_DIR: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const pre = (guard, ws, command, extra = {}, tool = "Bash") =>
  runHook(guard, { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, ...extra }, env(ws));
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";

const KB = "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0001.yaml";
const SESS = "customers/ACME/.sessions/sess-1";

test("F6 sub-agente: i comandi `w`/`W` di sed e il flag `w` di s/// verso aree protette sono negati anche senza -i", () => {
  const ws = mkWs(); seedSession(ws);
  for (const c of [
    // la probe del revisore
    `sed -n -e 's/a/b/w ${KB}' /dev/null`,
    // script come primo argomento non-opzione
    `sed -n 's/a/b/w ${SESS}/session.json' /dev/null`,
    `sed -n '1w ${SESS}/invocations.jsonl' /etc/hosts`,
    `sed -n 'W ${SESS}/blackboard/y.yaml' /etc/hosts`,
    `sed -n '/x/w customers/ACME/kb/scopes/CAT/flows/y.yaml' /etc/hosts`,
    `sed -n 's|a|b|gw ${SESS}/blackboard/x.yaml' /etc/hosts`,
    // il comando dopo un `;` dentro lo script
    `sed -e 'p;w ${SESS}/blackboard/x.yaml' /etc/hosts`,
    `sed -n '/a/{p;w product/kb/scopes/CAT/x.yaml\n}' /etc/hosts`,
    `sed --expression='$w ${SESS}/compact-summary.md' /etc/hosts`,
    `sed --expression '$w ${SESS}/compact-summary.md' /etc/hosts`,
    `sed -ne 's/a/b/w ${KB}' /etc/hosts`,
    `sed -n -es/a/b/w${KB} /etc/hosts`,
    `sed -n 1wcustomers/ACME/.sessions/sess-1/session.json /etc/hosts`,
    `sed -n -e p -e 'w ${KB}' /etc/hosts`,
    `sed -s -n -E 's/(a)/\\1/w ${KB}' /etc/hosts`,
    // cd seguito
    `cd customers/ACME && sed -n 's/a/b/w kb/scopes/CAT/flows/x.yaml' /dev/null`,
    // annidato: bash -c, sostituzione di comando, wrapper
    `bash -c "sed -n 's/a/b/w ${KB}' /dev/null"`,
    `x=$(sed -n '1w ${SESS}/session.json' /etc/hosts)`,
    `echo "$(sed -n '1w ${SESS}/session.json' /etc/hosts)"`,
    `env LC_ALL=C sed -n '1w ${KB}' /etc/hosts`,
    `/usr/bin/sed -n '1w ${KB}' /etc/hosts`,
    // script da file (contenuto ignoto) o comando `e`: non analizzabile → fail-closed se il comando cita un'area protetta
    `sed -f /tmp/script.sed ${KB}`,
    `sed -n --file=/tmp/script.sed ${KB}`,
    `sed -n '1e touch x' ${KB}`,
  ]) assert.ok(denied(pre("guard-scope", ws, c, SUB)), c);
});

test("F6 sub-agente: sed in lettura resta permesso, anche con w/W dentro regex e sostituzioni; `w` verso un'area scrivibile è permesso", () => {
  const ws = mkWs(); seedSession(ws);
  for (const c of [
    `sed -n 1,5p ${KB}`,
    `sed -n '/workflow/p' ${KB}`,
    `sed -n 's/w/W/gp' ${KB}`,
    `sed -n -e 's/wide/wall/g' -e '/w/p' ${KB}`,
    `sed -n '/^w /p' ${KB}`,
    `sed -E 's|a|b|g' ${KB}`,
    `sed 'y/abw/xyz/' ${KB}`,
    `sed -n '$=' ${KB}`,
    `sed '/a/{p;d}' ${KB}`,
    `sed --posix -n 1p ${KB}`,
    `sed -n 's/a/b/w customers/ACME/lessons/out.md' ${KB}`,
    `sed -n 's/a/b/w /tmp/out.txt' ${KB}`,
    `sed 's/x/y/' ${KB} > customers/ACME/lessons/x.md`,
  ]) assert.ok(silent(pre("guard-scope", ws, c, SUB)), c);
});

test("F6 sub-agente: perl/ruby senza -i — codice -e che cita un'area protetta, o che apre/rinomina/abilita $^I sugli argomenti, è negato", () => {
  const ws = mkWs(); seedSession(ws);
  for (const c of [
    `perl -e 'open my $f, ">", "${SESS}/session.json"; print $f "{}"'`,
    `perl -e 'rename q(/tmp/x), q(${KB})'`,
    `perl -E 'open(F, ">>${SESS}/invocations.jsonl")'`,
    `perl -e 'open F, ">", $ARGV[0]' ${SESS}/session.json`,
    `perl -ne 'BEGIN{$^I=""} print' ${KB}`,
    `perl -MFile::Copy -e 'copy("/tmp/x", "${KB}")'`,
    `ruby -e 'File.write("${KB}", "x")'`,
  ]) assert.ok(denied(pre("guard-scope", ws, c, SUB)), c);
});

test("F6 -i preciso: sed --in-place, -i.bak, -ni, -Ei, perl -pi -e, -i -pe, -i.bak negati; perl -Ilib / -Mstrict in lettura permessi", () => {
  const ws = mkWs(); seedSession(ws);
  for (const c of [
    `sed --in-place s/a/b/ ${KB}`,
    `sed --in-place=.bak s/a/b/ ${KB}`,
    `sed -i.bak s/a/b/ ${KB}`,
    `sed -ni 's/a/b/p' ${KB}`,
    `sed -Ei 's/a/b/' ${KB}`,
    `sed -e s/a/b/ -i ${KB}`,
    `perl -pi -e s/a/b/ ${KB}`,
    `perl -i -pe s/a/b/ ${KB}`,
    `perl -i.bak -pe s/a/b/ ${KB}`,
    `perl -Mstrict -pi -e s/a/b/ ${SESS}/session.json`,
    `ruby -i -pe 'sub(/a/, "b")' ${KB}`,
  ]) assert.ok(denied(pre("guard-scope", ws, c, SUB)), c);
  for (const c of [
    `perl -Ilib -ne print ${KB}`,
    `perl -Mstrict -ne print ${KB}`,
    `perl -Mstrict -Mwarnings -ne 'print if /id/' ${KB}`,
    `perl -I/usr/share/perl5 -lane 'print $F[0]' ${KB}`,
    `perl -0777 -ne print ${KB}`,
    `perl -CSD -ne print ${KB}`,
    `perl /tmp/report.pl ${KB}`,
    `perl -ne print customers/ACME/lessons/x.md`,
    `ruby -ne 'puts $_' ${KB}`,
  ]) assert.ok(silent(pre("guard-scope", ws, c, SUB)), c);
});

test("F6 sessione principale: sed w / -i e perl -i verso session.json, invocations.jsonl e .jvc negati; letture silenziose in tutti i guard di shell", () => {
  const ws = mkWs(); seedSession(ws);
  for (const c of [
    `sed -n 's/a/b/w .jvc/current-session' /etc/hosts`,
    `sed -n '1w ${SESS}/session.json' /etc/hosts`,
    `sed -n 'W ${SESS}/invocations.jsonl' /etc/hosts`,
    `sed --in-place s/a/b/ .jvc/current-session`,
    `perl -i -pe s/a/b/ ${SESS}/session.json`,
  ]) assert.ok(denied(pre("guard-scope", ws, c)), c);
  for (const c of [`sed -n 1p .jvc/current-session`, `perl -Ilib -ne print .jvc/current-session`, `sed -n 's/a/b/w customers/ACME/lessons/o.md' ${KB}`,
    `git commit -m "fix: sed handling of session.json"`, `ls | sed s/a/b/ > out.txt 2>&1`]) {
    for (const g of ["guard-budget", "guard-scope", "guard-customer"]) assert.ok(silent(pre(g, ws, c)), `${g}: ${c}`);
  }
});

test("F6 PowerShell: la stessa analisi vale per lo strumento PowerShell (barre rovesce comprese)", () => {
  const ws = mkWs(); seedSession(ws);
  assert.ok(denied(pre("guard-scope", ws, `sed -n '1w customers\\ACME\\.sessions\\sess-1\\session.json' C:\\tmp\\x`, SUB, "PowerShell")));
  assert.ok(denied(pre("guard-scope", ws, `sed -i s/a/b/ customers\\ACME\\kb\\scopes\\CAT\\flows\\C.ACME.CAT.FLW.0001.yaml`, SUB, "PowerShell")));
});

test("F6: fuori da un workspace JVC la probe sed resta senza opinione", () => {
  const plain = realpathSync.native(mkdtempSync(join(tmpdir(), "plain-")));
  mkdirSync(join(plain, "src"));
  for (const g of ["guard-budget", "guard-scope", "guard-customer"]) {
    const r = runHook(g, { session_id: "x", cwd: plain, tool_name: "Bash", tool_input: { command: "sed -n -e 's/a/b/w src/session.json' /dev/null" } }, env(plain));
    assert.ok(silent(r), `${g}: ${r.stdout}`);
  }
});
