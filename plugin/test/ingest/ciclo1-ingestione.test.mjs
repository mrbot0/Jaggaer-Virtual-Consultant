// 18/11/2026 (ciclo di bug fixing, ingestione T0 e ponte verso T1): difetti trovati eseguendo la pipeline sulle copie dei
// dati reali di ENEL (451 file, 248 documenti; 12 ore di ingest, 55 documenti con i grezzi sovrascritti, candidati di
// documento che il ponte T0 → T1 rifiutava). Ogni test riproduce il difetto con dati sintetici.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { makeUnitRedactor } from "../../scripts/ingest/redact.mjs";
import { ingestFolder } from "../../scripts/ingest/ingest.mjs";
import { harvest } from "../../scripts/ingest/harvest.mjs";
import { segmentUnits } from "../../scripts/ingest/segment.mjs";
import { extractDocument, carryOverT1 } from "../../scripts/ingest/extract.mjs";
import { newDoc, newSection, finishDoc } from "../../scripts/ingest/lib/parsed.mjs";
import { validateWith } from "../../scripts/lib/schemas.mjs";
import { parseEmail, htmlToText, HTML_MAX } from "../../scripts/ingest/parse-email.mjs";
import { assignDocCode } from "../../scripts/ingest/profile-doc.mjs";
import { openDb } from "../../scripts/kb/db.mjs";
import { status, next, applyCompletions, ready, mark } from "../../scripts/ingest/complete.mjs";

const FIX = new URL("../fixtures/docs/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const LVL = { customer: "ENEL", scope: "XSC" };
const rawDir = (ws) => join(ws, "customers", "ENEL", "_inbox", "XSC", "raw");
const rawItems = (ws) => readdirSync(rawDir(ws)).flatMap((f) => YAML.parse(readFileSync(join(rawDir(ws), f), "utf8"), { maxAliasCount: 100000 }).items);

// Bug 1 — redact.mjs: redactText rileggeva process.env a ogni stringa (su Windows ogni accesso è una chiamata al sistema):
// un xlsx di 330k celle costava 6 minuti di harvest, la pipeline su ENEL 12 ore.
test("redattore delle unità: le variabili d'ambiente si leggono una volta per redattore, non a ogni stringa; i segreti restano mascherati", () => {
  let reads = 0;
  const env = new Proxy({ NRT_TOKEN: "segreto-di-prova-123", PATH: "/usr/bin" }, { ownKeys(t) { reads++; return Reflect.ownKeys(t); } });
  const red = makeUnitRedactor({ profile: "standard", names: [], env });
  const before = reads;
  const rows = Array.from({ length: 2000 }, (_, i) => [`riga ${i}`, `valore ${i}`, i === 7 ? "token segreto-di-prova-123" : "x"]);
  const out = red({ table: { headers: ["a", "b", "c"], rows } });
  assert.equal(reads - before, 0, `process.env letto ${reads - before} volte per 6000 celle`);
  assert.equal(out.unit.table.rows[7][2], "token [segreto]");
  assert.ok(out.masks.includes("env"));
});

// Bug 2 — complete.mjs: i candidati di documento (R.DOCnnnn.C001 / F001 / I001, needs_llm) e le unità oltre la 9999 erano
// rifiutati da apply e mark («raw_id non valido»): restavano «da completare» per sempre.
test("ponte T0 → T1 sui grezzi veri di T0: i candidati di documento (CFG da export, FLW da workflow, INT da spec) si completano e si segnano digeriti", () => {
  const ws = tmp("c1-cand-");
  const r = ingestFolder(FIX, { root: ws, customer: "ENEL", scope: "XSC", today: "2026-11-18" });
  assert.equal(r.documents.errors, 0, JSON.stringify(r.errors));
  const cands = rawItems(ws).filter((it) => /^R\.DOC\d{4}\.[A-Z]\d{3}$/.test(it.raw_id));
  assert.ok(cands.length >= 3, `candidati di documento: ${cands.length}`);
  assert.ok(cands.every((c) => c.needs_llm === true));
  const kinds = new Set(cands.map((c) => c.raw_id.split(".").at(-1)[0]));
  for (const k of ["C", "F", "I"]) assert.ok(kinds.has(k), `candidato ${k}`);
  const pick = ["C", "F", "I"].map((k) => cands.find((c) => c.raw_id.split(".").at(-1)[0] === k));
  const res = applyCompletions(ws, LVL, pick.map((c, i) => (i === 0
    ? { raw_id: c.raw_id, fields: Object.fromEntries(c.missing.map((m) => [m, `valore ${m}`])) }
    : { raw_id: c.raw_id, unresolved: "il documento non lo dice" })));
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.applied.map((a) => a.status), ["completed", "unresolved", "unresolved"]);
  assert.ok(ready(ws, LVL, { max: 10000 }).items.some((x) => x.raw_id === pick[0].raw_id), "il candidato completato entra nella coda del digester");
  assert.deepEqual(mark(ws, LVL, pick[0].raw_id, "C.ENEL.XSC.CFG.0001"), { raw_id: pick[0].raw_id, digested_as: "C.ENEL.XSC.CFG.0001" });
  assert.equal(status(ws, LVL).totale.digerito, 1);
});

