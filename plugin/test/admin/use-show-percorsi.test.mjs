// N4 (verifica del 27/10/2026): con Chrome DevTools lo snapshot su file vuole il percorso ASSOLUTO della cartella snapshots/
// della sessione, sotto la cartella di lavoro di Claude Code (radici MCP di chrome-devtools-mcp), senza giunzioni né nomi
// 8.3. `use show` dà il workspace assoluto (percorso reale) e la cartella degli snapshot; la mappa della pagina (che su
// una pagina pesante pesa megabyte) vi compare solo come riassunto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, readFileSync, writeFileSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { mkWs, seedSession, runSessionCli } from "../helpers/hook-env.mjs";

test("N4: use show dà il workspace assoluto, la cartella snapshots/ della sessione e un riassunto della mappa della pagina", () => {
  const ws = mkWs(); seedSession(ws);
  const f = join(ws, "customers/ACME/.sessions/sess-1/session.json");
  const s = JSON.parse(readFileSync(f, "utf8"));
  const refs = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`1_${i}`, null]));
  s.browser = { current_url: "https://acme-pre.jaggaer.com/x", tab: null, updated_by: "observe-append",
    snapshot: { obs: "L.ACME.P2P.OBS.0001", url: "https://acme-pre.jaggaer.com/x", tab: null, ts: "t", refs, names: Object.fromEntries(Object.keys(refs).map((r) => [r, `Voce ${r}`])), family: "chrome-devtools", sig: "x" } };
  writeFileSync(f, JSON.stringify(s));
  const r = runSessionCli(["use", "show", "--session", "sess-1", "--workspace", ws, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const real = realpathSync.native(ws);
  assert.equal(r.json.workspace, real);
  assert.ok(isAbsolute(r.json.snapshots_dir));
  assert.equal(r.json.snapshots_dir, join(real, "customers", "ACME", ".sessions", "sess-1", "snapshots"));
  const snap = r.json.session.browser.snapshot;
  assert.equal(snap.refs_count, 3000);
  assert.equal(snap.names_count, 3000);
  assert.equal(snap.refs, undefined, "niente mappa intera nell'uscita");
  assert.equal(snap.url, "https://acme-pre.jaggaer.com/x");
  assert.ok(r.stdout.length < 20000, `uscita troppo lunga: ${r.stdout.length}`);
  // il file di stato non cambia
  assert.equal(Object.keys(JSON.parse(readFileSync(f, "utf8")).browser.snapshot.refs).length, 3000);
  const text = runSessionCli(["use", "show", "--session", "sess-1", "--workspace", ws]);
  assert.ok(text.stdout.includes(join(real, "customers", "ACME", ".sessions", "sess-1", "snapshots")), text.stdout);
});

test("N4: use show risolve il workspace al percorso reale (collegamento alla cartella ⇒ la cartella vera)", (t) => {
  const ws = mkWs(); seedSession(ws);
  const link = join(mkdtempSync(join(tmpdir(), "jvc-link-")), "ws-link");
  try { symlinkSync(ws, link, "junction"); } catch { t.skip("collegamenti non disponibili"); return; }
  const r = runSessionCli(["use", "show", "--session", "sess-1", "--workspace", link, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.workspace, realpathSync.native(ws));
  assert.ok(r.json.snapshots_dir.startsWith(realpathSync.native(ws)), r.json.snapshots_dir);
});
