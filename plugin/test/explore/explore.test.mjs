// 29/10/2026 (punto 4 del piano approvato, «seconda run davvero eseguibile»): scripts/explore/explore.mjs route|status|show
// sulla mappa del sito; in hooks/lib/explore-capture.mjs la storia corta delle letture con hash stabile (uid/ref variabili e
// righe di timestamp tolti), changed rispetto alla lettura precedente e la policy di cattura redatta.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkWs, seedSession, cleanEnv, ROOT } from "../helpers/hook-env.mjs";
import { capturePage, normalizeForHash, pageHash, HISTORY_MAX } from "../../hooks/lib/explore-capture.mjs";
import { parseSnapshot } from "../../scripts/chrome/snapshot-parse.mjs";

const CLI = join(ROOT, "scripts", "explore", "explore.mjs");
function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: cleanEnv(env), timeout: 30000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const H = "https://acme-sbx.jaggaer.com";

// mappa sintetica: Home → (Analytics) → Analytics → (New Report) → Nuovo report; Qualità fornitori orfana e vecchia
function mapWs() {
  const ws = mkWs("jvc-explore-");
  const dir = join(ws, "customers/ACME/explore");
  mkdirSync(join(dir, "pages"), { recursive: true });
  const page = (path, title, headings, elements, extra = {}) => ({ url: `${H}${path}`, title, file: `pages/${path.slice(1).replace(/\W+/g, "-") || "home"}.txt`,
    first_seen: ago(30), last_seen: ago(1), visits: 2, headings, elements, history: [], changed: false, ...extra });
  const m = {
    v: 1,
    pages: {
      "home#cruscotto": page("/home", "Home", ["Cruscotto"], [["button", "Analytics"], ["link", "Fornitori"]], { first_seen: ago(40) }),
      "analytics#analytics": page("/analytics", "Analytics", ["Analytics"], [["button", "New Report"], ["link", "Report salvati"]], { changed: true }),
      "analytics/new#nuovo-report": page("/analytics/new", "Nuovo report", ["Nuovo report"], [["textbox", "Nome del report"], ["button", "Salva"]]),
      "suppliers/quality#qualita-dei-fornitori": page("/suppliers/quality", "Qualità fornitori", ["Qualità dei fornitori"], [["button", "Esporta"]], { last_seen: ago(20) }),
    },
    edges: [
      { from: "home#cruscotto", via: "Analytics", to: "analytics#analytics", ts: ago(2) },
      { from: "analytics#analytics", via: "New Report", to: "analytics/new#nuovo-report", ts: ago(2) },
    ],
    pending: null,
  };
  writeFileSync(join(dir, "sitemap.json"), JSON.stringify(m));
  return ws;
}
const W = (ws) => ["--workspace", ws, "--customer", "ACME", "--json"];

test("explore --help: uso con route, status, show; senza comando o con un comando sconosciuto exit 1", () => {
  const h = cli(["--help"]);
  assert.equal(h.status, 0);
  for (const s of ["route --to", "--from", "status [--stale-days 7]", "show \"<testo>\"", "--customer", "--workspace", "--json", "Exit code"]) assert.ok(h.stdout.includes(s), s);
  assert.equal(cli([]).status, 1);
  const u = cli(["vola", "--json"]);
  assert.equal(u.status, 1);
  assert.match(u.json.error, /comando sconosciuto/);
});