test("ponte T0 → T1: unità oltre la 9999 (U.DOCnnnn.10000) accettate in raw_id e citazione", () => {
  const ws = tmp("c1-big-");
  mkdirSync(rawDir(ws), { recursive: true });
  const u = join(ws, "customers", "ENEL", "sources", "units", "DOC0002");
  mkdirSync(u, { recursive: true });
  writeFileSync(join(u, "U.DOC0002.10000.yaml"), YAML.stringify({ id: "U.DOC0002.10000", text: "Il campo Fornitore è obbligatorio.", context: { section: "Campi" } }));
  writeFileSync(join(rawDir(ws), "DOC0002.yaml"), YAML.stringify({ doc: "C.ENEL.XSC.DOC.0002", items: [{ raw_id: "R.DOC0002.10000", source_unit: "U.DOC0002.10000", unit_type: "regola", extraction: { subject: null }, needs_llm: true, missing: ["subject"] }] }));
  assert.equal(next(ws, LVL).batch[0].unit.text, "Il campo Fornitore è obbligatorio.");
  const r = applyCompletions(ws, LVL, [{ raw_id: "R.DOC0002.10000", fields: { subject: "Fornitore" }, citation: { unit: "U.DOC0002.10000", section: "Campi" } }]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.applied[0].status, "completed");
});

// Bug 3 — profile-doc.assignDocCode: doc_key dal solo nome del file ⇒ stesso nome in cartelle diverse = versioni dello
// stesso documento; raw/DOCnnnn.yaml della prima sovrascritto (su ENEL 55 documenti su 248 senza grezzi).
test("stesso nome di file in cartelle diverse: documenti diversi, ognuno con i suoi grezzi; nella stessa cartella resta una versione", () => {
  const src = tmp("c1-src-");
  const ws = tmp("c1-ws-");
  const put = (rel, body) => { mkdirSync(join(src, rel, ".."), { recursive: true }); writeFileSync(join(src, rel), body); };
  put("MATRICE/AWARDING/BACKUP/20-09-22.txt", "Matrice di awarding\n\nIl campo Importo aggiudicato è obbligatorio.\n");
  put("MATRICE/STRATEGY/BACKUP/20-09-22.txt", "Matrice di strategia\n\nIl campo Strategia di gara è obbligatorio.\n");
  put("app/MANUTENZIONE/LEGGIMI.txt", "Manutenzione\n\nIl campo Data di manutenzione è obbligatorio.\n");
  const a = ingestFolder(src, { root: ws, customer: "ENEL", scope: "XSC", today: "2026-11-18" });
  assert.equal(a.documents.errors, 0, JSON.stringify(a.errors));
  const codes = a.docs.map((d) => d.code);
  assert.equal(new Set(codes).size, 3, codes.join(" "));
  assert.ok(codes.every((c) => !/\.v\d+$/.test(c)), `nessuna versione: ${codes.join(" ")}`);
  assert.equal(readdirSync(rawDir(ws)).length, 3, "un file di grezzi per documento");
  assert.ok(a.docs.every((d) => d.diff === null), "nessun doc-diff fra documenti estranei");
  // stessa cartella, contenuto cambiato ⇒ nuova versione; la stessa cartella ingerita da un'altra radice ⇒ ancora versione
  writeFileSync(join(src, "MATRICE/AWARDING/BACKUP/20-09-22.txt"), "Matrice di awarding\n\nIl campo Importo aggiudicato è obbligatorio.\n\nNuova riga.\n");
  const b = ingestFolder(src, { root: ws, customer: "ENEL", scope: "XSC", today: "2026-11-19" });
  const aw = (r) => r.docs.find((d) => /AWARDING/.test(d.source)).code;
  assert.equal(aw(b), `${aw(a)}.v2`);
  writeFileSync(join(src, "app/MANUTENZIONE/LEGGIMI.txt"), "Manutenzione\n\nIl campo Data di manutenzione è obbligatorio.\n\nAltra riga.\n");
  const c = ingestFolder(join(src, "app"), { root: ws, customer: "ENEL", scope: "XSC", today: "2026-11-20" });
  assert.equal(c.docs.find((d) => /LEGGIMI/.test(d.source)).code, `${a.docs.find((d) => /LEGGIMI/.test(d.source)).code}.v2`);
  // un nuovo LEGGIMI in un'altra cartella resta un documento nuovo anche con le versioni già registrate
  put("app/MIGRAZIONE/LEGGIMI.txt", "Migrazione\n\nIl campo Lotto è obbligatorio.\n");
  const d = ingestFolder(src, { root: ws, customer: "ENEL", scope: "XSC", today: "2026-11-21" });
  const mig = d.docs.find((x) => /MIGRAZIONE/.test(x.source)).code;
  assert.ok(!/\.v\d+$/.test(mig) && !codes.includes(mig), mig);
});

