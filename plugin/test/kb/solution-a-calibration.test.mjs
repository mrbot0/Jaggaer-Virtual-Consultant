// Soluzione A — ultimi sviluppi: verifica automatica della mappa (elenco "da fare" per l'agente), campi già memorizzati
// arricchiti da sessioni successive, e i minori della revisione finale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { parseSnapshot } from "../../scripts/chrome/snapshot-parse.mjs";
import { pageRecord, fullWarningOnce } from "../../hooks/lib/atlas-log.mjs";
import { buildDrafts, atlasBuild } from "../../scripts/kb/atlas-build.mjs";
import { writeDraft } from "../../scripts/kb/atlas-write.mjs";
import { composePlan, writePlanFile } from "../../scripts/decide/compose-plan.mjs";

const ENV = { id: "sandbox", type: "sandbox" };
const ws0 = () => { const ws = mkdtempSync(join(tmpdir(), "sa-cal-")); mkdirSync(join(ws, "customers/ACME"), { recursive: true }); return ws; };
const writeLog = (ws, sid, lines) => { mkdirSync(join(ws, `customers/ACME/.sessions/${sid}/atlas`), { recursive: true }); writeFileSync(join(ws, `customers/ACME/.sessions/${sid}/atlas/pages.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`); };
const H1 = (name) => ({ i: 0, parent: null, role: "heading", name, level: 1 });

test("verifica automatica: atlas-build restituisce l'elenco 'da fare' (tendine da aprire, campi senza etichetta, etichette ripetute, pagine senza percorso, iframe, modulo senza salvataggio, etichette oscurate)", () => {
  const ws = ws0();
  const home = { kind: "page", page_sig: "home#h", title: "Home", url_path: "/home", elements: [H1("Home"), { i: 1, parent: null, role: "link", name: "Ordini" }] };
  const form = { kind: "page", page_sig: "p2p/po/new#nuovo-ordine", title: "Nuovo ordine", url_path: "/p2p/po/new", iframes: 1, elements: [H1("Nuovo ordine"),
    { i: 1, parent: null, role: "combobox", name: "Divisa" }, { i: 2, parent: null, role: "textbox", name: "" },
    { i: 3, parent: null, role: "textbox", name: "Note" }, { i: 4, parent: null, role: "textbox", name: "Note" },
    { i: 5, parent: null, role: "link", name: "Scrivi a [email]" }] };
  const other = { kind: "page", page_sig: "adm/x#altro", title: "Altro", url_path: "/adm/x", elements: [H1("Altro")] };
  writeLog(ws, "s1", [home, { kind: "click", from_sig: "home#h", target: { name: "Ordini" } }, form, other]);
  const r = atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "s1" });
  const kinds = (k) => r.todo.filter((t) => t.kind === k);
  assert.ok(kinds("open-dropdown").some((t) => t.what === "Divisa"), JSON.stringify(r.todo));
  assert.ok(kinds("unlabeled").some((t) => t.page === "Nuovo ordine"));
  assert.ok(kinds("ambiguous").some((t) => t.what === "Note"));
  assert.ok(kinds("no-route").some((t) => t.page === "Altro"));
  assert.ok(kinds("iframe").some((t) => t.page === "Nuovo ordine"));
  assert.ok(kinds("no-save").some((t) => t.page === "Nuovo ordine"));
  assert.ok(kinds("redacted").some((t) => t.page === "Nuovo ordine"));
  assert.ok(r.todo.every((t) => typeof t.action === "string" && t.action.length > 10), "ogni voce dice all'agente cosa fare");
});

test("pageRecord conta gli iframe senza contenuto", () => {
  const snap = `uid=1_0 RootWebArea "X" url="https://h/x"\n  uid=1_1 heading "X" level="1"\n  uid=1_2 Iframe "Frame"\n`;
  assert.equal(pageRecord(parseSnapshot(snap), { pageSig: "x", profile: "standard", env: {} }).iframes, 1);
});

