# Soluzione A — Piano di implementazione

> **Per chi esegue:** SUB-SKILL RICHIESTA: superpowers:subagent-driven-development (consigliata) o
> superpowers:executing-plans, un task alla volta. I passi usano le caselle (`- [ ]`).

**Obiettivo:** la mappa di JAGGAER (SEL, FLD, percorsi) nasce da uno script a partire dalle pagine registrate
automaticamente durante l'esplorazione, e il piano di "crea ordine/contratto" nasce da uno script dalla mappa e dai
dati.

**Architettura:**
- `observe-append` (hook PostToolUse già esistente) scrive un registro di sola struttura per sessione.
- `kb atlas-build` lo trasforma in item del cliente, riusando `writeDraft` di `atlas-write`.
- `compose-plan` compone un piano valido per `validate-plan` oppure restituisce le mancanze.

Guard, approvazioni e step-check non cambiano.

**Stack:** Node ≥ 22 ESM, `node --test`, better-sqlite3, yaml. Nessuna dipendenza nuova.

**Spec:** `plugin/docs/superpowers/specs/2026-09-30-soluzione-a-atlas-design.md`

Tutti i percorsi sotto sono relativi a `plugin/`. I comandi si eseguono da `plugin/`.

## Global Constraints

- Ramo `feature/soluzione-a-atlas`: commit locali, **nessun push, nessun merge** (il merge lo fa l'utente).
- Commit in italiano, `feat(…)`/`fix(…)`/`docs(…)`/`test(…)`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Prima dell'ultimo commit: `node scripts/admin/integrity.mjs build` (i file toccati sono nel perimetro d'integrità).
- Registro: solo struttura, mai `value`, mai elementi dentro `row`/`cell`/`gridcell` (salvo `columnheader`/`rowheader`), nomi redatti con il profilo dell'ambiente, URL solo percorso.
- Limiti del registro: ≤ 300 elementi per pagina, file ≤ 20 MB (`ATLAS_LOG_MAX_BYTES = 20 * 1024 * 1024`).
- `observe-append` resta fail-open: un errore del registro diventa un avviso, mai un blocco; `npm run test:timing` verde.
- Item scritti: livello C del cliente attivo, F1 `osservazione-chrome`, F12 `digerito`, F15 `empirica` (già garantito da `writeDraft`).
- Abbinamento dati→campi solo per etichetta normalizzata (`normLabel`); ambiguo ⇒ mancanza, mai scelta a caso.
- Mai dati del corpus `JAGGAER DOC` nei test: solo fixture sintetiche.

## Review Focus

- Pagina con una tabella di record (nomi di fornitori, persone): nessun nome di riga nel registro. Test in Task 1.
- Snapshot parziale (`find`) o risposta d'errore: nessuna riga di pagina nel registro. Test in Task 2.
- Stessa etichetta due volte nel modulo: `compose-plan` restituisce la mancanza `ambiguous`, non sceglie. Test in Task 4.
- Campo obbligatorio senza dato: nessun piano, uscita 3 con la domanda. Test in Task 4.
- Seconda esecuzione di `atlas-build` sulla stessa sessione: zero item nuovi (percorsi compresi). Test in Task 3.

---

### Task 1: registro di sola struttura (modulo puro)

**Files:**
- Create: `hooks/lib/atlas-log.mjs`
- Test: `test/hooks/atlas-log.test.mjs`

**Interfaces:**
- Consumes: `parseSnapshot(text)` → `{ url, title, elements: [{ id?, parent, role, name, ref, required?, value?, checked?, disabled?, level? }] }` (`scripts/chrome/snapshot-parse.mjs`; il parser DevTools crea `{ id: uid, parent, role, name, ref: uid }`); `redactText(text, { profile, env })` → `{ text, masks }` (`scripts/chrome/redact.mjs`).
- Produces:
  - `pageRecord(page, { pageSig, profile, env, ts })` → `{ kind: "page", ts, url_path, page_sig, title, elements: [{ i, parent, role, name, required?, disabled?, checked?, level? }] }`
  - `clickRecord({ fromSig, name, ts })` → `{ kind: "click", ts, from_sig, target: { name } }`
  - `appendAtlasLog(file, rec, { maxBytes = ATLAS_LOG_MAX_BYTES })` → `"written" | "full"`
  - `atlasLogFile(ws, customer, sid)` → `<ws>/customers/<C>/.sessions/<sid>/atlas/pages.jsonl`
  - costanti `ATLAS_LOG_MAX_BYTES`, `STRUCT_ROLES`

- [ ] **Step 1: test che falliscono**

```js
// test/hooks/atlas-log.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSnapshot } from "../../scripts/chrome/snapshot-parse.mjs";
import { pageRecord, clickRecord, appendAtlasLog } from "../../hooks/lib/atlas-log.mjs";

const SNAP = `## Latest page snapshot
uid=1_0 RootWebArea "Nuovo ordine - ACME PRE" url="https://acme-pre.jaggaer.com/p2p/po/new?supplier=77"
  uid=1_1 navigation "Menu"
    uid=1_2 link "Ordini"
  uid=1_3 heading "Nuovo ordine" level="1"
  uid=1_4 form
    uid=1_5 textbox "Descrizione " required value="Ordine per mario.rossi@example.com"
    uid=1_6 combobox "Divisa" value="EUR"
      uid=1_7 option "EUR"
      uid=1_8 option "USD"
    uid=1_9 button "Salva bozza"
  uid=1_10 table "Ultimi ordini"
    uid=1_11 row
      uid=1_12 columnheader "Fornitore"
    uid=1_13 row
      uid=1_14 cell "Arredi Rossi Srl"
      uid=1_15 link "PO-4500012345"
`;

test("pageRecord: solo struttura — niente valori, niente righe di tabella salvo le intestazioni, URL senza query", () => {
  const r = pageRecord(parseSnapshot(SNAP), { pageSig: "p2p/po/new#nuovo-ordine", profile: "strict", env: {}, ts: "2026-09-30T10:00:00.000Z" });
  assert.equal(r.kind, "page");
  assert.equal(r.url_path, "/p2p/po/new");
  assert.equal(r.page_sig, "p2p/po/new#nuovo-ordine");
  const names = r.elements.map((e) => e.name);
  assert.ok(names.includes("Ordini") && names.includes("Salva bozza") && names.includes("Fornitore"));
  assert.ok(names.includes("EUR") && names.includes("USD"), "opzioni della tendina");
  assert.ok(!names.some((n) => /Arredi|PO-45/.test(n)), "record della tabella esclusi");
  assert.ok(!JSON.stringify(r).includes("mario.rossi"), "nessun valore");
  assert.ok(r.elements.every((e) => !("value" in e)));
  assert.equal(r.elements.find((e) => e.name === "Descrizione").required, true);
  const opt = r.elements.find((e) => e.name === "USD");
  assert.equal(r.elements[opt.parent].role, "combobox", "parent = indice dell'antenato conservato");
});

test("pageRecord: nomi redatti; al più 300 elementi", () => {
  const pii = `uid=8_0 RootWebArea "X" url="https://h/x"\n  uid=8_1 link "Scrivi a mario.rossi@example.com"\n`;
  assert.ok(!JSON.stringify(pageRecord(parseSnapshot(pii), { pageSig: "x", profile: "strict", env: {} })).includes("mario.rossi"));
  const many = `uid=9_0 RootWebArea "X" url="https://h/x"\n${Array.from({ length: 400 }, (_, i) => `  uid=9_${i + 1} button "B${i}"`).join("\n")}\n`;
  assert.equal(pageRecord(parseSnapshot(many), { pageSig: "x", profile: "standard", env: {} }).elements.length, 300);
});

test("appendAtlasLog: righe jsonl; oltre il limite 'full' senza scrivere", () => {
  const dir = mkdtempSync(join(tmpdir(), "alog-"));
  const f = join(dir, "atlas", "pages.jsonl");
  assert.equal(appendAtlasLog(f, clickRecord({ fromSig: "a#b", name: "Ordini", ts: "t" })), "written");
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8").trim()), { kind: "click", ts: "t", from_sig: "a#b", target: { name: "Ordini" } });
  writeFileSync(f, "x".repeat(50));
  assert.equal(appendAtlasLog(f, clickRecord({ fromSig: "a", name: "b", ts: "t" }), { maxBytes: 40 }), "full");
  assert.equal(readFileSync(f, "utf8").length, 50);
});
```