test("assignDocCode su un workspace già ingerito (versioni di cartelle diverse sotto lo stesso DOC): la nuova versione non riprende il codice di un altro documento", () => {
  const db = openDb(":memory:");
  const rec = (code, source, sha) => db.prepare("insert into doc_profiles(code, doc_key, doc_id, source, sha256, reliability, profiled_at) values (?,?,?,?,?,0.5,?)").run(code, "02-09-22.xlsx", code, source, sha, `2026-11-17T00:00:0${code.length % 10}Z`);
  rec("C.ENEL.XSC.DOC.0040", "PREP/ALBERO/BACKUP/02.09.22.xlsx", "sha256:a");
  rec("C.ENEL.XSC.DOC.0040.v2", "PREP/MATRICE/AWARDING/BACKUP/02.09.22.xlsx", "sha256:b");
  rec("C.ENEL.XSC.DOC.0040.v3", "PREP/MATRICE/STRATEGY/BACKUP/02.09.22.xlsx", "sha256:c");
  const a = assignDocCode(db, { level: "C", customer: "ENEL", source: "PREP/MATRICE/AWARDING/BACKUP/02.09.22.xlsx", sha256: "sha256:b2", key: "02-09-22.xlsx", dir: "PREP/MATRICE/AWARDING/BACKUP" });
  assert.equal(a.code, "C.ENEL.XSC.DOC.0040.v4");
  assert.equal(a.previous, "C.ENEL.XSC.DOC.0040.v2");
  const b = assignDocCode(db, { level: "C", customer: "ENEL", source: "PROD/MATRICE/CONTRATTI/BACKUP/02.09.22.xlsx", sha256: "sha256:d", key: "02-09-22.xlsx", dir: "PROD/MATRICE/CONTRATTI/BACKUP" });
  assert.ok(!/^C\.ENEL\.XSC\.DOC\.0040/.test(b.code) && b.version === 1, b.code);
  db.close();
});

