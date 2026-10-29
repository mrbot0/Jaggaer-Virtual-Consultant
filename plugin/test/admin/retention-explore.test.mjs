// 29/10/2026 (decisione dell'utente, punto 10 del piano): retention delle pagine catturate in esplorazione
// (customers/<C>/explore/pages/, testo integrale non redatto) — categoria `explore`, default 30 giorni, configurabile in
// config/retention.yaml con minimo 7, per data di modifica; sitemap.json non si cancella: perde solo i riferimenti
// `file` delle pagine rimosse. Cancellazioni vere solo nelle cartelle temporanee del test, tramite lo script del plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, utimesSync } from "node:fs";
import { ws09d, withSession, say, cli } from "../helpers/wp09d.mjs";

const RET = "scripts/admin/retention.mjs";
const DAY = 86400000;
const C = "customers/ACME";
function put(ws, rel, days, text = "x\n") {
  const f = join(ws, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, text);
  const t = new Date(Date.now() - days * DAY);
  utimesSync(f, t, t);
  return f;
}

function exploreWs() {
  const ws = ws09d();
  withSession(ws);
  put(ws, `${C}/explore/pages/home-aaaa1111.txt`, 40, "# Home\nFornitore Rossi S.p.A. IBAN …\n");
  put(ws, `${C}/explore/pages/analytics-bbbb2222.txt`, 5, "# Analytics\n");
  put(ws, `${C}/explore/sitemap.json`, 100, JSON.stringify({ v: 1, pages: {
    "home#1": { url: "https://acme-pre.jaggaer.com/home", title: "Home", file: "pages/home-aaaa1111.txt", first_seen: "2026-09-01T00:00:00Z", visits: 3, headings: [], elements: [["button", "Analytics"]] },
    "analytics#1": { url: "https://acme-pre.jaggaer.com/analytics", title: "Analytics", file: "pages/analytics-bbbb2222.txt", first_seen: "2026-10-20T00:00:00Z", visits: 1, headings: [], elements: [] },
  }, edges: [{ from: "home#1", via: "Analytics", to: "analytics#1", ts: "2026-10-20T00:00:00Z" }], pending: null }));
  return ws;
}

test("retention explore: prova a secco elenca solo le pagine oltre 30 giorni, mai sitemap.json; retention.yaml con minimo 7 giorni", () => {
  const ws = exploreWs();
  const r = cli(RET, ["ACME", "--json"], { ws });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.policy.explore_days, 30);
  assert.deepEqual(r.json.items.map((x) => [x.category, x.path]), [["explore", `${C}/explore/pages/home-aaaa1111.txt`]]);
  assert.ok(existsSync(join(ws, C, "explore/pages/home-aaaa1111.txt")), "la prova a secco non rimuove");
  // configurabile: sotto il minimo vale 7 (la pagina di 5 giorni resta), sopra vale il valore dichiarato
  mkdirSync(join(ws, C, "config"), { recursive: true });
  writeFileSync(join(ws, C, "config/retention.yaml"), "explore_days: 3\n");
  let p = cli(RET, ["ACME", "--json"], { ws });
  assert.equal(p.json.policy.explore_days, 7);
  assert.deepEqual(p.json.items.map((x) => x.path), [`${C}/explore/pages/home-aaaa1111.txt`]);
  writeFileSync(join(ws, C, "config/retention.yaml"), "explore_days: 60\n");
  p = cli(RET, ["ACME", "--json"], { ws });
  assert.equal(p.json.policy.explore_days, 60);
  assert.deepEqual(p.json.items, []);
});

test("retention explore --apply: rimuove la pagina scaduta e il suo riferimento `file` in sitemap.json; la mappa del sito e le pagine recenti restano", () => {
  const ws = exploreWs();
  assert.equal(cli(RET, ["ACME", "--json"], { ws }).status, 0, "deprecazione");
  const tok = say(ws, "APPROVO RETENTION ACME").last.hash.slice(0, 16);
  const r = cli(RET, ["ACME", "--apply", "--approval", tok, "--json"], { ws });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.removed, 1);
  assert.deepEqual(r.json.sitemap, { file: `${C}/explore/sitemap.json`, unlinked: 1 });
  assert.equal(existsSync(join(ws, C, "explore/pages/home-aaaa1111.txt")), false);
  assert.ok(existsSync(join(ws, C, "explore/pages/analytics-bbbb2222.txt")));
  const m = JSON.parse(readFileSync(join(ws, C, "explore/sitemap.json"), "utf8"));
  assert.equal(m.pages["home#1"].file, undefined, "riferimento alla pagina rimossa tolto");
  assert.equal(m.pages["home#1"].url, "https://acme-pre.jaggaer.com/home", "la voce della mappa resta");
  assert.deepEqual(m.pages["home#1"].elements, [["button", "Analytics"]]);
  assert.equal(m.pages["analytics#1"].file, "pages/analytics-bbbb2222.txt");
  assert.equal(m.edges.length, 1);
  const cert = JSON.parse(readFileSync(r.json.certificate, "utf8"));
  assert.deepEqual(cert.removed.map((x) => [x.category, x.path]), [["explore", `${C}/explore/pages/home-aaaa1111.txt`]]);
  assert.ok(cert.never.includes("explore/sitemap.json"));
});
