// 30/10/2026 (blocco dal vivo su AVVA): atlas-build si fermava al primo FLD non valido — il riassunto "Campo <tipo>
// "<etichetta>" del documento <titolo>, osservato in esplorazione." superava le 20 parole di validate-fld (R4) con
// un'etichetta come "End Date for Buyer Replies to Messages Visible to Supplier" e un titolo di pagina lungo — e nessuna
// delle 51 pagine esplorate entrava nella conoscenza. Decisione dell'utente: riassunto entro il limite per costruzione, e
// «quando va in errore non si deve bloccare subito ma deve fare quello che può e tracciare l'errore».
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fldSummary, writeDraft, FLD_SUMMARY_WORDS } from "../../scripts/kb/atlas-write.mjs";
import { atlasBuild } from "../../scripts/kb/atlas-build.mjs";

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
const ws0 = () => { const ws = mkdtempSync(join(tmpdir(), "ab-rob-")); mkdirSync(join(ws, "customers/AVVA"), { recursive: true }); return ws; };
const LONG_LABEL = "End Date for Buyer Replies to Messages Visible to Supplier";
const LONG_TITLE = "Sourcing Event RFQ Configuration Settings And Messaging Options For Buyers And Suppliers";

test("fldSummary: sempre entro 20 parole; il testo pieno quando ci sta", () => {
  assert.equal(fldSummary("text", "Nome", "Ordine"), "Campo text \"Nome\" del documento Ordine, osservato in esplorazione.");
  for (const [l, d] of [[LONG_LABEL, LONG_TITLE], [Array(40).fill("x").join(" "), LONG_TITLE], ["A", Array(40).fill("y").join(" ")]]) {
    const s = fldSummary("date", l, d);
    assert.ok(words(s) <= FLD_SUMMARY_WORDS, `${words(s)}: ${s}`);
  }
});

test("writeDraft tollerante: l'item non valido si scarta con il motivo, gli altri si scrivono; senza tolleranza il primo errore ferma tutto", () => {
  const ws = ws0();
  const items = [{ type: "FLD", label: "Buono", field_type: "text" }, { type: "FLD", label: "Rotto", field_type: "tipo-inesistente" }, { type: "SEL", label: "Salva", role: "button", effect: "write" }];
  const draft = { page: { signature: "rfq/settings#impostazioni", title: "Impostazioni" }, items };
  assert.throws(() => writeDraft({ ws, customer: "AVVA", scope: "SRC", draft }), /field_type non valido/);
  const r = writeDraft({ ws, customer: "AVVA", scope: "SRC", draft, tolerant: true });
  assert.deepEqual(r.written.map((w) => w.label).sort(), ["Buono", "Salva"]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /field_type non valido/);
  assert.equal(r.errors[0].label, "Rotto");
});

test("atlas-build: il campo con etichetta e titolo lunghi entra nella conoscenza; un errore non ferma le altre pagine ed è tracciato", () => {
  const ws = ws0();
  const sid = "s1";
  const dir = join(ws, `customers/AVVA/.sessions/${sid}/atlas`);
  mkdirSync(dir, { recursive: true });
  const page = (sig, title, els) => ({ kind: "page", page_sig: sig, title, url_path: `/${sig.split("#")[0]}`, elements: [{ i: 0, parent: null, role: "heading", name: title, level: 1 }, ...els] });
  const lines = [
    page("rfq/settings#lungo", LONG_TITLE, [{ i: 1, parent: null, role: "textbox", name: LONG_LABEL }]),
    page("rfq/other#altro", "Altro", [{ i: 1, parent: null, role: "textbox", name: "Codice" }, { i: 2, parent: null, role: "button", name: "Salva" }]),
  ];
  writeFileSync(join(dir, "pages.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const r = atlasBuild({ ws, customer: "AVVA", scope: "SRC", sid });
  assert.ok(r.written.some((w) => w.type === "FLD" && w.label === LONG_LABEL), JSON.stringify(r.errors));
  assert.ok(r.written.some((w) => w.type === "FLD" && w.label === "Codice"));
  assert.deepEqual(r.errors, []);
  const code = r.written.find((w) => w.label === LONG_LABEL).code;
  const yaml = readFileSync(join(ws, "customers/AVVA/kb/scopes/SRC/fields", `${code}.yaml`), "utf8");
  assert.match(yaml, /summary:/);
  assert.equal(existsSync(join(dir, "build-errors.jsonl")), false, "nessun errore ⇒ nessun file di traccia");
});