// Bug 4 — harvest.mjs: readFileSync fuori da ogni try ⇒ un file illeggibile (o sparito durante la lettura, o oltre 2 GB)
// fermava l'intera cartella con exit 2; ora è un residuo tracciato e gli altri file proseguono.
test("harvest: file sparito durante la lettura, sottocartella illeggibile e file oltre il tetto ⇒ residui tracciati, la cartella prosegue", () => {
  const src = tmp("c1-harv-");
  const ws = tmp("c1-harv-ws-");
  writeFileSync(join(src, "a.txt"), "Primo documento\n\nIl campo Fornitore è obbligatorio.\n");
  writeFileSync(join(src, "b.txt"), "Secondo documento, cancellato durante la harvest.\n");
  writeFileSync(join(src, "c.txt"), "Terzo documento\n\nIl campo Contratto è obbligatorio.\n");
  writeFileSync(join(src, "grande.txt"), "x".repeat(5000));
  mkdirSync(join(src, "z"));
  writeFileSync(join(src, "z", "d.txt"), "Dentro una cartella che sparisce.\n");
  const r = harvest(src, { root: ws, customer: "ENEL", scope: "XSC", maxFileBytes: 4096, onFile: (e) => { if (e.path === "a.txt") { rmSync(join(src, "b.txt")); rmSync(join(src, "z"), { recursive: true }); } } });
  const by = Object.fromEntries(r.manifest.map((m) => [m.path, m]));
  assert.equal(by["a.txt"].status, "parsed");
  assert.equal(by["c.txt"].status, "parsed", "il file dopo quello illeggibile è letto");
  assert.equal(by["b.txt"].status, "residue");
  assert.equal(by["b.txt"].residue.class, "deferred");
  assert.match(by["b.txt"].residue.reason, /file illeggibile \(ENOENT\)/);
  assert.equal(by["grande.txt"].residue.class, "unsupported");
  assert.match(by["grande.txt"].residue.reason, /oltre il limite/);
  assert.equal(by["z/"].residue.class, "deferred");
  assert.match(by["z/"].residue.reason, /cartella illeggibile/);
  const man = JSON.parse(readFileSync(join(ws, "customers", "ENEL", "_inbox", "XSC", "parsed", "_manifest.json"), "utf8"));
  assert.equal(man.files.length, 5);
  const res = YAML.parse(readFileSync(join(ws, "customers", "ENEL", "_inbox", "XSC", "residue", "_harvest.yaml"), "utf8"));
  assert.equal(res.summary.total, 3);
});

// Bug 4b — ingest.mjs: tutti i documenti normalizzati restavano in memoria fino alla fine della harvest (ENEL: 855 MB di
// JSON, oltre 2 GB di heap a metà harvest; una cartella più grande finiva in «heap out of memory» senza riepilogo). Ora ogni
// documento passa alla pipeline appena letto: lo prova l'ordine (il documento A è già profilato prima che B sia letto).
test("ingest in flusso: ogni documento è elaborato appena letto, prima del file successivo; riepilogo e manifesto completi", () => {
  const src = tmp("c1-flow-");
  const ws = tmp("c1-flow-ws-");
  writeFileSync(join(src, "a.txt"), "Primo\n\nIl campo Fornitore è obbligatorio.\n");
  writeFileSync(join(src, "b.txt"), "Secondo\n\nIl campo Contratto è obbligatorio.\n");
  writeFileSync(join(src, "c.txt"), "Terzo\n\nIl campo Lotto è obbligatorio.\n");
  const seen = [];
  const r = ingestFolder(src, { root: ws, customer: "ENEL", scope: "XSC", today: "2026-11-18", onDoc: (d) => { seen.push(d.source); if (d.source === "a.txt") rmSync(join(src, "b.txt")); } });
  assert.deepEqual(seen, ["a.txt", "c.txt"]);
  assert.equal(r.files.total, 3);
  assert.equal(r.documents.profiled, 2);
  assert.equal(r.files.residue, 1, "b.txt sparito dopo l'elaborazione di a.txt: residuo tracciato");
  assert.equal(r.documents.errors, 0);
});