- [ ] **Step 2: eseguire e verificare che fallisca**

Run: `node --test test/hooks/atlas-log.test.mjs`
Expected: FAIL (`Cannot find module …/hooks/lib/atlas-log.mjs`)

- [ ] **Step 3: implementazione**

```js
// hooks/lib/atlas-log.mjs
// Registro dell'esplorazione (soluzione A, spec 2026-09-30 §A1): per ogni pagina letta per intero, SOLA STRUTTURA —
// ruoli, nomi redatti, obblighi — e i click fra le pagine. Mai valori dei campi, mai record di tabelle (righe e celle,
// salvo le intestazioni di colonna), URL senza query. Lo scrive solo observe-append (guard-scope lo protegge).
//   pageRecord(page, { pageSig, profile, env, ts }) · clickRecord({ fromSig, name, ts })
//   appendAtlasLog(file, rec, { maxBytes }) → "written" | "full" · atlasLogFile(ws, customer, sid)
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactText } from "../../scripts/chrome/redact.mjs";

export const ATLAS_LOG_MAX_BYTES = 20 * 1024 * 1024;
const MAX_ELEMENTS = 300;
export const STRUCT_ROLES = new Set(["heading", "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "checkbox", "radio", "combobox",
  "listbox", "option", "textbox", "searchbox", "spinbutton", "switch", "textarea", "group", "region", "form", "navigation", "menu", "menubar", "tablist",
  "tabpanel", "dialog", "alertdialog", "columnheader", "rowheader", "table", "grid", "treeitem"]);
const RECORD_ROLES = new Set(["row", "cell", "gridcell"]);
const HEADER_ROLES = new Set(["columnheader", "rowheader"]);
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim().replace(/[\s:*]+$/, "");

export const atlasLogFile = (ws, customer, sid) => join(ws, "customers", customer, ".sessions", sid, "atlas", "pages.jsonl");

function urlPath(url) {
  try { return new URL(url).pathname; } catch { return null; }
}

export function pageRecord(page, { pageSig, profile = "strict", env = process.env, ts = new Date().toISOString() } = {}) {
  const els = Array.isArray(page?.elements) ? page.elements : [];
  const keyOf = (e) => String(e.id ?? e.ref);
  const byId = new Map(els.filter((e) => e.id != null || e.ref != null).map((e) => [keyOf(e), e]));
  const inRecord = (e) => {
    let p = e.parent;
    for (let hop = 0; p != null && hop < 200; hop++) {
      const a = byId.get(String(p));
      if (!a) break;
      if (RECORD_ROLES.has(a.role)) return true;
      p = a.parent;
    }
    return false;
  };
  const kept = [];
  const index = new Map();
  for (const e of els) {
    if (kept.length >= MAX_ELEMENTS) break;
    if (!STRUCT_ROLES.has(e.role)) continue;
    if (!HEADER_ROLES.has(e.role) && inRecord(e)) continue;
    const name = clean(redactText(clean(e.name), { profile, env }).text);
    let p = e.parent;
    let parent = null;
    for (let hop = 0; p != null && hop < 200; hop++) {
      if (index.has(String(p))) { parent = index.get(String(p)); break; }
      p = byId.get(String(p))?.parent ?? null;
    }
    const rec = { i: kept.length, parent, role: e.role, name };
    if (e.required) rec.required = true;
    if (e.disabled) rec.disabled = true;
    if (e.checked !== undefined) rec.checked = e.checked;
    if (e.level !== undefined) rec.level = e.level;
    index.set(keyOf(e), kept.length);
    kept.push(rec);
  }
  return { kind: "page", ts, url_path: urlPath(page?.url), page_sig: pageSig ?? null, title: page?.title ? clean(redactText(page.title, { profile, env }).text) : null, elements: kept };
}

export function clickRecord({ fromSig, name, ts = new Date().toISOString() }) {
  return { kind: "click", ts, from_sig: fromSig ?? null, target: { name: clean(name) } };
}

export function appendAtlasLog(file, rec, { maxBytes = ATLAS_LOG_MAX_BYTES } = {}) {
  let size = 0;
  try { size = statSync(file).size; } catch { /* assente */ }
  if (size >= maxBytes) return "full";
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(rec)}\n`);
  return "written";
}
```

- [ ] **Step 4: eseguire e verificare che passi**

Run: `node --test test/hooks/atlas-log.test.mjs`
Expected: PASS (3 test). Se l'opzione `USD` non ha `parent` combobox, controllare che `parseSnapshot` imposti
`parent` sugli elementi DevTools (righe ~95-110 di `snapshot-parse.mjs`) e usare quel campo.

- [ ] **Step 5: commit**

```bash
git add hooks/lib/atlas-log.mjs test/hooks/atlas-log.test.mjs
git commit -m "feat(hooks): registro dell'esplorazione di sola struttura (atlas-log)"
```

---

### Task 2: observe-append scrive il registro; file protetto

**Files:**
- Modify: `hooks/lib/observe-append.mjs` (`buildObservation` restituisce anche `page`; `record` scrive il registro)
- Modify: `hooks/lib/guards/scope.mjs` (`WRITE_DENY` e `MAIN_SHELL_DENY`: `customers/*/.sessions/*/atlas/**`)
- Test: `test/hooks/observe-append-atlas.test.mjs`

**Interfaces:**
- Consumes: Task 1.
- Produces: `customers/<C>/.sessions/<sid>/atlas/pages.jsonl` con righe `page` e `click`, letto dal Task 3.

- [ ] **Step 1: test che falliscono**

```js
// test/hooks/observe-append-atlas.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { envWs, patchSession, ROOT } from "../helpers/env-fixture.mjs";
import { runHook, decisionOf } from "../helpers/hook-env.mjs";

const DT = "mcp__chrome-devtools__";
const URL = "https://acme-sbx.jaggaer.com/p2p/po/new";
const SNAP = `## Latest page snapshot\nuid=1_0 RootWebArea "Nuovo ordine - ACME SBX" url="${URL}"\n  uid=1_1 heading "Nuovo ordine" level="1"\n  uid=1_2 textbox "Descrizione " required value="segreto@example.com"\n  uid=1_3 button "Salva bozza"\n  uid=1_4 link "Ordini"\n`;
const T = (text) => [{ type: "text", text }];
function ws0() {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  patchSession(ws, (s) => { s.browser = { current_url: URL, tab: "1", updated_by: "browser-origin" }; });
  return ws;
}
const post = (ws, tool, ti, resp) => runHook("observe-append", { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input: ti, tool_response: resp }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const log = (ws) => { const f = join(ws, "customers/ACME/.sessions/sess-1/atlas/pages.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };

test("snapshot completo ⇒ riga di pagina senza valori; click ⇒ arco con il nome dall'ultimo snapshot", () => {
  const ws = ws0();
  post(ws, `${DT}take_snapshot`, { pageId: 1 }, T(SNAP));
  const [page] = log(ws);
  assert.equal(page?.kind, "page", "riga di pagina assente: pageUrl non confermato? vedi nota");
  assert.equal(page.url_path, "/p2p/po/new");
  assert.ok(page.elements.some((e) => e.name === "Salva bozza" && e.role === "button"));
  assert.ok(!JSON.stringify(page).includes("segreto@"));
  post(ws, `${DT}click`, { uid: "1_4", pageId: 1 }, T("Successfully clicked on the element"));
  const click = log(ws).at(-1);
  assert.equal(click.kind, "click");
  assert.equal(click.target.name, "Ordini");
  assert.equal(click.from_sig, page.page_sig);
});

test("lettura parziale (find) o risposta d'errore ⇒ nessuna riga di pagina", () => {
  const ws = ws0();
  post(ws, "mcp__claude-in-chrome__find", { query: "salva" }, T(SNAP));
  post(ws, `${DT}take_snapshot`, { pageId: 1 }, T("Error: page closed"));
  assert.equal(log(ws).filter((r) => r.kind === "page").length, 0);
});

test("il registro è protetto: né la sessione principale né un sub-agente lo scrivono (Write, Edit, shell)", () => {
  const ws = ws0();
  const f = join(ws, "customers/ACME/.sessions/sess-1/atlas/pages.jsonl");
  const rel = "customers/ACME/.sessions/sess-1/atlas/pages.jsonl";
  for (const who of [{}, { agent_id: "b1", agent_type: "jaggaer-virtual-consultant:scope-expert" }]) {
    for (const [tool, ti] of [["Write", { file_path: f, content: "{}" }], ["Edit", { file_path: f, old_string: "a", new_string: "b" }], ["Bash", { command: `echo {} >> ${rel}` }]]) {
      const r = runHook("guard-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input: ti, ...who }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
      assert.equal(decisionOf(r), "deny", `${tool} ${who.agent_id ?? "manager"}`);
    }
  }
});
```

Nota: `pageUrl` in `buildObservation` viene da `observedLocation(call.family, text, { asked, resp })`. Se nel
fixture non risulta confermato, usare la risposta DevTools con la sezione `## Pages` come in
`test/hooks/observe-append.test.mjs` (costante `CASES`, `dt-navigate`), oppure la funzione `snap("chrome-devtools", …)`
di `test/helpers/k6-fixture.mjs`, che produce snapshot già riconosciuti.

- [ ] **Step 2: eseguire e verificare che fallisca**

Run: `node --test test/hooks/observe-append-atlas.test.mjs`
Expected: FAIL (nessun file `atlas/pages.jsonl`; Write consentito nel terzo test).

- [ ] **Step 3: implementazione**

In `hooks/lib/observe-append.mjs`:

1. Import in testa:
```js
import { pageRecord, clickRecord, appendAtlasLog, atlasLogFile } from "./atlas-log.mjs";
```
2. In `buildObservation`, nella `return` finale
   (`return { doc, errors, scope, profile, cfgObject, refs, pageUrl, mode, labels, labelLoc, asked, text, names };`,
   subito prima di `// Nuovo stato del legame`), aggiungere `page`.
3. In `record`, subito dopo `const warn = [];`:
```js
  // soluzione A: stato PRIMA di questa chiamata (nome del bersaglio di un click, pagina di partenza)
  const prevSnap = st.session.browser?.snapshot ?? null;
  const prevSig = st.session.ledger?.observe?.last_page_sig ?? null;
```
4. Nella destrutturazione `const { doc, errors, scope, cfgObject, refs, pageUrl, mode, labels, labelLoc, asked, text, names } = await buildObservation(…)` aggiungere `page`.
5. Subito prima di `const errTag = …`:
```js
  // 4. soluzione A (spec §A1): registro di sola struttura per atlas-build — fail-open, mai un blocco
  try {
    const file = atlasLogFile(st.ws, st.customer, st.sid);
    let full = false;
    if (state === "ok" && mode === "complete" && pageUrl && page) {
      full = appendAtlasLog(file, pageRecord(page, { pageSig: doc.page_signature, profile: doc.redaction.profile, env, ts: doc.ts })) === "full";
    }
    const clicked = state === "ok" ? (call.actions ?? [call]).filter((a) => a.kind === "click" && !a.submits && Array.isArray(a.targets) && a.targets.length) : [];
    for (const a of clicked) {
      const name = prevSnap?.names?.[String(a.targets[0])];
      if (name) full = appendAtlasLog(file, clickRecord({ fromSig: prevSig, name, ts: doc.ts })) === "full" || full;
    }
    if (full) warn.push("registro dell'esplorazione pieno (20 MB): pagine non registrate");
  } catch (err) { warn.push(`registro dell'esplorazione non scritto (${String(err?.message ?? err).slice(0, 80)})`); }
```
   (`st.sid` è già usato più sotto da `sessionDir(st.ws, st.customer, st.sid)`.)

In `hooks/lib/guards/scope.mjs`:
- in `WRITE_DENY`, dopo la riga di `observations.jsonl`:
```js
  ["customers/*/.sessions/*/atlas/**", "il registro dell'esplorazione lo scrive solo l'hook observe-append (soluzione A)"],
```
- nell'elenco di `MAIN_SHELL_DENY` aggiungere `"customers/*/.sessions/*/atlas/**"` dopo `"customers/*/.sessions/*/observations.jsonl"`.

- [ ] **Step 4: eseguire i test del task e quelli esistenti**

Run: `node --test test/hooks/observe-append-atlas.test.mjs test/hooks/observe-append.test.mjs test/admin/wp10d-monitor.test.mjs`
Expected: PASS

Run: `npm run test:timing`
Expected: PASS (5/5)

- [ ] **Step 5: commit**

```bash
git add hooks/lib/observe-append.mjs hooks/lib/guards/scope.mjs test/hooks/observe-append-atlas.test.mjs
git commit -m "feat(hooks): observe-append registra pagine e click dell'esplorazione; registro protetto in scrittura"
```

---

### Task 3: `kb atlas-build`

**Files:**
- Create: `scripts/kb/atlas-build.mjs`
- Modify: `scripts/kb/kb.mjs` (HELP e `runAsync`)
- Test: `test/kb/atlas-build.test.mjs`

**Interfaces:**
- Consumes:
  - il registro del Task 2;
  - `writeDraft({ ws, customer, scope, draft })` → `{ written: [{ code, type, label }], skipped }` e
    `AtlasWriteError` di `scripts/kb/atlas-write.mjs`;
  - `normLabel` di `scripts/chrome/snapshot-parse.mjs`.
- Produces:
  - `readLog(file)` → righe;
  - `buildDrafts(lines)` → `{ pages: Map<page_sig, { title, url_path, elements }>, fields: [...], sels: [...], routes: [{ page_sig, title, steps: [{ kind: "navigate", url_path, sig } | { kind: "click", name, role, from_sig, to_sig }] }] }`;
  - `atlasBuild({ ws, customer, scope, sid })` → `{ pages: number, written, skipped }`.

  Sui file di `kb/scopes/<S>/`:
  - FLW `title: "Percorso: <titolo pagina>"`, con passi `NAVIGATE {url_pattern}` e `CLICK <SEL>`, ognuno con
    `expect.page_sig` = parte prima di `#` della firma;
  - SEL con `field` = codice FLD per i campi.

Regole:
- **Ruolo → SEL**: `button link menuitem tab checkbox radio combobox textbox searchbox spinbutton switch textarea`,
  nome non vuoto.
- **Ruolo → FLD**, con il tipo:

  | Ruolo | `field_type` |
  |---|---|
  | `textbox`, `textarea` | `text` |
  | `spinbutton` | `number` |
  | `combobox`, `listbox` | `list` |
  | `checkbox`, `switch` | `flag` |
  | `searchbox` | `lookup` |

- **Documento del FLD**: il primo `heading` di livello 1 della pagina, altrimenti il titolo. **Sezione**: il più vicino
  antenato `group`/`region`/`form`/`tabpanel` con un nome, altrimenti `principale`. **Opzioni**: i figli `option`
  dell'elemento.
- **Archi**: una riga `click` chiusa dalla prima riga `page` successiva con firma diversa da `from_sig`.
- **Percorsi**: BFS dalla prima pagina del registro; una FLW per ogni pagina raggiunta con almeno un click.
- **Idempotenza**: un percorso si scarta se esiste già una FLW con lo stesso titolo.

- [ ] **Step 1: test che falliscono**

```js
// test/kb/atlas-build.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { buildDrafts, atlasBuild } from "../../scripts/kb/atlas-build.mjs";

const home = { kind: "page", ts: "1", url_path: "/home", page_sig: "home#benvenuto", title: "Home", elements: [
  { i: 0, parent: null, role: "heading", name: "Benvenuto", level: 1 }, { i: 1, parent: null, role: "link", name: "Ordini" }] };
const list = { kind: "page", ts: "3", url_path: "/p2p/po", page_sig: "p2p/po#ordini", title: "Ordini", elements: [
  { i: 0, parent: null, role: "heading", name: "Ordini", level: 1 }, { i: 1, parent: null, role: "button", name: "Nuovo ordine" }] };
const form = { kind: "page", ts: "5", url_path: "/p2p/po/new", page_sig: "p2p/po/new#nuovo-ordine", title: "Nuovo ordine", elements: [
  { i: 0, parent: null, role: "heading", name: "Nuovo ordine", level: 1 },
  { i: 1, parent: null, role: "group", name: "Testata" },
  { i: 2, parent: 1, role: "textbox", name: "Descrizione", required: true },
  { i: 3, parent: 1, role: "combobox", name: "Divisa" }, { i: 4, parent: 3, role: "option", name: "EUR" }, { i: 5, parent: 3, role: "option", name: "USD" },
  { i: 6, parent: null, role: "button", name: "Salva bozza" }] };
const LOG = [home, { kind: "click", ts: "2", from_sig: "home#benvenuto", target: { name: "Ordini" } }, list,
  { kind: "click", ts: "4", from_sig: "p2p/po#ordini", target: { name: "Nuovo ordine" } }, form];

test("buildDrafts: FLD con tipo, obbligo, sezione, opzioni; percorso home → ordini → nuovo ordine", () => {
  const d = buildDrafts(LOG);
  const desc = d.fields.find((f) => f.label === "Descrizione");
  assert.deepEqual([desc.document, desc.section, desc.field_type, desc.mandatory], ["Nuovo ordine", "Testata", "text", "always"]);
  assert.deepEqual(d.fields.find((f) => f.label === "Divisa").options, ["EUR", "USD"]);
  const r = d.routes.find((x) => x.page_sig === "p2p/po/new#nuovo-ordine");
  assert.deepEqual(r.steps.map((s) => s.kind === "click" ? s.name : s.url_path), ["/home", "Ordini", "Nuovo ordine"]);
});

test("atlasBuild: FLD, SEL legati ai campi, percorsi; seconda esecuzione senza item nuovi", () => {
  const ws = mkdtempSync(join(tmpdir(), "abuild-"));
  mkdirSync(join(ws, "customers/ACME/.sessions/sess-1/atlas"), { recursive: true });
  writeFileSync(join(ws, "customers/ACME/.sessions/sess-1/atlas/pages.jsonl"), `${LOG.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const r = atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "sess-1" });
  assert.ok(r.written.length >= 7, JSON.stringify(r));
  const kb = join(ws, "customers/ACME/kb/scopes/P2P");
  const load = (dir) => readdirSync(join(kb, dir)).map((f) => YAML.parse(readFileSync(join(kb, dir, f), "utf8")));
  const sels = load("selectors");
  assert.match(sels.find((s) => s.label === "Descrizione").field, /^C\.ACME\.P2P\.FLD\.\d{4}$/);
  assert.equal(sels.find((s) => s.label === "Salva bozza").effect, "write");
  const route = load("flows").find((f) => f.title === "Percorso: Nuovo ordine");
  assert.deepEqual(route.steps.map((s) => s.verb), ["NAVIGATE", "CLICK", "CLICK"]);
  assert.match(route.steps[2].target, /^C\.ACME\.P2P\.SEL\.\d{4}$/);
  assert.equal(route.steps[2].expect.page_sig, "p2p/po/new");
  const again = atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "sess-1" });
  assert.equal(again.written.length, 0, JSON.stringify(again.written));
});

test("atlasBuild: registro assente ⇒ errore d'uso (exit 1)", () => {
  const ws = mkdtempSync(join(tmpdir(), "abuild-"));
  mkdirSync(join(ws, "customers/ACME"), { recursive: true });
  assert.throws(() => atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "nessuna" }), (e) => e.code === 1);
});
```

- [ ] **Step 2: eseguire e verificare che fallisca**

Run: `node --test test/kb/atlas-build.test.mjs`
Expected: FAIL (modulo assente)

- [ ] **Step 3: implementazione**

```js
// scripts/kb/atlas-build.mjs — soluzione A (spec 2026-09-30 §A2): dal registro dell'esplorazione della sessione
// (customers/<C>/.sessions/<sid>/atlas/pages.jsonl, scritto solo da observe-append) a FLD, SEL e percorsi (FLW
// "Percorso: <pagina>") nella conoscenza del cliente, tramite writeDraft di atlas-write (validazione, doppioni, codici).
//   kb atlas-build --session <sid> [--scope <S>] [--customer <C>] [--workspace <dir>] [--json]
// Exit: 0 ok · 1 uso o registro assente · 2 sistema · 3 cliente diverso dalla sessione.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { writeDraft, AtlasWriteError } from "./atlas-write.mjs";
import { normLabel } from "../chrome/snapshot-parse.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";

const SEL_ROLES = new Set(["button", "link", "menuitem", "tab", "checkbox", "radio", "combobox", "textbox", "searchbox", "spinbutton", "switch", "textarea"]);
const FIELD_TYPE = { textbox: "text", textarea: "text", spinbutton: "number", combobox: "list", listbox: "list", checkbox: "flag", switch: "flag", searchbox: "lookup" };
const SECTION_ROLES = new Set(["group", "region", "form", "tabpanel"]);
const sigPath = (sig) => String(sig ?? "").split("#")[0];

export function readLog(file) {
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function buildDrafts(lines) {
  const pages = new Map();
  const fields = [];
  const sels = [];
  const edges = [];
  let pendingClick = null;
  for (const l of lines) {
    if (l.kind === "click") { pendingClick = l; continue; }
    if (l.kind !== "page" || !l.page_sig) continue;
    if (pendingClick?.from_sig && pendingClick.from_sig !== l.page_sig) edges.push({ from: pendingClick.from_sig, to: l.page_sig, name: pendingClick.target?.name });
    pendingClick = null;
    const first = !pages.has(l.page_sig);
    pages.set(l.page_sig, { title: l.title, url_path: l.url_path, elements: l.elements ?? [] });
    if (!first) continue;
    const els = l.elements ?? [];
    const document = els.find((e) => e.role === "heading" && e.level === 1 && e.name)?.name ?? l.title ?? l.page_sig;
    const sectionOf = (e) => { let p = e.parent; for (let hop = 0; p != null && hop < 200; hop++) { const a = els[p]; if (!a) break; if (SECTION_ROLES.has(a.role) && a.name) return a.name; p = a.parent; } return "principale"; };
    for (const e of els) {
      if (!e.name) continue;
      if (FIELD_TYPE[e.role]) {
        const options = els.filter((o) => o.parent === e.i && o.role === "option" && o.name).map((o) => o.name);
        fields.push({ type: "FLD", page_sig: l.page_sig, label: e.name, document, section: sectionOf(e), field_type: FIELD_TYPE[e.role], mandatory: e.required ? "always" : "undocumented", ...(options.length ? { options } : {}) });
      }
      if (SEL_ROLES.has(e.role)) sels.push({ type: "SEL", page_sig: l.page_sig, label: e.name, role: e.role, ...(FIELD_TYPE[e.role] ? { fieldLabel: e.name, document } : {}) });
    }
  }
  const entry = lines.find((l) => l.kind === "page" && l.page_sig)?.page_sig ?? null;
  const routes = [];
  if (entry) {
    const prev = new Map([[entry, null]]);
    const queue = [entry];
    while (queue.length) {
      const cur = queue.shift();
      for (const e of edges.filter((x) => x.from === cur)) if (!prev.has(e.to)) { prev.set(e.to, e); queue.push(e.to); }
    }
    for (const [sig, e] of prev) {
      if (!e) continue;
      const chain = [];
      for (let x = e; x; x = prev.get(x.from)) chain.unshift(x);
      routes.push({ page_sig: sig, title: pages.get(sig)?.title ?? sig, steps: [{ kind: "navigate", url_path: pages.get(entry)?.url_path ?? "/", sig: entry },
        ...chain.map((c) => ({ kind: "click", name: c.name, role: (pages.get(c.from)?.elements ?? []).find((el) => normLabel(el.name) === normLabel(c.name))?.role ?? "link", from_sig: c.from, to_sig: c.to }))] });
    }
  }
  return { pages, fields, sels, routes };
}

function scopeItems(ws, customer, scope, dir) {
  const d = join(ws, "customers", customer, "kb", "scopes", scope, dir);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".yaml")).map((f) => { try { return YAML.parse(readFileSync(join(d, f), "utf8")); } catch { return null; } }).filter(Boolean);
}

export function atlasBuild({ ws, customer, scope, sid }) {
  const file = join(ws, "customers", customer, ".sessions", sid, "atlas", "pages.jsonl");
  if (!existsSync(file)) throw new AtlasWriteError(1, `nessun registro dell'esplorazione per la sessione ${sid}`);
  const d = buildDrafts(readLog(file));
  const written = [];
  const skipped = [];
  const add = (r) => { written.push(...r.written); skipped.push(...r.skipped); };
  for (const sig of new Set(d.fields.map((f) => f.page_sig))) {
    const items = d.fields.filter((f) => f.page_sig === sig).map(({ page_sig, ...f }) => f);
    add(writeDraft({ ws, customer, scope, draft: { page: { signature: sig, title: d.pages.get(sig)?.title }, items } }));
  }
  const flds = scopeItems(ws, customer, scope, "fields");
  const fldCode = (label, document) => flds.find((f) => normLabel(f.label?.it) === normLabel(label) && normLabel(f.document) === normLabel(document))?.id;
  for (const sig of new Set(d.sels.map((s) => s.page_sig))) {
    const items = d.sels.filter((s) => s.page_sig === sig).map(({ page_sig, fieldLabel, document, ...s }) => {
      const code = fieldLabel ? fldCode(fieldLabel, document) : null;
      return code ? { ...s, field: code } : s;
    });
    add(writeDraft({ ws, customer, scope, draft: { page: { signature: sig, title: d.pages.get(sig)?.title }, items } }));
  }
  const sels = scopeItems(ws, customer, scope, "selectors");
  const selCode = (name, sig) => sels.find((s) => normLabel(s.label) === normLabel(name) && (!s.page || s.page === sig))?.id;
  const haveTitles = new Set(scopeItems(ws, customer, scope, "flows").map((f) => f.title));
  const flws = [];
  for (const r of d.routes) {
    const title = `Percorso: ${r.title}`.slice(0, 140);
    if (haveTitles.has(title)) { skipped.push({ type: "FLW", label: title, existing: "stesso titolo" }); continue; }
    const steps = [];
    let ok = true;
    for (const s of r.steps) {
      if (s.kind === "navigate") steps.push({ verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: s.url_path }, expect: { page_sig: sigPath(s.sig) } });
      else {
        const code = selCode(s.name, s.from_sig);
        if (!code) { ok = false; break; }
        steps.push({ verb: "CLICK", action_class: "ACT-OBS", target: code, expect: { page_sig: sigPath(s.to_sig) } });
      }
    }
    if (ok) flws.push({ type: "FLW", title, trigger: "navigazione", steps });
    else skipped.push({ type: "FLW", label: title, existing: "passo senza selettore" });
  }
  if (flws.length) add(writeDraft({ ws, customer, scope, draft: { items: flws } }));
  return { pages: d.pages.size, written, skipped };
}

export const HELP = `uso: kb atlas-build --session <sid> [--scope <S>] [--customer <C>] [--workspace <dir>] [--json]

Dal registro dell'esplorazione della sessione (scritto da observe-append) alla mappa nella conoscenza del cliente:
FLD (tipo, obbligo, sezione, valori delle tendine), SEL (legati ai campi, effetto dall'etichetta) e percorsi di
navigazione "Percorso: <pagina>" (FLW). Doppioni scartati; seconda esecuzione sulla stessa sessione senza item nuovi.

Exit code: 0 ok · 1 uso o registro assente · 2 sistema · 3 cliente diverso dalla sessione.`;

export async function main(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    const { resolveSessionId, loadSession } = await import("../admin/session.mjs");
    let sid = opts.session ?? null;
    try { sid ??= resolveSessionId({ workspace: ws, arg: null, env }); } catch { /* nessuna sessione attiva */ }
    if (!sid) return fail(asJson, 1, "--session <sid> obbligatorio (nessuna sessione attiva)");
    let session = null;
    try { session = loadSession(ws, sid).session ?? null; } catch { session = null; }
    const customer = opts.customer ?? session?.customer;
    if (session?.customer && customer !== session.customer) return fail(asJson, 3, `--customer ${customer} diverso dal cliente della sessione (${session.customer})`);
    const scope = String(opts.scope ?? session?.scope ?? "").toUpperCase();
    const r = atlasBuild({ ws, customer, scope, sid });
    console.log(JSON.stringify({ ok: true, customer, scope, pages: r.pages, written: r.written.length, skipped: r.skipped.length, ...(asJson ? r : {}) }));
    return 0;
  } catch (err) {
    if (err instanceof AtlasWriteError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
```

In `scripts/kb/kb.mjs`:
- in HELP, sotto le due righe di `atlas-write`:
```
  atlas-build --session <sid> [--scope S] → scripts/kb/atlas-build.mjs (mappa dal registro dell'esplorazione)
```
- in `runAsync`, dopo il ramo `atlas-write`:
```js
  if (cmd === "atlas-build") return { exitCode: await (await import("./atlas-build.mjs")).main(rest) };
```

- [ ] **Step 4: eseguire e verificare che passi**

Run: `node --test test/kb/atlas-build.test.mjs test/kb/atlas-write.test.mjs`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add scripts/kb/atlas-build.mjs scripts/kb/kb.mjs test/kb/atlas-build.test.mjs
git commit -m "feat(kb): atlas-build — FLD, SEL e percorsi dal registro dell'esplorazione"
```

---

### Task 4: `compose-plan`

**Files:**
- Create: `scripts/decide/compose-plan.mjs`
- Test: `test/decide/compose-plan.test.mjs`

**Interfaces:**
- Consumes:
  - item del Task 3 (FLD `label.it`/`document`/`mandatory.kind`/`field_type`; SEL `label`/`page`/`field`/`effect`;
    FLW `title`/`steps`);
  - `validatePlan(plan, { env })` → `{ ok, errors }` (`scripts/decide/validate-plan.mjs`);
  - `normLabel`;
  - `confineInputs` (`scripts/lib/text-file.mjs`).
- Produces:
  - `composePlan({ ws, customer, scope, env: { id, type }, goal, data, until = "bozza", planId })` → `{ plan }` |
    `{ gaps: [{ kind: "missing-data"|"unknown-field"|"ambiguous"|"no-form"|"no-route"|"no-save"|"no-submit", what, hint }] }`;
  - CLI `node scripts/decide/compose-plan.mjs --goal "<t>" --data <yaml> --scope <S> --env <id> [--fino-a bozza|invio] --out runs/<RUN>/plan.json [--json]`,
    exit 0 piano scritto · 1 uso · 2 sistema · 3 mancanze.

Regole:
- **Obiettivo → oggetto**:

  | Parole | Oggetto |
  |---|---|
  | ordine, order, po | `ordine` |
  | contratto, contract | `contratto` |
  | richiesta, requisition, rda | `richiesta` |
  | fornitore, supplier, vendor | `fornitore` |
  | evento, event | `evento` |

- **Procedura memorizzata**: FLW il cui titolo non inizia con `Percorso:`, contiene un verbo di creazione
  (crea/nuov/new/create) e un sinonimo dell'oggetto. Si riusa sostituendo i dati.
- **Altrimenti** i FLD il cui `document` contiene un verbo di creazione e un sinonimo dell'oggetto; il percorso
  `Percorso: <document>`.
- **Passi**:
  - un `FILL`/`CHOOSE` per dato (`CHOOSE` se `field_type` è `list`), sul SEL con `field` = FLD;
  - `SAVE` sul SEL `write` con /salva|save/ della pagina del modulo (preferendo bozza/draft);
  - con invio, `SUBMIT` (`ACT-SUBMIT`) su /invia|submit|conferma|place order/.
- **Compensazione**: `cancel` sull'oggetto al passo `SAVE`.
- **Mancanze**:

  | Situazione | Gap |
  |---|---|
  | campo obbligatorio senza dato | `missing-data` |
  | dato senza campo | `unknown-field` |
  | più elementi per un campo | `ambiguous` |
  | modulo non trovato | `no-form` |
  | percorso non trovato | `no-route` |
  | salvataggio non trovato | `no-save` |
  | invio non trovato | `no-submit` |

- **Validazione**: prima di restituire, `validatePlan`; se fallisce è un bug (eccezione ⇒ exit 2).

- [ ] **Step 1: test che falliscono**

```js
// test/decide/compose-plan.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeDraft } from "../../scripts/kb/atlas-write.mjs";
import { composePlan } from "../../scripts/decide/compose-plan.mjs";
import { validatePlan } from "../../scripts/decide/validate-plan.mjs";

const ENV = { id: "sandbox", type: "sandbox" };
const code = (r, label) => r.written.find((w) => w.label.trim() === label).code;
function atlas({ dupDescrizione = false } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "compose-"));
  mkdirSync(join(ws, "customers/ACME"), { recursive: true });
  const page = { signature: "p2p/po/new#nuovo-ordine", title: "Nuovo ordine" };
  const f = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page, items: [
    { type: "FLD", label: "Descrizione", document: "Nuovo ordine", section: "Testata", field_type: "text", mandatory: "always" },
    { type: "FLD", label: "Divisa", document: "Nuovo ordine", section: "Testata", field_type: "list" },
    { type: "FLD", label: "Centro di costo", document: "Nuovo ordine", section: "Testata", field_type: "text", mandatory: "always" }] } });
  const s = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page, items: [
    { type: "SEL", label: "Descrizione", role: "textbox", field: code(f, "Descrizione") },
    ...(dupDescrizione ? [{ type: "SEL", label: "Descrizione (note)", role: "textbox", field: code(f, "Descrizione") }] : []),
    { type: "SEL", label: "Divisa", role: "combobox", field: code(f, "Divisa") },
    { type: "SEL", label: "Centro di costo", role: "textbox", field: code(f, "Centro di costo") },
    { type: "SEL", label: "Salva bozza", role: "button" }, { type: "SEL", label: "Invia", role: "button" }] } });
  const h = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page: { signature: "home#benvenuto" }, items: [{ type: "SEL", label: "Ordini", role: "link" }] } });
  writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { items: [{ type: "FLW", title: "Percorso: Nuovo ordine", trigger: "navigazione", steps: [
    { verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: "/home" }, expect: { page_sig: "home" } },
    { verb: "CLICK", action_class: "ACT-OBS", target: code(h, "Ordini"), expect: { page_sig: "p2p/po/new" } }] }] } });
  return { ws, sel: (l) => code(s, l) };
}
const DATA = { Descrizione: "Sedie per sala riunioni", Divisa: "EUR", "Centro di costo": "IT-0442" };

test("senza procedura memorizzata: percorso + un passo per campo + salva + compensazione; valido per validate-plan", () => {
  const { ws } = atlas();
  const r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine per sedie", data: DATA, planId: "PLAN.ACME.PO.0001" });
  assert.ok(r.plan, JSON.stringify(r.gaps));
  assert.deepEqual(r.plan.steps.map((s) => s.verb), ["NAVIGATE", "CLICK", "FILL", "CHOOSE", "FILL", "SAVE"]);
  assert.equal(r.plan.steps.find((s) => s.verb === "CHOOSE").data, "EUR");
  assert.deepEqual(r.plan.compensations, [{ step: 6, kind: "cancel", entity: "ordine", action: "ordine.cancel" }]);
  assert.deepEqual(validatePlan(r.plan, { env: ENV }).errors, []);
});

test("fino a invio: SUBMIT ACT-SUBMIT dopo il salvataggio", () => {
  const r = composePlan({ ws: atlas().ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: DATA, until: "invio", planId: "PLAN.ACME.PO.0002" });
  assert.equal(r.plan.steps.at(-1).verb, "SUBMIT");
  assert.equal(r.plan.steps.at(-1).action_class, "ACT-SUBMIT");
});

test("mancanze: obbligatorio senza dato, campo sconosciuto, elemento ambiguo, modulo inesistente ⇒ nessun piano", () => {
  const miss = composePlan({ ws: atlas().ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x", Colore: "blu" }, planId: "PLAN.ACME.PO.0003" });
  assert.equal(miss.plan, undefined);
  assert.ok(miss.gaps.some((g) => g.kind === "missing-data" && g.what === "Centro di costo"));
  assert.ok(miss.gaps.some((g) => g.kind === "unknown-field" && g.what === "Colore"));
  const amb = composePlan({ ws: atlas({ dupDescrizione: true }).ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: DATA, planId: "PLAN.ACME.PO.0004" });
  assert.ok(amb.gaps.some((g) => g.kind === "ambiguous" && g.what === "Descrizione"));
  const none = composePlan({ ws: atlas().ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea contratto", data: {}, planId: "PLAN.ACME.CO.0001" });
  assert.ok(none.gaps.some((g) => g.kind === "no-form"));
});

test("procedura memorizzata: riusata con i dati nuovi", () => {
  const { ws, sel } = atlas();
  writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { run: "RUN.ACME.20260930.0900.P2P", items: [{ type: "FLW", title: "Crea ordine", steps: [
    { verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: "/p2p/po/new" }, expect: { page_sig: "p2p/po/new" } },
    { verb: "FILL", action_class: "ACT-CREATE", target: sel("Descrizione"), data: "vecchio", expect: { elements: [{ sel: sel("Descrizione") }] } },
    { verb: "FILL", action_class: "ACT-CREATE", target: sel("Centro di costo"), data: "vecchio", expect: { elements: [{ sel: sel("Centro di costo") }] } },
    { verb: "SAVE", action_class: "ACT-CREATE", target: sel("Salva bozza"), expect: { page_sig: "p2p/po" } }] }] } });
  const r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "nuovo", "Centro di costo": "IT-1" }, planId: "PLAN.ACME.PO.0005" });
  assert.ok(r.plan, JSON.stringify(r.gaps));
  assert.deepEqual(r.plan.steps.filter((s) => s.verb === "FILL").map((s) => s.data), ["nuovo", "IT-1"]);
  assert.deepEqual(validatePlan(r.plan, { env: ENV }).errors, []);
});
```

- [ ] **Step 2: eseguire e verificare che fallisca**

Run: `node --test test/decide/compose-plan.test.mjs`
Expected: FAIL (modulo assente)

- [ ] **Step 3: implementazione**

```js
// scripts/decide/compose-plan.mjs — soluzione A (spec 2026-09-30 §A3): piano di un'attività (crea ordine, contratto,
// richiesta, fornitore, evento) dalla mappa del cliente e dai dati, oppure l'elenco preciso di ciò che manca.
// Non attiva nulla: il piano passa da validate-plan, APPROVO PIANO, step-check come ogni piano.
//   compose-plan --goal "<t>" --data <dati.yaml> --scope <S> --env <id> [--fino-a bozza|invio] --out runs/<RUN>/plan.json [--customer C] [--json]
// Exit: 0 piano scritto · 1 uso · 2 sistema · 3 mancanze (gaps).
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import YAML from "yaml";
import { normLabel } from "../chrome/snapshot-parse.mjs";
import { validatePlan } from "./validate-plan.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { confineInputs } from "../lib/text-file.mjs";

const OBJECTS = [
  ["ordine", /\b(ordine|order|po)\b/i, ["ordine", "order", "purchase order"]],
  ["contratto", /\b(contratto|contract)\b/i, ["contratto", "contract"]],
  ["richiesta", /\b(richiesta|requisition|rda)\b/i, ["richiesta", "requisition"]],
  ["fornitore", /\b(fornitore|supplier|vendor)\b/i, ["fornitore", "supplier", "vendor"]],
  ["evento", /\b(evento|event)\b/i, ["evento", "event"]],
];
const CREATE = /(crea|nuov|new|create)/i;
const SAVE = /\b(salva|save)\b/i;
const DRAFT = /(bozza|draft)/i;
const SUBMIT = /\b(invia|submit|conferma|place order)\b/i;
const RUN_OUT = /^runs\/(RUN\.[A-Z0-9]{4}\.\d{8}\.\d{4}\.[A-Z0-9]{3})\/plan\.json$/;
const pathOf = (sig) => String(sig ?? "").split("#")[0];

function items(ws, customer, scope, dir) {
  const d = join(ws, "customers", customer, "kb", "scopes", scope, dir);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".yaml")).map((f) => { try { return YAML.parse(readFileSync(join(d, f), "utf8")); } catch { return null; } }).filter(Boolean);
}

export function composePlan({ ws, customer, scope, env, goal, data = {}, until = "bozza", planId }) {
  const obj = OBJECTS.find(([, re]) => re.test(goal));
  if (!obj) return { gaps: [{ kind: "no-form", what: goal, hint: "obiettivo non riconosciuto: ordine, contratto, richiesta, fornitore, evento" }] };
  const [object, , syn] = obj;
  const flds = items(ws, customer, scope, "fields");
  const sels = items(ws, customer, scope, "selectors");
  const flws = items(ws, customer, scope, "flows");
  const gaps = [];
  const dataKeys = Object.keys(data ?? {});
  const selsForField = (id) => sels.filter((s) => s.field === id);
  const has = (text) => syn.some((w) => normLabel(text).includes(w));
  const proc = flws.find((f) => !String(f.title).startsWith("Percorso:") && CREATE.test(f.title) && has(f.title));
  const pageFields = proc
    ? flds.filter((f) => (proc.steps ?? []).some((s) => selsForField(f.id).some((x) => x.id === s.target)))
    : flds.filter((f) => CREATE.test(f.document ?? "") && has(f.document ?? ""));
  if (!pageFields.length) return { gaps: [{ kind: "no-form", what: object, hint: `nessuna pagina "nuovo ${object}" nella mappa: esplora il modulo` }] };
  const keyFor = (f) => dataKeys.find((k) => normLabel(k) === normLabel(f.label?.it));
  for (const k of dataKeys) if (!pageFields.some((f) => normLabel(f.label?.it) === normLabel(k))) gaps.push({ kind: "unknown-field", what: k, hint: "nessun campo con questa etichetta nel modulo" });
  for (const f of pageFields) if (f.mandatory?.kind === "always" && keyFor(f) === undefined) gaps.push({ kind: "missing-data", what: f.label.it, hint: "campo obbligatorio: serve il valore" });
  let steps;
  let saveN = null;
  if (proc) {
    steps = [];
    for (const s of proc.steps ?? []) {
      const out = { verb: s.verb, action_class: s.action_class, ...(s.target !== undefined ? { target: s.target } : {}), expect: s.expect ?? { page_sig: "" } };
      if (s.verb === "FILL" || s.verb === "CHOOSE") {
        const f = pageFields.find((x) => selsForField(x.id).some((y) => y.id === s.target));
        const k = f ? keyFor(f) : undefined;
        if (k === undefined) continue;
        out.data = data[k];
        out.expect = { elements: [{ sel: s.target, value: data[k] }] };
      }
      steps.push(out);
    }
    const i = steps.findIndex((s) => s.verb === "SAVE");
    saveN = i >= 0 ? i + 1 : null;
  } else {
    const document = pageFields[0].document;
    const route = flws.find((f) => f.title === `Percorso: ${document}`);
    if (!route) gaps.push({ kind: "no-route", what: document, hint: `percorso verso "${document}" non ancora visto: esplora dal menu` });
    const fills = [];
    for (const f of pageFields) {
      const k = keyFor(f);
      if (k === undefined) continue;
      const cands = selsForField(f.id);
      if (cands.length !== 1) { gaps.push({ kind: cands.length ? "ambiguous" : "unknown-field", what: f.label.it, hint: cands.length ? "più elementi per lo stesso campo: indica quale" : "campo senza elemento nella mappa: esplora la pagina" }); continue; }
      fills.push({ verb: f.field_type === "list" ? "CHOOSE" : "FILL", action_class: "ACT-CREATE", target: cands[0].id, data: data[k], expect: { elements: [{ sel: cands[0].id, value: data[k] }] } });
    }
    const formSig = selsForField(pageFields[0].id)[0]?.page ?? null;
    const onForm = sels.filter((s) => s.page && s.page === formSig);
    const saves = onForm.filter((s) => s.effect === "write" && SAVE.test(s.label));
    const save = saves.find((s) => DRAFT.test(s.label)) ?? saves[0];
    if (!save) gaps.push({ kind: "no-save", what: document, hint: "pulsante di salvataggio non visto nella pagina" });
    const submit = until === "invio" ? onForm.find((s) => s.effect === "write" && SUBMIT.test(s.label)) : null;
    if (until === "invio" && !submit) gaps.push({ kind: "no-submit", what: document, hint: "pulsante d'invio non visto nella pagina" });
    if (gaps.length) return { gaps };
    steps = [...(route.steps ?? []).map((s) => ({ verb: s.verb, action_class: s.action_class ?? "ACT-OBS", target: s.target, expect: s.expect ?? { page_sig: pathOf(formSig) } })), ...fills,
      { verb: "SAVE", action_class: "ACT-CREATE", target: save.id, expect: { page_sig: pathOf(formSig) } }];
    saveN = steps.length;
    if (submit) steps.push({ verb: "SUBMIT", action_class: "ACT-SUBMIT", target: submit.id, expect: { page_sig: pathOf(formSig) } });
  }
  if (gaps.length) return { gaps };
  steps = steps.map((s, i) => ({ n: i + 1, ...s }));
  const plan = { plan_id: planId, customer, env: env.id, goal, steps,
    ...(saveN ? { compensations: [{ step: saveN, kind: "cancel", entity: object, action: `${object}.cancel` }] } : {}),
    repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } };
  const v = validatePlan(plan, { env });
  if (!v.ok) throw new Error(`piano composto non valido (bug del compositore): ${v.errors.join("; ")}`);
  return { plan };
}

export const HELP = `uso: compose-plan --goal "<obiettivo>" --data <dati.yaml> --scope <S> --env <id> [--fino-a bozza|invio] --out runs/<RUN>/plan.json [--customer C] [--workspace <dir>] [--json]

Compone il piano di un'attività (crea ordine, contratto, richiesta, fornitore, evento) dalla mappa del cliente:
procedura memorizzata se esiste, altrimenti percorso + un passo per campo (dati per etichetta) + salva (+ invio).
Se manca qualcosa non scrive nessun piano ed elenca le mancanze. Il piano va poi approvato e attivato come sempre.

Exit code: 0 piano scritto · 1 uso · 2 sistema · 3 mancanze.`;

export async function main(argv, env = process.env) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    if (!opts.goal || !opts.data || !opts.scope || !opts.env || !opts.out) return fail(asJson, 1, "richiesti --goal --data --scope --env --out");
    const m = RUN_OUT.exec(String(opts.out));
    if (!m) return fail(asJson, 1, "--out deve essere runs/<RUN>/plan.json, relativo alla cartella del cliente");
    const bad = confineInputs(opts, ["data"], { env });
    if (bad) return fail(asJson, 1, bad);
    const { resolveSessionId, loadSession } = await import("../admin/session.mjs");
    let session = null;
    try { const sid = resolveSessionId({ workspace: ws, arg: opts.session, env }); session = sid ? loadSession(ws, sid).session : null; } catch { session = null; }
    const customer = opts.customer ?? session?.customer;
    if (!customer) return fail(asJson, 1, "nessun cliente: --customer <C> o una sessione attiva");
    if (session?.customer && customer !== session.customer) return fail(asJson, 3, `--customer ${customer} diverso dal cliente della sessione (${session.customer})`);
    if (!m[1].startsWith(`RUN.${customer}.`)) return fail(asJson, 1, `il RUN di --out non è del cliente ${customer}`);
    const envs = YAML.parse(readFileSync(join(ws, "customers", customer, "config", "environments.yaml"), "utf8"))?.environments ?? [];
    const e = envs.find((x) => x.id === opts.env);
    if (!e) return fail(asJson, 1, `ambiente ${opts.env} non dichiarato in environments.yaml`);
    const data = YAML.parse(readFileSync(opts.data, "utf8")) ?? {};
    if (typeof data !== "object" || Array.isArray(data)) return fail(asJson, 1, "--data: un file YAML con etichetta: valore");
    const planId = `PLAN.${customer}.${m[1].slice(4)}`;
    const r = composePlan({ ws, customer, scope: String(opts.scope).toUpperCase(), env: { id: e.id, type: e.type }, goal: String(opts.goal), data, until: opts["fino-a"] === "invio" ? "invio" : "bozza", planId });
    if (r.gaps) { console.log(JSON.stringify({ ok: false, gaps: r.gaps })); return 3; }
    const file = join(ws, "customers", customer, String(opts.out));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(r.plan, null, 2));
    console.log(JSON.stringify({ ok: true, plan_id: planId, file: String(opts.out), steps: r.plan.steps.length, ...(asJson ? { plan: r.plan } : {}) }));
    return 0;
  } catch (err) {
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
```

Controlli durante l'implementazione:
- verificare in `product/kb/actions/*.yaml` (`verbs_allowed`) che `ACT-OBS` ammetta `NAVIGATE`/`CLICK` e che
  `ACT-CREATE` ammetta `FILL`/`CHOOSE`/`SAVE`. Se una classe non ammette un verbo, usare quella che lo ammette nel
  compositore **e** in `atlas-build` (percorsi), e aggiornare i test;
- `expect` è obbligatorio e non vuoto per ogni passo (schema): i passi del percorso hanno sempre `page_sig`.

- [ ] **Step 4: eseguire e verificare che passi**

Run: `node --test test/decide/compose-plan.test.mjs`
Expected: PASS (4 test)

- [ ] **Step 5: commit**

```bash
git add scripts/decide/compose-plan.mjs test/decide/compose-plan.test.mjs
git commit -m "feat(decide): compose-plan — piano dalla mappa e dai dati, oppure l'elenco delle mancanze"
```

---

### Task 5: end-to-end, istruzioni e documentazione

**Files:**
- Test: `test/e2e/solution-a.test.mjs`
- Modify:
  - `agents/scope-expert.md`;
  - `skills/agent-manager/SKILL.md`;
  - `commands/ops.md`;
  - `MANUALE-UTENTE.md`;
  - `docs/GUIDA-PRIMO-USO.md`;
  - `docs/MANUAL.md` (§56.6);
  - `docs/IMPLEMENTATION-CHECKLIST.md`.

**Interfaces:**
- Consumes: Task 2 (hook), Task 3 (`atlasBuild`), Task 4 (`composePlan`).

- [ ] **Step 1: test end-to-end**

```js
// test/e2e/solution-a.test.mjs — esplorazione simulata (observe-append) → atlas-build → compose-plan → piano valido
import { test } from "node:test";
import assert from "node:assert/strict";
import { envWs, patchSession, readSession, ROOT } from "../helpers/env-fixture.mjs";
import { runHook } from "../helpers/hook-env.mjs";
import { atlasBuild } from "../../scripts/kb/atlas-build.mjs";
import { composePlan } from "../../scripts/decide/compose-plan.mjs";
import { validatePlan } from "../../scripts/decide/validate-plan.mjs";

const DT = "mcp__chrome-devtools__";
const H = "https://acme-sbx.jaggaer.com";
const T = (text) => [{ type: "text", text }];
const snap = (path, title, body) => `## Latest page snapshot\nuid=1_0 RootWebArea "${title} - ACME SBX" url="${H}${path}"\n  uid=1_1 heading "${title}" level="1"\n${body}`;
const HOME = snap("/home", "Benvenuto", `  uid=1_2 link "Ordini"\n`);
const LIST = snap("/p2p/po", "Ordini", `  uid=1_2 button "Nuovo ordine"\n`);
const FORM = snap("/p2p/po/new", "Nuovo ordine", `  uid=1_2 group "Testata"\n    uid=1_3 textbox "Descrizione " required\n    uid=1_4 textbox "Centro di costo " required\n  uid=1_5 button "Salva bozza"\n`);

test("esplorazione simulata → atlas-build → compose-plan: piano valido per crea ordine", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  const post = (tool, ti, resp) => runHook("observe-append", { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input: ti, tool_response: resp }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  const at = (path) => patchSession(ws, (s) => { s.browser = { ...(s.browser ?? {}), current_url: `${H}${path}`, tab: "1", updated_by: "browser-origin" }; });
  at("/home"); post(`${DT}take_snapshot`, { pageId: 1 }, T(HOME));
  post(`${DT}click`, { uid: "1_2", pageId: 1 }, T("Successfully clicked on the element"));
  at("/p2p/po"); post(`${DT}take_snapshot`, { pageId: 1 }, T(LIST));
  post(`${DT}click`, { uid: "1_2", pageId: 1 }, T("Successfully clicked on the element"));
  at("/p2p/po/new"); post(`${DT}take_snapshot`, { pageId: 1 }, T(FORM));
  const b = atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "sess-1" });
  assert.ok(b.written.length > 0, JSON.stringify(b));
  const env = readSession(ws).env;
  const r = composePlan({ ws, customer: "ACME", scope: "P2P", env: { id: env.id, type: env.type }, goal: "crea ordine", data: { Descrizione: "Sedie", "Centro di costo": "IT-0442" }, planId: "PLAN.ACME.E2E.0001" });
  assert.ok(r.plan, JSON.stringify(r.gaps));
  assert.deepEqual(r.plan.steps.map((s) => s.verb), ["NAVIGATE", "CLICK", "CLICK", "FILL", "FILL", "SAVE"]);
  assert.deepEqual(validatePlan(r.plan, { env: { id: env.id, type: env.type } }).errors, []);
});
```

Se la pagina non risulta confermata (nessuna riga `page`), far precedere ogni snapshot da un `navigate_page` riuscito,
come fa `navOk` in `test/hooks/k5-fixround1.test.mjs`, invece di `patchSession`. Stessa correzione nel Task 2.

- [ ] **Step 2: eseguire**

Run: `node --test test/e2e/solution-a.test.mjs`
Expected: PASS (se fallisce, correggere il task responsabile, non il test)

- [ ] **Step 3: istruzioni e documentazione**

- **`agents/scope-expert.md`, sezione "Esplorare e memorizzare"**: i punti 2–3 (bozza a mano) si sostituiscono con il
  testo sotto.

  > Ogni `take_snapshot` completo viene registrato da solo (sola struttura). Tu clicchi menu, schede, link e apri le
  > tendine, con un `take_snapshot` a ogni pagina. A fine giro:

  ```
  node "${CLAUDE_PLUGIN_ROOT}/scripts/kb/atlas-build.mjs" --session <sid> --scope <S> --json
  ```

  La bozza a mano con `atlas-write --in` resta per correggere o completare.
- **`agents/scope-expert.md`, sezione "Eseguire un'attività"**: il punto 1 diventa il comando sotto. Con exit 3
  restituisci `needs-input` con le mancanze.

  ```
  node "${CLAUDE_PLUGIN_ROOT}/scripts/decide/compose-plan.mjs" --goal "<obiettivo>" --data customers/<C>/.sessions/<sid>/work/<task>/dati.yaml --scope <S> --env <ambiente> [--fino-a invio] --out runs/<RUN>/plan.json --json
  ```

- **`skills/agent-manager/SKILL.md`**: nel paragrafo "Esplorazione senza piano" aggiungere "a fine esplorazione
  `kb atlas-build`; per crea, piano da `compose-plan`, e le mancanze (campi obbligatori senza dato) diventano domande
  all'utente".
- **`commands/ops.md` e `docs/MANUAL.md` §56.6**: `esplora` → "pagine registrate da sole, mappa con
  `kb atlas-build`"; `crea` → "piano da `compose-plan`; se mancano dati obbligatori te li chiede".
- **`MANUALE-UTENTE.md`**: §5 `kb`, riga `atlas-build` ("lo usano gli agenti a fine esplorazione"); §10 "Creare un
  ordine": "se mancano dati obbligatori il plugin te li chiede prima del piano".
- **`docs/GUIDA-PRIMO-USO.md`**: §3 "Ogni pagina viene registrata da sola e trasformata in mappa con
  `kb atlas-build`"; §4 punto 3 "Se mancano dati obbligatori il plugin te li chiede prima del piano".
- **`docs/IMPLEMENTATION-CHECKLIST.md`**: nella sezione "Dopo la chiusura", "Soluzione A: sviluppata sul ramo
  `feature/soluzione-a-atlas` (merge a cura dell'utente)".

Dopo le modifiche: `node --test test/docs/*.test.mjs test/agents/*.test.mjs test/evals/*.test.mjs` (verificano che
ogni riga di comando di agenti e skill sia ammessa dai guard reali e che gli script citati rispondano a `--help`).

- [ ] **Step 4: suite completa, tempi, integrità**

Run: `node scripts/admin/integrity.mjs build`
Run: `npm test`
Expected: tutti verdi (corpus compreso, ~15 minuti)
Run: `npm run test:timing`
Expected: 5/5

- [ ] **Step 5: commit**

```bash
git add -A
git commit -m "feat: soluzione A integrata — esplorazione registrata, atlas-build, compose-plan; istruzioni e documentazione"
```

---

### Task 6: revisione di sicurezza e consegna (niente merge)

- [ ] **Step 1:** revisione indipendente del diff `main...feature/soluzione-a-atlas` da un revisore fresco. Punti
  critici:
  - registro senza dati;
  - fail-open del hook;
  - protezione del file;
  - `compose-plan` non può attivare un piano;
  - `--out` e `--data` confinati;
  - nessun cliente incrociato.

  Regola per il revisore: **mai eseguire davvero comandi distruttivi**; sonde solo come input degli hook.
- [ ] **Step 2:** correggere i Critical/Important con un test ciascuno; ripetere suite e integrità; commit
  `fix(…): …` sul ramo.
- [ ] **Step 3:** riepilogo all'utente in italiano:
  - commit del ramo;
  - cosa cambia;
  - test;
  - rischi (taratura sulle pagine reali);
  - comandi di merge, che esegue **lui**:

    ```bash
    git switch main
    git merge --no-ff feature/soluzione-a-atlas
    ```

  Nessun merge, nessun push.