test("route per BFS: dalla partenza (firma, titolo o URL) il percorso più corto di click fino alla pagina obiettivo", () => {
  const ws = mapWs();
  const expected = [
    { da: "home#cruscotto", clicca: "Analytics", arriva: "analytics#analytics" },
    { da: "analytics#analytics", clicca: "New Report", arriva: "analytics/new#nuovo-report" },
  ];
  for (const from of ["home#cruscotto", "Home", `${H}/home`, `${H}/home/?lang=it#top`, "acme-sbx.jaggaer.com/home"]) {
    const r = cli(["route", "--to", "nuovo report", "--from", from, ...W(ws)]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.from.sig, "home#cruscotto", from);
    assert.equal(r.json.from.source, "argomento");
    const c = r.json.candidates[0];
    assert.equal(c.sig, "analytics/new#nuovo-report");
    assert.equal(c.url, `${H}/analytics/new`);
    assert.equal(c.clicks, 2);
    assert.deepEqual(c.path, expected);
    assert.ok(r.json.candidates.length <= 3);
  }
  // l'etichetta di un elemento porta alla pagina che lo contiene: "New Report" sta in Analytics, a un click da Home
  const e = cli(["route", "--to", "New Report", "--from", "home#cruscotto", ...W(ws)]);
  assert.ok(e.json.candidates.some((c) => c.sig === "analytics#analytics" && c.clicks === 1 && c.matched.some((x) => /elemento button "New Report"/.test(x))), JSON.stringify(e.json.candidates));
  // testo per il modello
  const t = cli(["route", "--to", "nuovo report", "--from", "Home", "--workspace", ws, "--customer", "ACME"]);
  assert.equal(t.status, 0);
  assert.match(t.stdout, /percorso \(2 click\): "Analytics" → Analytics · "New Report" → Nuovo report/);
  assert.match(t.stdout, /navigate https:\/\/acme-sbx\.jaggaer\.com\/analytics\/new/);
});

test("route diretta per URL: pagina orfana (nessun percorso di click) trovata senza accenti e maiuscole, con l'URL per navigate", () => {
  const ws = mapWs();
  for (const to of ["qualita fornitori", "QUALITÀ DEI FORNITORI", "fornitore qualità", `${H}/suppliers/quality`]) {
    const r = cli(["route", "--to", to, ...W(ws)]);
    assert.equal(r.status, 0, r.stderr);
    const c = r.json.candidates[0];
    assert.equal(c.sig, "suppliers/quality#qualita-dei-fornitori", to);
    assert.equal(c.url, `${H}/suppliers/quality`);
    assert.equal(c.path, null, "orfana: si raggiunge solo per URL");
    assert.equal(c.clicks, null);
    // partenza nota senza --from né sessione: la prima pagina vista
    assert.deepEqual([r.json.from.sig, r.json.from.source], ["home#cruscotto", "prima-vista"]);
  }
  assert.equal(cli(["route", "--to", `${H}/suppliers/quality`, ...W(ws)]).json.candidates[0].score, 100);
  const none = cli(["route", "--to", "zzzz inesistente", ...W(ws)]);
  assert.equal(none.status, 0);
  assert.deepEqual(none.json.candidates, []);
  // partenza esplicita sconosciuta: avviso, nessun percorso
  const bad = cli(["route", "--to", "nuovo report", "--from", "pagina che non esiste xyz", ...W(ws)]);
  assert.equal(bad.json.from, null);
  assert.match(bad.json.warnings.join(" "), /partenza non trovata/);
  assert.equal(bad.json.candidates[0].path, null);
});