// Bug 5 — extract.writeRaw: la re-ingestion riscriveva raw/DOCnnnn.yaml da T0 e cancellava completamenti, irrisolti e
// digested_as: il lavoro dello scope-extractor e del digester tornava «da completare» e i digeriti rientravano fra i pronti.
test("re-ingestion: i grezzi conservano completamenti, irrisolti e digested_as di T1; llm_plan non ripropone i completati", () => {
  const src = tmp("c1-re-src-");
  for (const f of ["workflow_definition_demo.xml", "notes.txt", "sample.docx"]) cpSync(join(FIX, f), join(src, f));
  const ws = tmp("c1-re-ws-");
  const a = ingestFolder(src, { root: ws, customer: "ENEL", scope: "XSC", today: "2026-11-18" });
  assert.equal(a.documents.errors, 0, JSON.stringify(a.errors));
  const todo = rawItems(ws).filter((it) => it.needs_llm);
  assert.ok(todo.length >= 3, `da completare: ${todo.length}`);
  const [x, y, z] = todo;
  const res = applyCompletions(ws, LVL, [
    { raw_id: x.raw_id, fields: Object.fromEntries(x.missing.map((m) => [m, `valore ${m}`])) },
    { raw_id: y.raw_id, unresolved: "il documento non lo dice" },
    { raw_id: z.raw_id, fields: Object.fromEntries(z.missing.map((m) => [m, `valore ${m}`])) },
  ]);
  assert.deepEqual(res.errors, []);
  mark(ws, LVL, z.raw_id, "C.ENEL.XSC.FLW.0001");
  const before = status(ws, LVL).totale;
  const b = ingestFolder(src, { root: ws, customer: "ENEL", scope: "XSC", today: "2026-11-19" });
  assert.equal(b.documents.errors, 0);
  assert.ok(b.docs.reduce((n, d) => n + d.t1_carried, 0) >= 3);
  assert.deepEqual(status(ws, LVL).totale, before, "avanzamento di T1 invariato dopo la re-ingestion");
  const after = new Map(rawItems(ws).map((it) => [it.raw_id, it]));
  assert.equal(after.get(x.raw_id).t1.status, "completed");
  assert.equal(after.get(x.raw_id).extraction[x.missing[0]], `valore ${x.missing[0]}`);
  assert.equal(after.get(y.raw_id).t1.status, "unresolved");
  assert.equal(after.get(z.raw_id).digested_as, "C.ENEL.XSC.FLW.0001");
  assert.ok(!ready(ws, LVL, { max: 10000 }).items.some((i) => i.raw_id === z.raw_id), "il digerito non torna fra i pronti");
  const raw = readdirSync(rawDir(ws)).map((f) => YAML.parse(readFileSync(join(rawDir(ws), f), "utf8"), { maxAliasCount: 100000 }));
  const planned = new Set(raw.flatMap((r) => r.llm_plan.sessions.flatMap((s) => s.batch_items.flat())));
  for (const id of [x.raw_id, y.raw_id, z.raw_id]) assert.ok(!planned.has(id), `${id} non più nel piano dell'estrattore`);
  for (const r of raw) assert.equal(r.stats.needs_llm, r.items.filter((i) => i.needs_llm).length, `${r.doc}: stats.needs_llm coerente`);
});

test("carryOverT1: completamento manuale di prima del ponte (completion) conservato; estrazione T0 cambiata ⇒ si riparte da T0", () => {
  const t0 = { raw_id: "R.DOC0043.0005", source_unit: "U.DOC0043.0005", extraction: { subject: null, modality: "obbligo" }, needs_llm: true, missing: ["subject"] };
  const legacy = { ...t0, extraction: { subject: "richiesta al Team Tecnico", modality: "obbligo" }, needs_llm: false, missing: [], completion: { citation: "U.DOC0043.0005" } };
  const a = carryOverT1([legacy], [t0]);
  assert.equal(a.carried, 1);
  assert.deepEqual([a.items[0].needs_llm, a.items[0].extraction.subject, !!a.items[0].completion], [false, "richiesta al Team Tecnico", true]);
  const changed = { ...t0, extraction: { subject: null, modality: "divieto" } };
  const b = carryOverT1([legacy], [changed]);
  assert.equal(b.carried, 0);
  assert.equal(b.items[0].needs_llm, true);
});

