// N1 (verifica del 27/10/2026): observe-append su una pagina davvero pesante, senza tetti sul numero di elementi
// (decisione dell'utente), deve chiudere ben sotto il timeout dell'hook (60 s dal 27/10/2026, hooks/hooks.json): se l'hook
// scade il marcatore della chiamata resta aperto e i click sulla scheda sono negati (finché una lettura completa riuscita
// della scheda non lo chiude).
// Pagina di 20 000 elementi (campi, pulsanti, link, contenitori) con una mappa di ~1000 SEL dello scope popolata: un
// take_snapshot di DevTools in linea e uno con filePath (file scritto dallo strumento nella cartella snapshots/ della
// sessione, con il marcatore di guard-environment) — processo completo dell'hook < 5 s ciascuno, fino a 3 tentativi.
// Guard sulla grandezza tolto (27/10/2026): la stessa pagina con 400 miniature in base64 da 20 KB e un'anteprima da 12 MB
// (Analytics Launchpad: prima faceva fallire l'hook) — il base64 si toglie prima della lettura, stesso risultato.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { envWs, writeSel, readSession } from "../helpers/env-fixture.mjs";
import { runHook, ROOT } from "../helpers/hook-env.mjs";

const DT = "mcp__chrome-devtools__";
const URL0 = "https://acme-pre.jaggaer.com/p2p/req/1";
const N = 20000;
const NSEL = 1000;
const LIMIT = 5000;
const ATTEMPTS = 3;
const ROLES = ["textbox", "button", "link", "generic", "combobox", "checkbox", "menuitem", "row"];

function heavyWs() {
  const ws = envWs({ env: "preprod", scope: "P2P" });
  // SEL con etichette che compaiono nella pagina (un elemento ogni 7): ruolo dell'elemento (legame) tranne una voce su
  // quattro (ruolo incompatibile: nessun legame); gli altri campi della pagina sono novità
  for (let k = 0; k < NSEL; k++) writeSel(ws, sel(k), { role: k % 4 === 3 ? "dialog" : ROLES[(7 * k) % ROLES.length], label: `Campo ${k * 7}` });
  return ws;
}
const sel = (k) => `C.ACME.P2P.SEL.${String(k + 1).padStart(4, "0")}`;
const tree = () => {
  const lines = Array.from({ length: N }, (_, i) => `  uid=1_${i + 1} ${ROLES[i % ROLES.length]} "Campo ${i}"${i % 5 === 0 ? ` value="v${i}"` : ""}`);
  return `uid=1_0 RootWebArea "ACME" url="${URL0}"\n  uid=1_99999 heading "Richiesta 1" level="1"\n${lines.join("\n")}\n`;
};
const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
let seq = 0;

function inline(ws) {
  const i = { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: DT + "take_snapshot", tool_input: {}, tool_use_id: `toolu_heavy_${++seq}`,
    tool_response: [{ type: "text", text: `# take_snapshot response\n## Latest page snapshot\n${tree()}` }] };
  runHook("browser-origin", i, E(ws));
  return runHook("observe-append", i, E(ws));
}
const B64 = randomBytes(9 * 1024 * 1024).toString("base64");
const thumbs = () => [...Array.from({ length: 400 }, (_, i) => `  uid=1_${200000 + i} image "Miniatura ${i}" url="data:image/png;base64,${B64.slice(i, i + 20480)}"`),
  `  uid=1_200999 image "Anteprima" url="data:image/png;base64,${B64.slice(0, 12 * 1024 * 1024)}"`].join("\n");
function withThumbs(ws) {
  const i = { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: DT + "take_snapshot", tool_input: {}, tool_use_id: `toolu_heavy_${++seq}`,
    tool_response: [{ type: "text", text: `# take_snapshot response\n## Latest page snapshot\n${tree()}${thumbs()}\n` }] };
  runHook("browser-origin", i, E(ws));
  return runHook("observe-append", i, E(ws));
}
function viaFile(ws) {
  const id = `toolu_heavy_${++seq}`;
  const file = join(ws, "customers/ACME/.sessions/sess-1/snapshots", `heavy-${seq}.txt`);
  const ti = { filePath: file };
  runHook("guard-environment", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: DT + "take_snapshot", tool_input: ti, tool_use_id: id }, E(ws));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, tree());
  const i = { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: DT + "take_snapshot", tool_input: ti, tool_use_id: id,
    tool_response: [{ type: "text", text: `# take_snapshot response\nSaved snapshot to ${file}.` }] };
  runHook("browser-origin", i, E(ws));
  return runHook("observe-append", i, E(ws));
}

for (const [name, run] of [["in linea", inline], ["con filePath", viaFile], ["con miniature base64", withThumbs]]) {
  test(`N1: observe-append su una pagina di ${N} elementi con ${NSEL} SEL (${name}) < ${LIMIT} ms, risultato completo`, { concurrency: false, timeout: 300000 }, () => {
    let best = Infinity;
    for (let a = 0; a < ATTEMPTS && best >= LIMIT; a++) {
      const ws = heavyWs();
      const r = run(ws);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!r.json?.systemMessage, `avviso dell'hook: ${r.json?.systemMessage}`);
      const s = readSession(ws).browser.snapshot ?? {};
      assert.equal(s.names?.[`1_${N}`], `Campo ${N - 1}`, "l'ultimo elemento ha il nome nella mappa");
      assert.equal(s.unusable, undefined);
      // legami esatti: l'elemento "Campo 7k" alla voce k, salvo le voci con ruolo incompatibile e i contenitori generic
      // (non sono elementi per il parser)
      const bound = Object.entries(s.refs ?? {}).filter(([, v]) => v);
      const want = Array.from({ length: NSEL }, (_, k) => k).filter((k) => k % 4 !== 3 && ROLES[(7 * k) % ROLES.length] !== "generic").map((k) => [`1_${7 * k + 1}`, sel(k)]);
      assert.deepEqual(bound.sort(), want.sort());
      best = Math.min(best, r.ms);
    }
    console.log(`observe-append ${name} (${N} elementi, ${NSEL} SEL): ${best.toFixed(0)} ms`);
    assert.ok(best < LIMIT, `${best.toFixed(0)} ms`);
  });
}