test("un campo già memorizzato si arricchisce in una sessione successiva (opzioni, obbligo)", () => {
  const ws = ws0();
  const v1 = { kind: "page", page_sig: "p#f", title: "Nuovo ordine", url_path: "/p", elements: [H1("Nuovo ordine"), { i: 1, parent: null, role: "combobox", name: "Divisa" }] };
  writeLog(ws, "s1", [v1]);
  atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "s1" });
  const v2 = { ...v1, elements: [H1("Nuovo ordine"), { i: 1, parent: null, role: "combobox", name: "Divisa", required: true }, { i: 2, parent: 1, role: "option", name: "EUR" }, { i: 3, parent: 1, role: "option", name: "USD" }] };
  writeLog(ws, "s2", [v2]);
  const r = atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "s2" });
  assert.ok(r.updated.length >= 1, JSON.stringify(r));
  const dir = join(ws, "customers/ACME/kb/scopes/P2P/fields");
  const f = readdirSync(dir).map((x) => YAML.parse(readFileSync(join(dir, x), "utf8"))).find((x) => x.label.it === "Divisa");
  assert.equal(f.mandatory.kind, "always");
  assert.match(f.notes, /EUR · USD/);
});

test("minore: tendina con una sola opzione o elenco di persone ⇒ nessun valore memorizzato", () => {
  const els = [H1("Nuovo ordine"), { i: 1, parent: null, role: "combobox", name: "Stato" }, { i: 2, parent: 1, role: "option", name: "Bozza" },
    { i: 3, parent: null, role: "combobox", name: "Richiedente" }, { i: 4, parent: 3, role: "option", name: "Mario Rossi" }, { i: 5, parent: 3, role: "option", name: "Anna Bianchi" }];
  const d = buildDrafts([{ kind: "page", page_sig: "p#f", title: "T", url_path: "/p", elements: els }]);
  assert.equal(d.fields.find((f) => f.label === "Stato").options, undefined);
  assert.equal(d.fields.find((f) => f.label === "Richiedente").options, undefined);
});

function formFor(ws, document) {
  const page = { signature: `p#${document}`, title: document };
  const f = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page, items: [{ type: "FLD", label: "Descrizione", document, section: "T", field_type: "text" }] } });
  writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page, items: [{ type: "SEL", label: "Descrizione", role: "textbox", field: f.written[0]?.code }, { type: "SEL", label: "Salva bozza", role: "button" }] } });
  writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { items: [{ type: "FLW", title: `Percorso: ${document}`, steps: [{ verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: "/p" }, expect: { page_sig: "p" } }] }] } });
}

test("minore: più moduli simili ⇒ preferito il modulo esatto ('nuovo ordine' su 'nuova riga ordine'); due moduli esatti ⇒ ambiguo; 'renew' non è creare", () => {
  let ws = ws0(); formFor(ws, "Nuovo ordine"); formFor(ws, "Nuova riga ordine");
  let r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x" }, planId: "PLAN.ACME.M1.1" });
  assert.ok(r.plan, JSON.stringify(r.gaps));
  ws = ws0(); formFor(ws, "Nuovo ordine"); formFor(ws, "New order");
  r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x" }, planId: "PLAN.ACME.M1.2" });
  assert.ok(r.gaps?.some((g) => g.kind === "ambiguous" && g.what === "modulo"), JSON.stringify(r));
  ws = ws0(); formFor(ws, "Renew order");
  r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x" }, planId: "PLAN.ACME.M1.3" });
  assert.ok(r.gaps?.some((g) => g.kind === "no-form"), JSON.stringify(r));
});

test("minore: un piano esistente non si sovrascrive; l'avviso di registro pieno si dà una volta sola", () => {
  const dir = mkdtempSync(join(tmpdir(), "sa-cal-"));
  const f = join(dir, "runs", "RUN.ACME.20260930.1000.P2P", "plan.json");
  writePlanFile(f, { plan_id: "PLAN.X" });
  assert.throws(() => writePlanFile(f, { plan_id: "PLAN.Y" }), /esiste/);
  assert.match(readFileSync(f, "utf8"), /PLAN\.X/);
  const adir = join(dir, "atlas");
  assert.equal(fullWarningOnce(adir), true);
  assert.equal(fullWarningOnce(adir), false);
  assert.ok(existsSync(join(adir, "full-warned")));
});