// Bug 6 — segment.segmentUnits: ogni parte di un'unità oltre 300 parole portava la copia intera del contenuto strutturato
// (righe del blocco di tabella): su ENEL un xlsx di 580 KB ⇒ 834 parti da 160 KB (129 MB), 3 minuti a documento; e
// procedure/righe di campi spezzate davano un grezzo duplicato per parte.
test("unità spezzate: le righe del blocco solo nella prima parte, nessun grezzo duplicato per le parti di una procedura o di una riga di campi; codici stabili", () => {
  const cols = Array.from({ length: 150 }, (_, i) => `Colonna${i}`);
  const doc = finishDoc({ ...newDoc({ id: "largo", title: "Largo", format: "xlsx", parser: "parse-xlsx" }), sections: [
    { ...newSection({ path: "sheet-1", title: "Dati" }), tables: [{ headers: cols, rows: Array.from({ length: 30 }, (_, r) => cols.map((_, c) => `v${r}x${c}`)) }] },
    { ...newSection({ path: "2", title: "Campi" }), tables: [{ headers: ["Campo", "Tipo", "Obbligatorio", "Note"], rows: [["Fornitore", "testo", "Sì", Array.from({ length: 80 }, (_, i) => `Nota lunga numero ${i} sul fornitore.`).join(" ")]] }] },
    { ...newSection({ path: "3", title: "Procedura" }), paragraphs: Array.from({ length: 6 }, (_, i) => `${i + 1}. Selezionare ${Array.from({ length: 70 }, (_, k) => `parola${k}`).join(" ")} e confermare.`) },
  ] });
  const { units } = segmentUnits(doc, { docCode: "C.ENEL.XSC.DOC.0009" });
  const tab = units.filter((u) => u.type === "tabella");
  assert.ok(tab.length > 10, `parti della tabella: ${tab.length}`);
  assert.equal(tab.filter((u) => u.table.rows.length).length, 1, "le righe solo nella prima parte");
  assert.ok(tab.slice(1).every((u) => u.table.continued === true && u.part.n > 1));
  const size = JSON.stringify(units).length;
  assert.ok(size < 6 * JSON.stringify(doc).length, `unità ${size} byte per un documento di ${JSON.stringify(doc).length}`);
  for (const u of units) assert.ok(validateWith("unit.schema.json", u).ok, `${u.id}: ${validateWith("unit.schema.json", u).errors}`);
  const { items } = extractDocument(doc, units, {});
  const bySrc = (t) => items.filter((i) => i.unit_type === t);
  assert.ok(units.filter((u) => u.type === "riga-tabella-campi").length > 1, "riga di campi spezzata in parti");
  assert.equal(bySrc("riga-tabella-campi").length, 1, "un solo grezzo FLD per la riga");
  assert.ok(units.filter((u) => u.type === "procedura").length > 1, "procedura spezzata in parti");
  assert.equal(bySrc("procedura").length, 1, "un solo grezzo FLW per la procedura");
  // stessi testi ⇒ stessi codici alla re-segmentazione
  const again = segmentUnits(doc, { docCode: "C.ENEL.XSC.DOC.0009", previous: units.map((u) => ({ id: u.id, hash: u.hash })) }).units;
  assert.deepEqual(again.map((u) => u.id), units.map((u) => u.id));
});

// Bug 7 — parse-email.mjs sugli .eml salvati da Outlook/Exchange: intestazioni Received/ARC/msip_labels prima di From (oltre
// i 3000 caratteri guardati) ⇒ residuo «intestazioni assenti» (3 file su 5 reali); negli altri intestazioni come testo,
// quoted-printable non decodificato (indirizzi spezzati da "=\n" sfuggiti alla redazione), multipart annidato senza testo.
// Dati SINTETICI con la struttura di un messaggio Outlook.
test("e-mail Outlook: intestazioni lunghe, multipart annidato, quoted-printable e charset ⇒ thread in messaggi puliti, indirizzi redatti per intero", () => {
  const received = Array.from({ length: 40 }, (_, i) => `Received: from SRV${i}.eurprd09.prod.outlook.com (2603:10a6:102:455::${i})\r\n by MBX${i}.eurprd09.prod.outlook.com with HTTPS; Thu, 29 Oct 2026 09:47:0${i % 10} +0000`).join("\r\n");
  const plain = "Ciao Lorenzo,=0D=0Aconfermo che il campo Centro di costo =E8 obbligatorio.=0D=0AScrivete a mario.ro=\r\nssi@example.invalid per dubbi.=0D=0A=0D=0ADa: Lorenzo Verdi <lorenzo@example.invalid>=0D=0AInviato: luned=EC 26 ottobre 2026 10:33=0D=0AA: Giulio <giulio@example.invalid>=0D=0AOggetto: Centro di costo=0D=0A=0D=0ABuongiorno, il campo Centro di costo va reso obbligatorio?=0D=0A";
  const eml = [received,
    "msip_labels: MSIP_Label_0000_Enabled=True;MSIP_Label_0000_SiteId=x",
    "From: =?iso-8859-1?Q?Giulio_Bianch=EC?= <giulio@example.invalid>",
    "To: Lorenzo Verdi <lorenzo@example.invalid>",
    "Subject: =?utf-8?B?UjogQ2VudHJvIGRpIGNvc3Rv?=",
    "Date: Thu, 29 Oct 2026 09:46:53 +0000",
    "Content-Type: multipart/related;\r\n\tboundary=\"_rel_\";\r\n\ttype=\"multipart/alternative\"",
    "MIME-Version: 1.0", "",
    "--_rel_", "Content-Type: multipart/alternative;\r\n\tboundary=\"_alt_\"", "",
    "--_alt_", "Content-Type: text/plain; charset=\"iso-8859-1\"", "Content-Transfer-Encoding: quoted-printable", "", plain,
    "--_alt_", "Content-Type: text/html; charset=\"iso-8859-1\"", "Content-Transfer-Encoding: quoted-printable", "", "<html><head><style>p {font-family:Calibri}</style></head><body><p>Ciao</p></body></html>",
    "--_alt_--", "",
    "--_rel_", "Content-Type: image/png; name=\"image001.png\"", "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=",
    "--_rel_--", ""].join("\r\n");
  assert.ok(eml.indexOf("From:") > 3000, "From oltre i primi 3000 caratteri, come nei file reali");
  const src = tmp("c1-eml-");
  writeFileSync(join(src, "R Centro di costo.eml"), eml, "latin1");
  const ws = tmp("c1-eml-ws-");
  const r = ingestFolder(src, { root: ws, customer: "ENEL", scope: "XSC", today: "2026-11-18" });
  assert.equal(r.files.parsed, 1, JSON.stringify(r.files));
  const doc = parseEmail(readFileSync(join(src, "R Centro di costo.eml")), { id: "eml", source: "R Centro di costo.eml" });
  assert.equal(doc.title, "R: Centro di costo");
  assert.equal(doc.sections.length, 2, JSON.stringify(doc.sections.map((s) => s.meta)));
  assert.equal(doc.sections[0].meta.from, "Giulio Bianchì <giulio@example.invalid>");
  assert.equal(doc.sections[1].meta.subject, "Centro di costo");
  assert.equal(doc.sections[1].meta.date, "lunedì 26 ottobre 2026 10:33");
  const text = doc.sections.flatMap((s) => s.paragraphs).join("\n");
  assert.match(text, /il campo Centro di costo è obbligatorio/);
  assert.match(text, /mario\.rossi@example\.invalid/, "indirizzo ricomposto dal quoted-printable");
  assert.doesNotMatch(text, /Received:|msip_labels|font-family|=E8|=\s*$/m);
  assert.deepEqual(doc.sections[0].records, [{ kind: "attachment", name: "image001.png" }]);
  const unitsDir = join(ws, "customers", "ENEL", "sources", "units");
  const all = readdirSync(unitsDir, { recursive: true }).filter((f) => f.endsWith(".yaml")).map((f) => readFileSync(join(unitsDir, f), "utf8")).join("\n");
  assert.ok(!/mario\.ro|ssi@example/.test(all), "nessun frammento dell'indirizzo nelle unità");
});