test("route senza --customer né --from: cliente e pagina corrente del browser dalla sessione corrente", () => {
  const ws = mapWs();
  seedSession(ws, { customer: "ACME", scope: "CAT", mode: "esplorazione", extra: { browser: { current_url: `${H}/analytics`, tab: null } } });
  const r = cli(["route", "--to", "nuovo report", "--workspace", ws, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.customer, "ACME");
  assert.deepEqual([r.json.from.sig, r.json.from.source], ["analytics#analytics", "sessione"]);
  assert.deepEqual(r.json.candidates[0].path, [{ da: "analytics#analytics", clicca: "New Report", arriva: "analytics/new#nuovo-report" }]);
  // già sulla pagina obiettivo: 0 click
  assert.equal(cli(["route", "--to", "Analytics", "--workspace", ws, "--json"]).json.candidates[0].clicks, 0);
  // URL corrente con un identificativo nel percorso e una query: la pagina per il percorso della firma
  seedSession(ws, { customer: "ACME", scope: "CAT", mode: "esplorazione", extra: { browser: { current_url: `${H}/analytics/98765?tab=2`, tab: null } } });
  assert.equal(cli(["route", "--to", "nuovo report", "--workspace", ws, "--json"]).json.from.sig, "analytics#analytics");
  // pagina corrente fuori dalla mappa: avviso e partenza dalla prima pagina vista
  seedSession(ws, { customer: "ACME", scope: "CAT", mode: "esplorazione", extra: { browser: { current_url: `${H}/altrove`, tab: null } } });
  const o = cli(["route", "--to", "nuovo report", "--workspace", ws, "--json"]);
  assert.equal(o.json.from.source, "prima-vista");
  assert.match(o.json.warnings.join(" "), /non è nella mappa/);
});

test("status: pagine totali, cambiate all'ultima lettura, vecchie oltre N giorni, orfane", () => {
  const ws = mapWs();
  const r = cli(["status", ...W(ws)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.pages, 4);
  assert.equal(r.json.edges, 2);
  assert.equal(r.json.stale_days, 7);
  assert.deepEqual(r.json.changed.map((x) => x.sig), ["analytics#analytics"]);
  assert.deepEqual(r.json.stale.map((x) => x.sig), ["suppliers/quality#qualita-dei-fornitori"]);
  assert.ok(r.json.stale[0].days >= 19);
  assert.deepEqual(r.json.orphans.map((x) => x.sig), ["home#cruscotto", "suppliers/quality#qualita-dei-fornitori"]);
  assert.equal(r.json.orphans[1].url, `${H}/suppliers/quality`);
  assert.deepEqual(cli(["status", "--stale-days", "30", ...W(ws)]).json.stale, []);
  assert.equal(cli(["status", "--stale-days", "0", ...W(ws)]).json.stale.length, 4);
  assert.equal(cli(["status", "--stale-days", "-1", ...W(ws)]).status, 1);
  const t = cli(["status", "--workspace", ws, "--customer", "ACME"]);
  assert.match(t.stdout, /4 pagine, 2 archi/);
  assert.match(t.stdout, /Orfane \(solo per URL\): 2/);
});

test("show: scheda della pagina con archi in entrata e in uscita e file del testo integrale", () => {
  const ws = mapWs();
  const r = cli(["show", "Analytics", ...W(ws)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.sig, "analytics#analytics");
  assert.equal(r.json.page.url, `${H}/analytics`);
  assert.equal(r.json.page.changed, true);
  assert.deepEqual(r.json.page.elements, [["button", "New Report"], ["link", "Report salvati"]]);
  assert.deepEqual(r.json.incoming.map((e) => [e.from, e.via, e.title]), [["home#cruscotto", "Analytics", "Home"]]);
  assert.deepEqual(r.json.outgoing.map((e) => [e.via, e.to, e.title]), [["New Report", "analytics/new#nuovo-report", "Nuovo report"]]);
  assert.equal(r.json.text_file, "customers/ACME/explore/pages/analytics.txt");
  // per firma, per URL e per ricerca
  assert.equal(cli(["show", "analytics/new#nuovo-report", ...W(ws)]).json.resolved_by, "firma");
  assert.equal(cli(["show", `${H}/suppliers/quality`, ...W(ws)]).json.resolved_by, "url");
  assert.equal(cli(["show", "qualita", ...W(ws)]).json.sig, "suppliers/quality#qualita-dei-fornitori");
  const t = cli(["show", "Analytics", "--workspace", ws, "--customer", "ACME"]);
  assert.match(t.stdout, /Archi in entrata \(1\): "Analytics" da Home \[home#cruscotto\]/);
  assert.match(t.stdout, /Testo integrale: customers\/ACME\/explore\/pages\/analytics\.txt/);
  const n = cli(["show", "zzzz inesistente", ...W(ws)]);
  assert.equal(n.status, 1);
  assert.match(n.json.error, /nessuna pagina/);
});

test("errori d'uso e di sistema: argomenti, cliente, mappa assente o corrotta", () => {
  const ws = mapWs();
  assert.equal(cli(["route", ...W(ws)]).status, 1, "route senza --to");
  assert.equal(cli(["route", "--to", "x", "--from", "--json", "--workspace", ws, "--customer", "ACME"]).status, 1, "--from senza valore");
  assert.equal(cli(["show", ...W(ws)]).status, 1, "show senza testo");
  // bug fixing: nomi di Object.prototype non sono firme; opzioni numeriche senza valore; URL fuori mappa non per somiglianza
  for (const q of ["constructor", "toString", "__proto__"]) assert.equal(cli(["show", q, ...W(ws)]).status, 1, q);
  assert.equal(cli(["route", "--to", "nuovo report", "--from", "valueOf", ...W(ws)]).status, 0);
  assert.equal(cli(["route", "--to", "x", "--json", "--workspace", ws, "--customer", "ACME", "--top"]).status, 1, "--top senza valore");
  assert.equal(cli(["status", "--stale-days", "", ...W(ws)]).status, 1, "--stale-days vuoto");
  const far = cli(["route", "--to", "nuovo report", "--from", "https://altro.example.com/analytics/list", ...W(ws)]);
  assert.equal(far.json.from, null);
  assert.match(far.json.warnings.join(" "), /partenza non trovata/);
  assert.equal(cli(["show", "https://altro.example.com/analytics", ...W(ws)]).status, 1);
  const nc = cli(["status", "--workspace", ws, "--json"]);
  assert.equal(nc.status, 1);
  assert.match(nc.json.error, /--customer/);
  assert.equal(cli(["status", "--workspace", ws, "--customer", "acme", "--json"]).status, 1, "cliente non valido");
  assert.equal(cli(["status", "--workspace", ws, "--json", "--customer"]).status, 1, "--customer senza valore");
  // voci di pagina non valide: ignorate, non un errore di sistema
  const f = join(ws, "customers/ACME/explore/sitemap.json");
  const m = JSON.parse(readFileSync(f, "utf8"));
  m.pages["rotta#x"] = null;
  m.edges.push({ from: 1, to: null });
  writeFileSync(f, JSON.stringify(m));
  const ok = cli(["status", ...W(ws)]);
  assert.equal(ok.status, 0, ok.stdout);
  assert.deepEqual([ok.json.pages, ok.json.edges], [4, 2]);
  const nm = cli(["status", "--workspace", ws, "--customer", "BETA", "--json"]);
  assert.equal(nm.status, 1);
  assert.match(nm.json.error, /nessuna mappa/);
  writeFileSync(join(ws, "customers/ACME/explore/sitemap.json"), "{ rotto");
  const bad = cli(["status", ...W(ws)]);
  assert.equal(bad.status, 2);
  assert.match(bad.json.error, /illeggibile/);
});

// ---- cattura: storia con hash stabile, changed, policy ----

const snap = (p, clock, extra = []) => [
  "# take_snapshot response", "## Latest page snapshot",
  `uid=${p}_0 RootWebArea "Analytics" url="${H}/analytics"`,
  `  uid=${p}_1 heading "Analytics" level="1"`,
  `  uid=${p}_2 button "New Report"`,
  `  uid=${p}_3 link "Report salvati"`,
  `  uid=${p}_4 StaticText "Aggiornato il ${clock}"`,
  ...extra.map((x, i) => `  uid=${p}_${10 + i} ${x}`),
].join("\n");
function read(ws, text, { ts, partial = false, policy, sig = "analytics#analytics", customer = "ACME", url = `${H}/analytics` } = {}) {
  const page = parseSnapshot(text);
  const file = capturePage({ ws, customer, sig, url, title: page.title ?? "Analytics", page, text, partial, ts: ts ?? new Date().toISOString(), policy });
  const m = JSON.parse(readFileSync(join(ws, "customers", customer, "explore/sitemap.json"), "utf8"));
  return { file, m, p: m.pages[sig] };
}

test("storia delle letture: stessa pagina con uid e orologio diversi ⇒ stesso sha256 e changed false; un elemento in più ⇒ changed true", () => {
  const ws = mkWs("jvc-cap-");
  const a = read(ws, snap(1, "29/10/2026 10:23:45"), { ts: "2026-10-29T10:23:45.000Z" });
  assert.equal(a.p.history.length, 1);
  assert.equal(a.p.changed, false, "prima lettura: niente da confrontare");
  assert.match(a.p.history[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(a.p.history[0].elements, 2);
  const b = read(ws, snap(7, "29/10/2026 11:00:02"), { ts: "2026-10-29T11:00:02.000Z" });
  assert.equal(b.p.history.length, 2);
  assert.equal(b.p.history[1].sha256, b.p.history[0].sha256);
  assert.equal(b.p.changed, false);
  assert.equal(b.p.visits, 2);
  const c = read(ws, snap(9, "29/10/2026 12:00:00", ['button "Esporta"']));
  assert.notEqual(c.p.history[2].sha256, c.p.history[1].sha256);
  assert.equal(c.p.changed, true);
  assert.equal(c.p.history[2].elements, c.p.history[1].elements + 1);
  // un pezzo non tocca la storia né changed
  const d = read(ws, snap(11, "29/10/2026 12:05:00"), { partial: true });
  assert.equal(d.p.history.length, 3);
  assert.equal(d.p.changed, true);
  // la stessa pagina riletta: torna changed false; la storia resta corta
  for (let i = 0; i < 12; i++) read(ws, snap(20 + i, `29/10/2026 13:${String(i).padStart(2, "0")}:00`, ['button "Esporta"']));
  const e = read(ws, snap(40, "29/10/2026 14:00:00", ['button "Esporta"']));
  assert.equal(e.p.history.length, HISTORY_MAX);
  assert.equal(e.p.changed, false);
  assert.deepEqual(Object.keys(e.p.history[0]).sort(), ["elements", "sha256", "ts"]);
});

test("hash normalizzato: ref di Claude in Chrome e Playwright, contesto della scheda, righe di timestamp", () => {
  const cl = (r, tab) => `button "New Report" [ref_${r}]\nlink "Report salvati" [ref_${r + 1}]\nViewport: 1280x${700 + r}\nTab Context:\n- Executed on tabId: ${tab}\n- tabId ${tab}: "Analytics" (${H}/analytics)`;
  assert.equal(pageHash(cl(5, 111)), pageHash(cl(42, 999)));
  const pw = (r) => `- Page URL: ${H}/analytics\n- button "New Report" [ref=e${r}] [cursor=pointer]\n- generic [e${r + 1}]: testo`;
  assert.equal(pageHash(pw(12)), pageHash(pw(80)));
  assert.equal(normalizeForHash("riga\n2026-10-29T10:00:00.123+01:00 ultimo accesso\naltra"), "riga\n<ts> ultimo accesso\naltra");
  assert.equal(normalizeForHash("ora 10:23:45\ncontenuto"), "ora <ts>\ncontenuto");
  // bug fixing: il timestamp si neutralizza, il resto della riga resta nel confronto
  assert.notEqual(pageHash('row "Ordine 1 · 29/10/2026 10:00"'), pageHash('row "Ordine 2 · 29/10/2026 10:00"'));
  assert.equal(pageHash('row "Ordine 1 · 29/10/2026 10:00"'), pageHash('row "Ordine 1 · 30/10/2026 11:15:02"'));
  assert.equal(pageHash(`link "Esporta" url="${H}/x?_=1730000000000"`), pageHash(`link "Esporta" url="${H}/x?_=1730000009999"`));
  assert.notEqual(pageHash('StaticText "EAN 1712345678901"'), pageHash('StaticText "EAN 1712345678902"'), "13 cifre fuori da un parametro");
  assert.notEqual(pageHash(`  uid=1_2 link "A" url="${H}/p?uid=42"`), pageHash(`  uid=5_2 link "A" url="${H}/p?uid=43"`), "?uid= di un URL non è un uid");
  // il focus si sposta coi click: non è un cambio della pagina
  assert.equal(pageHash(`${pw(12)}\n- textbox "Cerca" [ref=e7] [active]`), pageHash(`${pw(30)}\n- textbox "Cerca" [ref=e9]`));
  assert.equal(pageHash('uid=1_4 textbox "Cerca" focusable focused'), pageHash('uid=3_4 textbox "Cerca" focusable'));
  assert.notEqual(pageHash(pw(12)), pageHash(`${pw(12)}\n- button "Esporta" [ref=e99]`));
});

test("policy di cattura: redatto ⇒ testo, titolo, intestazioni, elementi e URL della mappa redatti; default integrale; stesso hash", () => {
  const ws = mkWs("jvc-pol-");
  const text = [
    "# take_snapshot response", "## Latest page snapshot",
    `uid=1_0 RootWebArea "Contatto mario.rossi@acme.it" url="${H}/contacts?user=mario.rossi@acme.it"`,
    `  uid=1_1 heading "Referente mario.rossi@acme.it" level="1"`,
    `  uid=1_2 link "mario.rossi@acme.it"`,
    `  uid=1_3 StaticText "IBAN IT60X0542811101000000123456"`,
  ].join("\n");
  const url = `${H}/contacts?user=mario.rossi@acme.it`;
  const title = "Contatto mario.rossi@acme.it";
  const pageOf = () => parseSnapshot(text);
  // default integrale (policy assente)
  const f1 = capturePage({ ws, customer: "ACME", sig: "contacts#referente", url, title, page: pageOf(), text, ts: "2026-10-29T10:00:00.000Z" });
  const integral = readFileSync(join(ws, "customers/ACME", f1), "utf8");
  assert.match(integral, /mario\.rossi@acme\.it/);
  assert.match(integral, /IT60X0542811101000000123456/);
  // redatto
  const f2 = capturePage({ ws, customer: "BETA", sig: "contacts#referente", url, title, page: pageOf(), text, ts: "2026-10-29T10:00:00.000Z",
    policy: { explore_capture: "redatto", profile: "standard" } });
  const red = readFileSync(join(ws, "customers/BETA", f2), "utf8");
  assert.doesNotMatch(red, /mario\.rossi|IT60X0542811101000000123456/);
  assert.match(red, /\[email\]/);
  assert.match(red, /\[iban\]/);
  const mA = JSON.parse(readFileSync(join(ws, "customers/ACME/explore/sitemap.json"), "utf8")).pages["contacts#referente"];
  const mB = JSON.parse(readFileSync(join(ws, "customers/BETA/explore/sitemap.json"), "utf8")).pages["contacts#referente"];
  assert.equal(mA.url, url);
  assert.equal(mB.url, `${H}/contacts`, "redatto: origine + percorso, senza query");
  assert.ok(mA.elements.some(([, n]) => n === "mario.rossi@acme.it"));
  assert.doesNotMatch(JSON.stringify(mB), /mario\.rossi/);
  assert.ok(mB.elements.some(([r, n]) => r === "link" && n === "[email]"));
  assert.equal(mB.history[0].sha256, mA.history[0].sha256, "l'hash è del testo letto, non di quello salvato");
  // un pezzo redatto si aggiunge redatto
  capturePage({ ws, customer: "BETA", sig: "contacts#referente", url, title, page: pageOf(), text: "altro mario.rossi@acme.it", partial: true, ts: "2026-10-29T10:01:00.000Z",
    policy: { explore_capture: "redatto" } });
  assert.doesNotMatch(readFileSync(join(ws, "customers/BETA", f2), "utf8"), /mario\.rossi/);
  // un valore di policy sconosciuto resta integrale
  const f3 = capturePage({ ws, customer: "ACME", sig: "contacts#altro", url, title, page: pageOf(), text, ts: "2026-10-29T10:02:00.000Z", policy: { explore_capture: "boh" } });
  assert.match(readFileSync(join(ws, "customers/ACME", f3), "utf8"), /mario\.rossi@acme\.it/);
  assert.equal(readdirSync(join(ws, "customers/BETA/explore/pages")).length, 1);
  // bug fixing: URL senza origine (file:, about:) redatto senza query, mai "null…"
  capturePage({ ws, customer: "BETA", sig: "locale#x", url: "file:///C:/tmp/pagina.html?u=mario.rossi@acme.it", title: "x", page: pageOf(), text, ts: "2026-10-29T10:03:00.000Z",
    policy: { explore_capture: "redatto" } });
  assert.equal(JSON.parse(readFileSync(join(ws, "customers/BETA/explore/sitemap.json"), "utf8")).pages["locale#x"].url, "file:///C:/tmp/pagina.html");
});