// Revisione di sicurezza (19/11/2026): le regex che toglievano commenti e blocchi style/head/script (e i marcatori) da un
// corpo HTML ripartivano da ogni apertura senza chiusura fino in fondo al corpo: O(n²) con migliaia di aperture non chiuse.
test("HTML di un'e-mail: 200 KB di <!-- e <style non chiusi in meno di 1 s; testo, a capo ed entità come prima", () => {
  for (const evil of ["<!--".repeat(50000), "<style".repeat(34000), "<!--<style<head<script ".repeat(9000), "<".repeat(200000), `<p>testo</p>${"<a".repeat(100000)}`]) {
    assert.ok(evil.length >= 190000);
    const t0 = Date.now();
    const out = htmlToText(evil);
    assert.ok(Date.now() - t0 < 1000, `${evil.slice(0, 12)}…: ${Date.now() - t0} ms`);
    assert.ok(out.length < evil.length);
  }
  const html = "<html><head><title>x</title><style>p { font-family: Calibri }</style></head><body><!-- nota --><p>Ciao&nbsp;Laura,</p>"
    + "<p>il campo <b>Centro di costo</b> &#232; obbligatorio &amp; visibile.<br>Seconda riga</p><script>alert(1)</script><div>Fine</div></body></html>";
  const text = htmlToText(html);
  assert.equal(text.split("\n").filter(Boolean).join("|"), "Ciao Laura,|il campo Centro di costo è obbligatorio & visibile.|Seconda riga|Fine");
  assert.doesNotMatch(text, /Calibri|nota|alert|<|>/);
  // apertura senza chiusura: il resto del corpo si taglia (niente CSS o script nel testo)
  assert.equal(htmlToText("<p>prima</p><style>p { color: red }").trim(), "prima");
  assert.equal(htmlToText("<p>a</p><!-- commento senza fine <p>b</p>").trim(), "a");
  assert.ok(htmlToText("x".repeat(HTML_MAX + 10)).length <= HTML_MAX, "corpo HTML limitato");
});
