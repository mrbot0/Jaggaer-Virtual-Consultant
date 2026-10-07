# Ops veloce — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** livelli di autonomia per ops (alto predefinito, tetto medio in produzione), scritture in produzione con approvazione per passo, cancellazioni in sandbox/pre-produzione, import massivi con template, esecuzione più rapida.

**Architecture:** un modulo `hooks/lib/autonomy.mjs` calcola il livello effettivo; `requiredApprovals` (unica tabella delle approvazioni, condivisa da guard-config-scope e step-check) riceve il livello; il catalogo delle azioni cambia insieme a validate-plan, guard-production, DT-026 e schema degli ambienti. Gli import massivi sono script deterministici (`kb template-learn`, `ops template-fill`, `ops import-result`) più un guard sull'upload legato all'impronta del file nel piano.

**Tech Stack:** Node ≥ 22 ESM, `node --test`, ajv, yaml, better-sqlite3; nessuna dipendenza nuova (zip scritto con `node:zlib`).

**Spec:** `plugin/docs/superpowers/specs/2026-10-06-autonomia-ops-design.md` (approvata dall'utente il 07/10/2026).

## Global Constraints

- Tutti i percorsi sono relativi a `plugin/` (radice del plugin); i comandi si lanciano da `plugin/`.
- Livelli: `alto` (predefinito) · `medio` · `basso`; tetto per ambiente: sandbox/dev/preprod `alto`, prod `medio`.
- Frasi dell'utente: `AUTONOMIA ALTA` · `AUTONOMIA MEDIA` · `AUTONOMIA BASSA` (maiuscole, intero prompt, come le altre frasi).
- File del cliente: `customers/<C>/config/autonomy.yaml` con `default: alto|medio|basso`; illeggibile o valore fuori elenco ⇒ `basso`.
- In produzione `sì` resta rifiutato; l'approvazione per passo è `APPROVO PASSO <n> <PLAN>`.
- In produzione le scritture valgono solo se l'ambiente ha `policy.write_data: true` (interruttore dell'utente in `environments.yaml`; oggi lo schema lo vieta, questo piano lo permette). ACT-DELETE in produzione: mai.
- Upload: solo un file dentro `customers/<C>/runs/<RUN attivo>/` con sha256 uguale a `step.file.sha256`.
- Mai committare, copiare o citare la cartella `JAGGAER DOC`; fixture solo sintetici.
- Prima di ogni commit: `node scripts/admin/integrity.mjs build` (il manifest d'integrità copre hook e script).
- Corpi degli agenti (`agents/*.md`) senza frasi letterali dell'utente (c'è un test).
- Commit con trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Messaggi all'utente e commenti in italiano, come il resto del codice.
- I numeri di riga citati sono indicativi: cercare il simbolo nominato.

## Review Focus

1. Un vecchio piano (senza `file`, senza `fields`) e una sessione con livello basso devono comportarsi come prima: `requiredApprovals` senza argomento `autonomy` deve dare esattamente l'esito di oggi (test in Task 4).
2. Livello abbassato con `AUTONOMIA BASSA` a metà piano: il passo successivo deve chiedere il `sì` anche se l'attivazione era avvenuta ad alto (test in Task 5).
3. Upload con un percorso relativo che risolve fuori dal run (`../`, maiuscole su Windows, file di sistema): negato (test in Task 9).
4. Produzione con `write_data: false` (valore attuale dei clienti): ogni scrittura resta negata anche con A1 e A3 (test in Task 6).
5. Un click su "Elimina" dentro un passo DELETE ma su un uid diverso dal SEL del passo: negato (test in Task 7).

---

### Task 1: Livello di autonomia — `hooks/lib/autonomy.mjs`

**Files:**
- Create: `hooks/lib/autonomy.mjs`
- Create: `schemas/autonomy.schema.json`
- Modify: `test/helpers/env-fixture.mjs` (`envWs` scrive `autonomy.yaml`, predefinito `basso` per non cambiare i test esistenti)
- Test: `test/hooks/autonomy.test.mjs`

**Interfaces:**
- Produces: `autonomyLevel({ ws, customer, records = [], envType }) → { level: "alto"|"medio"|"basso", chosen, source: "frase"|"cliente"|"predefinito", warning: string|null }`; `LEVELS = ["basso","medio","alto"]`; `capFor(envType) → "alto"|"medio"`; `minLevel(a, b)`; `autonomyFile(ws, customer)`.
- Produces (fixture): `envWs({ ..., autonomy = "basso" })` — `autonomy: null` non scrive il file (livello predefinito alto).

- [ ] **Step 1: test che fallisce**

```js
// test/hooks/autonomy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkWs } from "../helpers/hook-env.mjs";
import { autonomyLevel, capFor } from "../../hooks/lib/autonomy.mjs";

const ws0 = (yaml) => { const ws = mkWs(); mkdirSync(join(ws, "customers/ACME/config"), { recursive: true }); if (yaml != null) writeFileSync(join(ws, "customers/ACME/config/autonomy.yaml"), yaml); return ws; };

test("autonomia: frase > cliente > predefinito; tetto medio in produzione", () => {
  assert.deepEqual(autonomyLevel({ ws: ws0(null), customer: "ACME", envType: "preprod" }), { level: "alto", chosen: "alto", source: "predefinito", warning: null });
  assert.equal(autonomyLevel({ ws: ws0("default: medio\n"), customer: "ACME", envType: "sandbox" }).level, "medio");
  const recs = [{ kind: "autonomy", level: "basso" }, { kind: "A1", plan: "PLAN.X" }, { kind: "autonomy", level: "alto" }];
  assert.deepEqual(autonomyLevel({ ws: ws0("default: medio\n"), customer: "ACME", records: recs, envType: "preprod" }), { level: "alto", chosen: "alto", source: "frase", warning: null });
  assert.equal(autonomyLevel({ ws: ws0(null), customer: "ACME", envType: "prod" }).level, "medio");
  assert.equal(autonomyLevel({ ws: ws0(null), customer: "ACME", records: [{ kind: "autonomy", level: "basso" }], envType: "prod" }).level, "basso");
  assert.equal(capFor("dev"), "alto");
});

test("autonomia: file del cliente illeggibile o valore fuori elenco ⇒ basso con avviso", () => {
  for (const y of ["default: massimo\n", "{{{", "- alto\n"]) {
    const r = autonomyLevel({ ws: ws0(y), customer: "ACME", envType: "sandbox" });
    assert.equal(r.level, "basso", y); assert.match(r.warning, /autonomy\.yaml/);
  }
});
```

- [ ] **Step 2: eseguire e vedere il fallimento**

Run: `node --test test/hooks/autonomy.test.mjs`
Expected: FAIL — `Cannot find module '../../hooks/lib/autonomy.mjs'`.

- [ ] **Step 3: implementazione**

```js
// hooks/lib/autonomy.mjs
// Livello di autonomia di ops (spec 2026-10-06 §3.1, scelta dell'utente 06–07/10/2026): frase dell'utente nel registro
// delle approvazioni > customers/<C>/config/autonomy.yaml > "alto"; poi il tetto dell'ambiente (produzione: medio).
// Fail-closed: file del cliente illeggibile o fuori elenco ⇒ basso.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export const LEVELS = Object.freeze(["basso", "medio", "alto"]);
const rank = (l) => LEVELS.indexOf(l);
export const minLevel = (a, b) => (rank(a) <= rank(b) ? a : b);
export const capFor = (envType) => (envType === "prod" ? "medio" : "alto");
export const autonomyFile = (ws, customer) => join(ws, "customers", customer, "config", "autonomy.yaml");

function customerLevel(ws, customer) {
  const f = autonomyFile(ws, customer);
  if (!existsSync(f)) return { level: null, warning: null };
  try {
    const d = YAML.parse(readFileSync(f, "utf8"));
    if (d && typeof d === "object" && !Array.isArray(d) && LEVELS.includes(d.default)) return { level: d.default, warning: null };
  } catch { /* sotto: fail-closed */ }
  return { level: "basso", warning: `customers/${customer}/config/autonomy.yaml illeggibile o con un valore fuori elenco (alto, medio, basso): vale basso` };
}

export function autonomyLevel({ ws, customer, records = [], envType }) {
  const phrase = (Array.isArray(records) ? records : []).filter((r) => r && r.kind === "autonomy" && LEVELS.includes(r.level)).at(-1);
  let chosen; let source; let warning = null;
  if (phrase) { chosen = phrase.level; source = "frase"; }
  else {
    const c = customerLevel(ws, customer);
    if (c.level) { chosen = c.level; source = "cliente"; warning = c.warning; }
    else { chosen = "alto"; source = "predefinito"; }
  }
  return { level: minLevel(chosen, capFor(envType)), chosen, source, warning };
}
```

`schemas/autonomy.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "autonomy.schema.json",
  "title": "customers/<C>/config/autonomy.yaml — livello di autonomia predefinito di ops per il cliente",
  "description": "Spec 2026-10-06 §3.1: la frase AUTONOMIA ALTA|MEDIA|BASSA dell'utente vince per la sessione; in produzione il livello effettivo non supera medio. File scrivibile solo dall'utente (customers/*/config/**).",
  "type": "object",
  "required": ["default"],
  "additionalProperties": false,
  "properties": { "default": { "enum": ["alto", "medio", "basso"] } }
}
```

Fixture (`test/helpers/env-fixture.mjs`, `envWs`): parametro `autonomy = "basso"`; dopo la copia di `environments.yaml`:

```js
  if (autonomy) writeFileSync(join(ws, "customers/ACME/config/autonomy.yaml"), `default: ${autonomy}\n`);
```

- [ ] **Step 4: eseguire**

Run: `node --test test/hooks/autonomy.test.mjs`
Expected: PASS (2 test).

- [ ] **Step 5: commit**

```bash
node scripts/admin/integrity.mjs build
cd .. && git add plugin/hooks/lib/autonomy.mjs plugin/schemas/autonomy.schema.json plugin/test/hooks/autonomy.test.mjs plugin/test/helpers/env-fixture.mjs plugin/integrity.json
git commit -m "feat(ops): livello di autonomia (frase > cliente > alto, tetto medio in produzione)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Frasi `AUTONOMIA ALTA|MEDIA|BASSA`

**Files:**
- Modify: `scripts/admin/approvals.mjs` (`parseApprovalPrompt`, `phraseOf`, ramo di cattura come `explore`)
- Modify: `hooks/lib/guards/phrase.mjs` (`PHRASES`)
- Modify: `scripts/admin/session.mjs` (`use show` restituisce `autonomy`)
- Test: `test/hooks/autonomy-phrases.test.mjs`

**Interfaces:**
- Consumes: `autonomyLevel` (Task 1).
- Produces: record `{ kind: "autonomy", level }` nel registro delle approvazioni; `parseApprovalPrompt("AUTONOMIA ALTA") → { kind: "autonomy", level: "alto" }`; `phraseOf({ kind: "autonomy", level: "medio" }) === "AUTONOMIA MEDIA"`; `use show` → `{ ..., autonomy: { level, chosen, source, warning } }`.

- [ ] **Step 1: test che fallisce**

```js
// test/hooks/autonomy-phrases.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runHook, runSessionCli, decisionOf, ROOT } from "../helpers/hook-env.mjs";
import { envWs } from "../helpers/env-fixture.mjs";
import { parseApprovalPrompt, phraseOf, readApprovals, approvalsFile } from "../../scripts/admin/approvals.mjs";

function say(ws, tr, prompt) {
  appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: prompt }, timestamp: new Date().toISOString() })}\n`);
  return runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt, transcript_path: tr }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
}

test("frasi AUTONOMIA: parse, phraseOf, registrazione, use show; il modello non può scriverle", () => {
  assert.deepEqual(parseApprovalPrompt("AUTONOMIA ALTA"), { kind: "autonomy", level: "alto" });
  assert.deepEqual(parseApprovalPrompt("AUTONOMIA BASSA."), { kind: "autonomy", level: "basso" });
  assert.equal(parseApprovalPrompt("autonomia alta")?.kind, "attempt");
  assert.equal(phraseOf({ kind: "autonomy", level: "medio" }), "AUTONOMIA MEDIA");
  const ws = envWs({ env: "preprod", scope: "P2P", autonomy: null });
  const tr = join(mkdtempSync(join(tmpdir(), "au-")), "t.jsonl"); writeFileSync(tr, "");
  say(ws, tr, "AUTONOMIA MEDIA");
  const reg = readApprovals(approvalsFile(ws, "ACME", "sess-1"));
  assert.ok(reg.ok); assert.equal(reg.records.at(-1).kind, "autonomy"); assert.equal(reg.records.at(-1).level, "medio");
  const show = JSON.parse(runSessionCli(["use", "show", "--session", "sess-1", "--json"], { JVC_WORKSPACE: ws }).stdout);
  assert.deepEqual(show.autonomy, { level: "medio", chosen: "medio", source: "frase", warning: null });
  const g = runHook("guard-phrase", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo AUTONOMIA ALTA" } }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  assert.equal(decisionOf(g), "deny");
});
```

(Se `use show --json` non stampa JSON su stdout, adattare alla forma d'uscita reale di `session.mjs`.)

- [ ] **Step 2: eseguire e vedere il fallimento**

Run: `node --test test/hooks/autonomy-phrases.test.mjs`
Expected: FAIL — `parseApprovalPrompt("AUTONOMIA ALTA")` restituisce `null`.

- [ ] **Step 3: implementazione**

`scripts/admin/approvals.mjs`, accanto alle costanti delle frasi:

```js
// Autonomia di ops (spec 2026-10-06 §3.2): vale per la sessione finché l'utente non ne scrive un'altra.
const RE_AUTONOMY = /^AUTONOMIA (ALTA|MEDIA|BASSA)$/u;
const AUTONOMY_LEVEL = { ALTA: "alto", MEDIA: "medio", BASSA: "basso" };
const AUTONOMY_WORD = { alto: "ALTA", medio: "MEDIA", basso: "BASSA" };
```

In `parseApprovalPrompt`, prima di `if (RE_YES.test(bare))`:

```js
  if ((m = RE_AUTONOMY.exec(bare))) return { kind: "autonomy", level: AUTONOMY_LEVEL[m[1]] };
```

e prima di `if (/APPROV/iu.test(s) …`:

```js
  if (/\bAUTONOMIA\b/iu.test(s)) return { kind: "attempt" };
```

`phraseOf`: aggiungere il caso `r.kind === "autonomy" ? \`AUTONOMIA ${AUTONOMY_WORD[r.level] ?? ""}\`` prima di `r.kind === "explore"`.

Nel ramo di cattura, prima di `if (p.kind === "explore") {`:

```js
  if (p.kind === "autonomy") {
    if (!reg.ok) return reject([phraseOf(p)], `registro delle approvazioni corrotto (${reg.reason})`);
    rec = { kind: "autonomy", level: p.level };
    removeMatch = () => false;
  } else if (p.kind === "explore") {
```

Nel messaggio di conferma all'utente (stessa funzione, dopo l'append) per `rec.kind === "autonomy"`: `Autonomia ${rec.level} per questa sessione${s.env?.type === "prod" ? " (in produzione al massimo medio)" : ""}`.

`hooks/lib/guards/phrase.mjs`:

```js
export const PHRASES = /APPROVO\s+(PIANO|PROVA|PASSO|PURGE|PROMOZIONE|RETENTION)|ESPLORA\s+(SANDBOX|PREPROD)(\s+COMPLETA)?|AUTONOMIA\s+(ALTA|MEDIA|BASSA)/i;
```

(aggiornare il commento in testa: «e le frasi di autonomia AUTONOMIA ALTA|MEDIA|BASSA»).

`scripts/admin/session.mjs`, ramo `show`:

```js
    if (action === "show" || (action === "use" && what === "show")) {
      const { pointer, session } = loadOrExplain(ws, sid);
      const { autonomyLevel } = await import("../../hooks/lib/autonomy.mjs");
      const { readApprovals, approvalsFile } = await import("./approvals.mjs");
      const reg = readApprovals(approvalsFile(ws, session.customer, sid));
      const autonomy = autonomyLevel({ ws, customer: session.customer, records: reg.ok ? reg.records : [], envType: session.env?.type ?? "sandbox" });
      result = { session_id: sid, pointer, session, autonomy };
```

- [ ] **Step 4: eseguire**

Run: `node --test test/hooks/autonomy-phrases.test.mjs test/hooks/approvals-3a.test.mjs test/hooks/explore-complete.test.mjs`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
node scripts/admin/integrity.mjs build
cd .. && git add plugin/scripts/admin/approvals.mjs plugin/hooks/lib/guards/phrase.mjs plugin/scripts/admin/session.mjs plugin/test/hooks/autonomy-phrases.test.mjs plugin/integrity.json
git commit -m "feat(ops): frasi AUTONOMIA ALTA|MEDIA|BASSA, livello in use show" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Catalogo, schemi e validate-plan

**Files:**
- Modify: `hooks/lib/act-classes.mjs`
- Modify: `product/kb/actions/S.STD.XSC.ACT.00nn.yaml` delle classi cambiate (ACT-BULK `0014`, ACT-DELETE `0015`; le altre con `grep -l "code: ACT-" product/kb/actions/*.yaml`)
- Modify: `schemas/execution-plan.schema.json` (verbo `DELETE`; `file` su UPLOAD; `fields` su FILL)
- Modify: `schemas/environments.schema.json` (`prodPolicy.write_data` boolean)
- Modify: `scripts/decide/validate-plan.mjs`
- Modify: `docs/MANUAL.md` (§29.4, §52.1, ADR-06)
- Test: `test/decide/ops-veloce-catalog.test.mjs`; aggiornare `test/decide/action-catalog.test.mjs` e le asserzioni di `test/hooks/guard-production.test.mjs` che controllano il catalogo.

**Interfaces:**
- Produces: `ACT[cls].prod === "approval"` per CREATE, UPDATE, UPLOAD, SUBMIT, CLOSE, APPROVE, TRANSMIT, PUBLISH, CFG-CHANGE, BULK; `ACT["ACT-BULK"].preprod === "approval"`; `ACT["ACT-DELETE"]` = `{ effect: "write", risk: "R3", sandbox: "approval", preprod: "approval", prod: "never" }`.
- Produces (schema passo): `file: { path, sha256, rows }` obbligatorio con `verb: UPLOAD`; `fields: [{ target: SEL, value }]` ammesso con `verb: FILL` al posto di `target`.

- [ ] **Step 1: test che fallisce**

```js
// test/decide/ops-veloce-catalog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACT } from "../../hooks/lib/act-classes.mjs";
import { validatePlan } from "../../scripts/decide/validate-plan.mjs";

const SEL = "C.ACME.P2P.SEL.0001";
const plan = (steps) => ({ plan_id: "PLAN.ACME.T.1", customer: "ACME", env: "x", goal: "t", steps, repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } });

test("catalogo: produzione con approvazione, massivi in preprod, cancellazioni in sandbox/preprod", () => {
  for (const c of ["ACT-CREATE", "ACT-UPDATE", "ACT-UPLOAD", "ACT-SUBMIT", "ACT-CLOSE", "ACT-APPROVE", "ACT-TRANSMIT", "ACT-PUBLISH", "ACT-CFG-CHANGE", "ACT-BULK"]) assert.equal(ACT[c].prod, "approval", c);
  assert.equal(ACT["ACT-BULK"].preprod, "approval");
  assert.deepEqual([ACT["ACT-DELETE"].sandbox, ACT["ACT-DELETE"].preprod, ACT["ACT-DELETE"].prod], ["approval", "approval", "never"]);
});

test("validate-plan: DELETE ammesso in preprod e negato in prod; scritture in prod ammesse; UPLOAD con file; FILL con fields", () => {
  const del = plan([{ n: 1, verb: "DELETE", action_class: "ACT-DELETE", target: SEL, expect: { elements: [] } }]);
  assert.equal(validatePlan(del, { env: { type: "preprod", id: "x" } }).ok, true);
  assert.equal(validatePlan(del, { env: { type: "prod", id: "x" } }).ok, false);
  const wr = plan([{ n: 1, verb: "SAVE", action_class: "ACT-CREATE", target: SEL, expect: { page_sig: "p" } }]);
  assert.equal(validatePlan(wr, { env: { type: "prod", id: "x" } }).ok, true);
  const up = plan([{ n: 1, verb: "UPLOAD", action_class: "ACT-BULK", target: SEL, file: { path: "runs/RUN.ACME.20261007.1000.P2P/import/de.xlsx", sha256: "a".repeat(64), rows: 3 }, expect: { toast: "ok" } }]);
  assert.equal(validatePlan(up, { env: { type: "preprod", id: "x" } }).ok, true);
  const upNoFile = plan([{ n: 1, verb: "UPLOAD", action_class: "ACT-BULK", target: SEL, expect: { toast: "ok" } }]);
  assert.equal(validatePlan(upNoFile, { env: { type: "preprod", id: "x" } }).ok, false);
  const ff = plan([{ n: 1, verb: "FILL", action_class: "ACT-CREATE", fields: [{ target: SEL, value: "x" }, { target: "C.ACME.P2P.SEL.0002", value: 2 }], expect: { elements: [] } }]);
  assert.equal(validatePlan(ff, { env: { type: "sandbox", id: "x" } }).ok, true);
});
```

- [ ] **Step 2: eseguire e vedere il fallimento**

Run: `node --test test/decide/ops-veloce-catalog.test.mjs`
Expected: FAIL — `ACT["ACT-CREATE"].prod` è `"never"`.

- [ ] **Step 3: implementazione**

`hooks/lib/act-classes.mjs` (commento in testa: «Ops veloce, spec 2026-10-06 §3.3, scelta dell'utente 07/10/2026»):

```js
  "ACT-CREATE": row("write", "R1", "allowed", "allowed", "approval"),
  "ACT-UPDATE": row("write", "R1", "allowed", "allowed", "approval"),
  "ACT-UPLOAD": row("write", "R1/R2", "allowed", "allowed", "approval"),
  "ACT-SUBMIT": row("write", "R2", "allowed", "allowed", "approval"),
  "ACT-APPROVE": row("write", "R2", "allowed", "referent", "approval"),
  "ACT-TRANSMIT": row("write", "R2", "allowed", "referent", "approval"),
  "ACT-CLOSE": row("write", "R1/R2", "allowed", "allowed", "approval"),
  "ACT-PUBLISH": row("write", "R2", "allowed", "referent", "approval"),
  "ACT-CFG-READ": row("read", "R0", "allowed", "allowed", "allowed"),
  "ACT-CFG-CHANGE": row("config", "R2/R3", "approval", "approval", "approval"),
  "ACT-BULK": row("write", "R3", "approval", "approval", "approval"),
  "ACT-DELETE": row("write", "R3", "approval", "approval", "never"),
```

Item YAML delle classi cambiate: `environments` come sopra; `approvals`: classi dati `prod: 2`; ACT-CFG-CHANGE e ACT-BULK `prod: 3`; ACT-BULK `preprod: 1`; ACT-DELETE `sandbox: 1, preprod: 1, prod: null`, `risk: R3`, `verbs_allowed: [DELETE, CLICK, READ, VERIFY, CAPTURE, WAIT, NAVIGATE]`; `verbs_allowed` di ACT-BULK con `NAVIGATE, CLICK, UPLOAD, SUBMIT, READ, WAIT, VERIFY, CAPTURE`; in `sources` aggiungere `{ doc: docs/superpowers/specs/2026-10-06-autonomia-ops-design.md, section: "3.3" }`.

`schemas/execution-plan.schema.json`:
- `$defs.verb.enum` + `"DELETE"`; nella `description` iniziale: «DELETE (spec 2026-10-06 §3.7) solo con ACT-DELETE, in sandbox e pre-produzione».
- `$defs.step.properties`:

```json
        "file": {
          "type": "object", "required": ["path", "sha256", "rows"], "additionalProperties": false,
          "description": "UPLOAD (spec 2026-10-06 §3.8): file compilato del run; guard-config-scope carica solo questo percorso con questa impronta.",
          "properties": { "path": { "type": "string", "pattern": "^runs/RUN\\.[A-Z0-9]{4}\\.\\d{8}\\.\\d{4}\\.[A-Z0-9]{3}/" }, "sha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" }, "rows": { "type": "integer", "minimum": 1 } }
        },
        "fields": {
          "type": "array", "minItems": 1, "maxItems": 100,
          "description": "FILL in un colpo (spec §3.9): i campi della stessa pagina, ognuno col suo SEL; si esegue con fill_form.",
          "items": { "type": "object", "required": ["target", "value"], "additionalProperties": false, "properties": { "target": { "$ref": "#/$defs/sel" }, "value": {} } }
        },
```

- `allOf`: nel primo `if` togliere `FILL` e aggiungere `DELETE`; nuovi elementi:

```json
        { "if": { "properties": { "verb": { "const": "FILL" } } }, "then": { "anyOf": [{ "required": ["target"] }, { "required": ["fields"] }] } },
        { "if": { "properties": { "verb": { "const": "UPLOAD" } } }, "then": { "required": ["file"] } }
```

`schemas/environments.schema.json`, `$defs.prodPolicy.properties.write_data`: `{ "type": "boolean" }`; description: «§52.1 superato (spec 2026-10-06 §3.6): in produzione si scrive solo con write_data: true (interruttore dell'utente) e approvazione per passo; il rosso solo per oggetto in prod_allowed_red». Le `const: 3` delle approvazioni di configurazione restano. Aggiornare il commento della riga `write_data: false` di prod in `test/fixtures/env/environments.yaml`.

`scripts/decide/validate-plan.mjs`, ciclo dei passi:

```js
    const code = s?.action_class;
    if (!code) { errors.push(`${at}: action_class mancante (ogni passo appartiene a una classe del catalogo, §29.4)`); continue; }
    if (s?.verb === "DELETE" && code !== "ACT-DELETE") { errors.push(`${at}: il verbo DELETE vale solo con la classe ACT-DELETE`); continue; }
    const act = catalog.get(code);
    if (!act) { policy.push(`${at}: classe di azione fuori catalogo: ${code}`); continue; }
    if (!type) continue;
    const adm = act.environments?.[col];
    if (adm === "never") policy.push(`${at}: ${code} non è ammessa in ${type} (§29.4, spec 2026-10-06 §3.3)`);
    if (adm === "referent") warnings.push(`${at}: ${code} in ${type} solo con referente presente`);
    if (adm === "approval") warnings.push(`${at}: ${code} in ${type} solo con approvazione esplicita`);
```

(togliere le righe «DELETE non esiste», «ACT-DELETE non è ammessa in nessun ambiente», «scrive dati: in prod mai», `adm === "3A"`; il resto del ciclo resta). Aggiornare `HELP`.

`docs/MANUAL.md`: §29.4 tabella nuova; §52.1 «in produzione si scrive solo con `write_data: true` e approvazione per passo»; ADR-06 «superato in sandbox/pre-produzione dal verbo DELETE (spec 2026-10-06)».

- [ ] **Step 4: eseguire**

Run: `node --test test/decide/ops-veloce-catalog.test.mjs test/decide/action-catalog.test.mjs test/hooks/guard-production.test.mjs test/decide/compose-plan.test.mjs`
Expected: il nuovo test PASS. Nei test esistenti aggiornare **solo** le asserzioni sul catalogo (`never` delle classi cambiate, DELETE ovunque vietato) e scriverle nel messaggio di commit. Le asserzioni di guard-production sul comportamento a runtime cambiano nel Task 6: se falliscono qui, marcarle `{ todo: "Task 6" }` e togliere il `todo` lì.

- [ ] **Step 5: commit**

```bash
node scripts/admin/integrity.mjs build
cd .. && git add plugin/hooks/lib/act-classes.mjs plugin/product/kb/actions plugin/schemas/execution-plan.schema.json plugin/schemas/environments.schema.json plugin/scripts/decide/validate-plan.mjs plugin/docs/MANUAL.md plugin/test plugin/integrity.json
git commit -m "feat(ops): catalogo — produzione con approvazione, massivi in preprod/prod, DELETE in sandbox/preprod; UPLOAD con file, FILL con fields" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `requiredApprovals` per livello (guard-config-scope + step-check)

**Files:**
- Modify: `hooks/lib/guards/config-scope.mjs` (`requiredApprovals`, controllo prod, sezione «(d) approvazioni»)
- Modify: `scripts/decide/step-check.mjs` (`gateStep`, `check`)
- Test: `test/hooks/autonomy-approvals.test.mjs`

**Interfaces:**
- Consumes: `autonomyLevel` (Task 1), catalogo (Task 3).
- Produces: `requiredApprovals(cls, step, env, cfgLevel, autonomy = "basso") → { a1, a2, a3, action }`; `gateStep({ plan, step, env, records, now, planFile, autonomy = "basso" })`; in `check`, la variabile `aut = autonomyLevel(...)` disponibile al resto della funzione (Task 5 la usa).

- [ ] **Step 1: test che fallisce**

```js
// test/hooks/autonomy-approvals.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { requiredApprovals } from "../../hooks/lib/guards/config-scope.mjs";

const E = (type, policy = {}) => ({ type, id: type, policy: { approvals: { config_verde: 1, config_giallo: 2, config_rosso: 3 }, ...policy } });
const R2 = { verb: "SUBMIT", risk: "R2" };
const r = (cls, step, env, aut, lvl = "verde") => { const x = requiredApprovals(cls, step, env, lvl, aut); return Object.entries(x).filter(([, v]) => v).map(([k]) => k).join("+") || "-"; };

test("requiredApprovals: senza livello = comportamento di oggi (basso)", () => {
  assert.equal(r("ACT-SUBMIT", R2, E("sandbox")), "action");
  assert.equal(r("ACT-BULK", {}, E("sandbox")), "a1+a3");
  assert.equal(r("ACT-CFG-CHANGE", {}, E("preprod"), undefined, "giallo"), "a1+a3");
  assert.equal(r("ACT-CREATE", {}, E("preprod")), "-");
});

test("requiredApprovals: tabella 2.2 della spec", () => {
  assert.equal(r("ACT-SUBMIT", R2, E("sandbox"), "alto"), "-");
  assert.equal(r("ACT-SUBMIT", R2, E("sandbox"), "medio"), "-");
  assert.equal(r("ACT-BULK", {}, E("sandbox"), "alto"), "-");
  assert.equal(r("ACT-BULK", {}, E("sandbox"), "medio"), "a1+a3");
  assert.equal(r("ACT-CFG-CHANGE", {}, E("sandbox"), "alto", "rosso"), "a1");
  assert.equal(r("ACT-DELETE", {}, E("sandbox"), "alto"), "a1");
  assert.equal(r("ACT-DELETE", {}, E("preprod"), "medio"), "a1+a3");
  assert.equal(r("ACT-SUBMIT", R2, E("preprod"), "alto"), "a1");
  assert.equal(r("ACT-SUBMIT", R2, E("preprod"), "medio"), "a1");
  assert.equal(r("ACT-SUBMIT", R2, E("preprod"), "basso"), "action");
  assert.equal(r("ACT-BULK", {}, E("preprod"), "alto"), "-");
  assert.equal(r("ACT-CFG-CHANGE", {}, E("preprod", { second_approver_required: true }), "alto", "rosso"), "a1+a2");
  assert.equal(r("ACT-CREATE", {}, E("prod"), "medio"), "a1+a2+a3");
  assert.equal(r("ACT-CREATE", {}, E("prod", { second_approver_required: false }), "medio"), "a1+a3");
  assert.equal(r("ACT-BULK", {}, E("prod", { second_approver_required: false }), "basso"), "a1+a3");
  assert.equal(r("ACT-READ", {}, E("prod"), "medio"), "-");
});
```

- [ ] **Step 2: eseguire e vedere il fallimento**

Run: `node --test test/hooks/autonomy-approvals.test.mjs`
Expected: FAIL nel secondo test.

- [ ] **Step 3: implementazione**

`hooks/lib/guards/config-scope.mjs`:

```js
// Approvazioni richieste per il passo → { a1, a2, a3, action } (a3 = APPROVO PASSO n). Esportata per step-check (K6.1).
// Ops veloce (spec 2026-10-06 §2.2, §3.4): dipende dal livello di autonomia; senza livello vale "basso" (= regole di prima).
export function requiredApprovals(cls, step, env, level, autonomy = "basso") {
  const none = { a1: false, a2: false, a3: false, action: false };
  if (env.type === "prod") {
    if (ACT[cls]?.prod !== "approval") return none;
    const second = env.policy?.second_approver_required ?? true;
    return { a1: true, a2: second, a3: true, action: false };
  }
  const sandbox = env.type !== "preprod";
  if (cls === "ACT-CFG-CHANGE") {
    if (autonomy === "alto") return { ...none, a1: true, a2: !!env.policy?.second_approver_required };
    const n = env.policy?.approvals?.[`config_${level}`] ?? 3;
    return { a1: n >= 1, a2: n >= 3, a3: n >= 2, action: false };
  }
  if (cls === "ACT-BULK") return autonomy === "alto" ? none : { ...none, a1: true, a3: true };
  if (cls === "ACT-DELETE") return autonomy === "alto" ? { ...none, a1: true } : { ...none, a1: true, a3: true };
  if (R2_DATA.has(cls) && ["R2", "R3"].includes(stepRisk(step))) {
    if (autonomy === "basso") return { ...none, action: true };
    return sandbox ? none : { ...none, a1: true };
  }
  return none;
}
```

Nel guard del passo attivo sostituire

```js
  if (info.effect === "write" && env.type === "prod") return no(`${at}: in produzione non si scrivono dati; posso farlo in sandbox o pre-produzione (§52.1)`);
```

con

```js
  if (env.type === "prod" && info.effect !== "read" && env.policy?.write_data !== true) return no(`${at}: in produzione le scritture sono spente per l'ambiente ${env.id} (policy.write_data: false in environments.yaml)`);
```

Sezione «(d) approvazioni»: leggere il registro prima di `requiredApprovals`:

```js
  // (d) approvazioni
  const file = approvalsFile(ctx.ws, ctx.customer, ctx.sid);
  const reg = readApprovals(file);
  if (!reg.ok) return no(`registro delle approvazioni corrotto (${reg.reason}): nessuna approvazione è valida`);
  const aut = autonomyLevel({ ws: ctx.ws, customer: ctx.customer, records: reg.records, envType: env.type });
  const req = requiredApprovals(cls, step, env, level, aut.level);
  if (!req.a1 && !req.a2 && !req.a3 && !req.action) {
    if (GUARDED_CLASSES.has(cls)) {
      try { appendAudit(ctx.ws, { session: ctx.sid, customer: ctx.customer, scope: s.scope ?? null, kind: "decision", actor: `hook:${G}`, payload: { decision: "allow", tool: ctx.tool, plan: ap.plan_id, step: step.n, autonomy: aut.level, autonomy_source: aut.source } }); } catch { /* l'audit non cambia la decisione */ }
    }
    return null;
  }
```

togliendo le vecchie dichiarazioni `file`/`reg` che seguivano. Import: `import { autonomyLevel } from "../autonomy.mjs";`. Messaggio «manca il token del passo»: aggiungere `${env.type === "prod" ? " (in produzione ogni passo che modifica o carica si approva prima)" : ""}`.

`scripts/decide/step-check.mjs`:

```js
export function gateStep({ plan, step, env, records, now, planFile, autonomy = "basso" }) {
  ...
  const req = requiredApprovals(cls, step, env, level, autonomy);
```

In `check`, dopo `const reg = readApprovals(approvalsFile(ws, customer, sid));` e il controllo `reg.ok`:

```js
  const aut = autonomyLevel({ ws, customer, records: reg.records, envType: session.env.type });
```

e `autonomy: aut.level` in ogni chiamata a `gateStep({...})`. Import: `import { autonomyLevel } from "../../hooks/lib/autonomy.mjs";`.

- [ ] **Step 4: eseguire**

Run: `node --test test/hooks/autonomy-approvals.test.mjs test/decide/step-check.test.mjs test/hooks/approvals-3a.test.mjs`
Expected: PASS (i test esistenti girano con `autonomy.yaml: default: basso` scritto da `envWs`).

- [ ] **Step 5: commit**

```bash
node scripts/admin/integrity.mjs build
cd .. && git add plugin/hooks/lib/guards/config-scope.mjs plugin/scripts/decide/step-check.mjs plugin/test/hooks/autonomy-approvals.test.mjs plugin/integrity.json
git commit -m "feat(ops): approvazioni per livello di autonomia (tabella unica per guard e step-check)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Attivazione del piano per livello (`planApproval`)

**Files:**
- Modify: `scripts/decide/step-check.mjs`
- Test: `test/decide/autonomy-step-check.test.mjs`

**Interfaces:**
- Consumes: `requiredApprovals(…, autonomy)`, `aut` (Task 4), `stepLevel` (`hooks/lib/act-classes.mjs`).
- Produces: `planNeedsApproval(plan, env, autonomy) → boolean` (esportata; la usa anche l'intento nel Task 8).

- [ ] **Step 1: test che fallisce**

Prima leggere `test/helpers/k6-fixture.mjs` (`demoPlan`, `demoAtlas`, `PLAN`): se `demoPlan()` non ha un passo ACT-SUBMIT con `risk: "R2"`, costruirne una variante con un passo `{ verb: "SUBMIT", action_class: "ACT-SUBMIT", risk: "R2", target: <SEL del demo con effect write>, expect: { page_sig: "<pagina del demo>" } }` in coda.

```js
// test/decide/autonomy-step-check.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { envWs, writePlan, readSession } from "../helpers/env-fixture.mjs";
import { runHook, ROOT } from "../helpers/hook-env.mjs";
import { check, gateStep, planNeedsApproval } from "../../scripts/decide/step-check.mjs";
import { readApprovals, approvalsFile } from "../../scripts/admin/approvals.mjs";
import { autonomyLevel } from "../../hooks/lib/autonomy.mjs";
import { demoAtlas, demoPlan, PLAN } from "../helpers/k6-fixture.mjs";

const RUN = "RUN.ACME.20261007.1000.ADM";
const say = (ws, tr, prompt) => { appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: prompt }, timestamp: new Date().toISOString() })}\n`); return runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt, transcript_path: tr }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT }); };
const withSubmit = () => { const p = demoPlan(); return p.steps.some((s) => s.action_class === "ACT-SUBMIT") ? p : p; /* adattare come sopra */ };

test("planNeedsApproval: preprod alto solo creazione ⇒ no; con R2 ⇒ sì; prod sempre; basso fuori sandbox sempre; sandbox basso mai", () => {
  const p = withSubmit();
  const create = { ...p, steps: p.steps.filter((s) => !["ACT-SUBMIT", "ACT-APPROVE", "ACT-TRANSMIT", "ACT-PUBLISH"].includes(s.action_class)) };
  assert.equal(planNeedsApproval(create, { type: "preprod", policy: {} }, "alto"), false);
  assert.equal(planNeedsApproval(p, { type: "preprod", policy: {} }, "alto"), true);
  assert.equal(planNeedsApproval(create, { type: "prod", policy: {} }, "medio"), true);
  assert.equal(planNeedsApproval(create, { type: "preprod", policy: {} }, "basso"), true);
  assert.equal(planNeedsApproval(create, { type: "sandbox", policy: {} }, "basso"), false);
});

test("preprod alto: una sola APPROVO PIANO, SUBMIT senza sì; AUTONOMIA BASSA a metà ⇒ il passo R2 chiede il sì", async () => {
  const ws = envWs({ env: "preprod", scope: "P2P", autonomy: null });
  demoAtlas(ws);
  const plan = withSubmit();
  const file = writePlan(ws, plan, RUN);
  const tr = join(mkdtempSync(join(tmpdir(), "as-")), "t.jsonl"); writeFileSync(tr, "");
  const a0 = await check({ ws, customer: "ACME", sid: "sess-1", planFile: file, step: 1, snapshot: null });
  assert.equal(a0.status, "approval_required"); assert.match(a0.ask, /APPROVO PIANO/);
  say(ws, tr, `APPROVO PIANO ${PLAN}`);
  const a1 = await check({ ws, customer: "ACME", sid: "sess-1", planFile: file, step: 1, snapshot: null });
  assert.notEqual(a1.status, "approval_required", JSON.stringify(a1));
  const r2 = plan.steps.find((s) => s.action_class === "ACT-SUBMIT");
  const env = readSession(ws).env;
  const recs = readApprovals(approvalsFile(ws, "ACME", "sess-1")).records;
  assert.equal(gateStep({ plan, step: r2, env, records: recs, now: new Date(), planFile: file, autonomy: "alto" }).status, "ok");
  say(ws, tr, "AUTONOMIA BASSA");
  const recs2 = readApprovals(approvalsFile(ws, "ACME", "sess-1")).records;
  const lvl = autonomyLevel({ ws, customer: "ACME", records: recs2, envType: "preprod" }).level;
  assert.equal(lvl, "basso");
  assert.equal(gateStep({ plan, step: r2, env, records: recs2, now: new Date(), planFile: file, autonomy: lvl }).status, "approval_required");
});
```

- [ ] **Step 2: eseguire e vedere il fallimento**

Run: `node --test test/decide/autonomy-step-check.test.mjs`
Expected: FAIL — `planNeedsApproval` non esportata.

- [ ] **Step 3: implementazione**

```js
// Ops veloce (spec 2026-10-06 §3.5): serve APPROVO PIANO all'attivazione? Produzione sempre; basso come prima (fuori
// sandbox sì); medio fuori sandbox sì; alto solo se un passo chiede A1/A2/A3 (il "sì" di un passo R2 resta per passo).
export function planNeedsApproval(plan, env, autonomy) {
  const sandbox = ["sandbox", "dev"].includes(env.type);
  if (env.type === "prod") return true;
  if (autonomy === "basso") return !sandbox;
  if (!sandbox && autonomy !== "alto") return true;
  return stepsOf(plan).some((s) => {
    const r = requiredApprovals(s.action_class, s, env, s.action_class === "ACT-CFG-CHANGE" ? stepLevel(s) : null, autonomy);
    return r.a1 || r.a2 || r.a3;
  });
}
```

In `planApproval`: `if (active || sandbox || planApproved()) return null;` → `if (active || !planNeedsApproval(plan, session.env, aut.level) || planApproved()) return null;`. Import di `stepLevel` se manca. Nota: il ramo `basso` riproduce esattamente la regola di oggi (sandbox senza A1 all'attivazione).

- [ ] **Step 4: eseguire**

Run: `node --test test/decide/autonomy-step-check.test.mjs test/decide/step-check.test.mjs`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
node scripts/admin/integrity.mjs build
cd .. && git add plugin/scripts/decide/step-check.mjs plugin/test/decide/autonomy-step-check.test.mjs plugin/integrity.json
git commit -m "feat(ops): attivazione del piano per livello di autonomia" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Produzione scrivibile — guard-production

**Files:**
- Modify: `hooks/lib/guards/production.mjs`
- Modify: `scripts/admin/approvals.mjs` (`prodStepApproval`)
- Modify: `test/hooks/guard-production.test.mjs` (togliere i `todo` del Task 3; le asserzioni di rifiuto restano per `write_data: false` e per azioni fuori piano)
- Test: `test/hooks/prod-writes.test.mjs`

**Interfaces:**
- Produces: `prodStepApproval(records, plan, n, envPolicy, now, { graceMs = 30000 }) → { ok, reason, used }` — A1 (finestra) + token del passo; con `second_approver_required` delega a `threeAState`.

- [ ] **Step 1: test che fallisce**

```js
// test/hooks/prod-writes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { prodStepApproval } from "../../scripts/admin/approvals.mjs";

test("prodStepApproval: A1 + passo, A2 solo col secondo approvatore", () => {
  const t = new Date().toISOString();
  const A1 = { kind: "A1", plan: "PLAN.P", ts: t, hash: "h1", approver_declared: "Anna Bianchi" };
  const A3 = { kind: "A3", plan: "PLAN.P", step: 2, ts: t, hash: "h3" };
  assert.equal(prodStepApproval([A1, A3], "PLAN.P", 2, { second_approver_required: false }, Date.now()).ok, true);
  assert.equal(prodStepApproval([A1], "PLAN.P", 2, { second_approver_required: false }, Date.now()).ok, false);
  assert.equal(prodStepApproval([A1, A3], "PLAN.P", 2, { second_approver_required: true }, Date.now()).ok, false);
});
```

Secondo test nello stesso file, costruito con le funzioni di `test/hooks/guard-production.test.mjs` (`envWs({ env: "prod" })`, `writeSel(ws, code, { effect: "write" })`, `sealActivePlan`, `browserCall("guard-production", …)`, transcript come in `test/hooks/approvals-3a.test.mjs`), su un piano con passo `SAVE` ACT-CREATE legato al SEL:
1. fixture con `write_data: false` ⇒ `decisionOf` = `deny`, ragione `/write_data/`, anche dopo `APPROVO PIANO` e `APPROVO PASSO 1`;
2. `patchSession` (`s.env.policy.write_data = true; s.env.policy.second_approver_required = false`) e approvazioni registrate ⇒ consentito (`decisionOf` = `null`);
3. senza piano attivo ⇒ `deny`;
4. passo DELETE in produzione ⇒ `deny`.

- [ ] **Step 2: eseguire e vedere il fallimento**

Run: `node --test test/hooks/prod-writes.test.mjs`
Expected: FAIL — `prodStepApproval` non esportata.

- [ ] **Step 3: implementazione**

`scripts/admin/approvals.mjs`, accanto a `threeAState`:

```js
// Ops veloce (spec 2026-10-06 §3.6): approvazione di un passo che scrive in produzione — A1 (finestra) + token del
// passo; A2 solo se l'ambiente richiede il secondo approvatore. Il consumo monouso lo fa guard-config-scope (grazia 30 s).
export function prodStepApproval(records, plan, n, envPolicy = {}, now = Date.now(), { graceMs = 30000 } = {}) {
  if (envPolicy?.second_approver_required) return threeAState(records, plan, n, envPolicy, now, { graceMs });
  const w = windowState(null, plan, envPolicy, now, { records });
  if (!w.a1) return { ok: false, reason: `manca A1: \`APPROVO PIANO ${plan}\``, used: [] };
  if (w.expired) return { ok: false, reason: `finestra scaduta: si riparte da \`APPROVO PIANO ${plan}\``, used: [] };
  let tok = w.tokenForStep(n);
  if (!tok) {
    const all = records.filter((r) => r.plan === plan);
    const t1 = Date.parse(w.a1.ts);
    const recent = new Set(all.filter((r) => r.kind === "consume" && r.step === n && now - Date.parse(r.ts) <= graceMs).map((r) => r.ref));
    tok = all.find((r) => r.kind === "A3" && r.step === n && recent.has(r.hash) && Date.parse(r.ts) >= t1) ?? null;
  }
  if (!tok) return { ok: false, reason: `manca l'approvazione del passo: \`APPROVO PASSO ${n} ${plan}\``, used: [] };
  return { ok: true, reason: null, used: [w.a1, tok] };
}
```

`hooks/lib/guards/production.mjs` (commento in testa aggiornato: «spec 2026-10-06 §3.6: scritture solo dentro un passo di piano approvato, con write_data: true; DELETE mai»):

```js
export const PROD_NO_WRITE = "In produzione si scrive solo dentro un passo di piano approvato (APPROVO PIANO + APPROVO PASSO n) e con policy.write_data: true";

async function prodWrite(ctx, st, env) {
  if (env.policy?.write_data !== true) return `scritture spente in produzione per l'ambiente ${env.id} (policy.write_data: false in environments.yaml)`;
  const reg = readApprovals(approvalsFile(ctx.ws, ctx.customer, ctx.sid));
  if (!reg.ok) return `registro delle approvazioni corrotto (${reg.reason})`;
  const policy = { ...env.policy, second_approver_required: env.policy?.second_approver_required ?? true };
  const s = prodStepApproval(reg.records, st.ap.plan_id, st.step.n, policy, Date.now());
  if (!s.ok) return `in produzione ogni passo che modifica o carica si approva prima: ${s.reason}`;
  if (s.used[0].plan_sha256 && s.used[0].plan_sha256 !== st.sha256) return `il piano è cambiato dopo A1: serve una nuova \`APPROVO PIANO ${st.ap.plan_id}\``;
  const c = confirmInTranscript(ctx.input.transcript_path, s.used);
  if (!c.ok) return `approvazione non confermata dal transcript dell'utente (${c.reason})`;
  return null;
}

export const decide = browserGuarded(G, async (ctx, no) => {
  const s = ctx.session;
  if (s?.env?.type !== "prod") return null;
  const { env, reason } = declaredEnv(ctx);
  if (!env) return no(reason);
  if (env.type !== "prod") return no("ambiente di sessione incoerente con environments.yaml: riesegui /use env");
  let st = null;
  if (s.active_plan) { st = await activeStep(ctx); if (st.reason) return no(st.reason); }
  const cls = st?.step?.action_class;
  const writeStep = !!cls && ACT[cls]?.prod === "approval";
  // upload, invio e conferma del dialogo valgono solo dentro un passo di scrittura (approvato sotto)
  for (const a of ctx.actions) {
    if (writeStep && (a.kind === "upload" || a.submits)) continue;
    const r = alwaysDenied(a, env); if (r) return no(r);
  }
  const touches = ctx.actions.filter((a) => a.kind === "input" || a.kind === "click" || a.kind === "upload" || a.submits);
  if (!touches.length) return null;
  if (!st) return no(`nessun piano attivo: in produzione input, click e caricamenti solo dentro un passo di piano. ${PROD_NO_WRITE}`);
  const { step } = st;
  const at = `passo ${step.n} (${step.verb}, ${cls ?? "senza classe"})`;
  if (cls === "ACT-DELETE") return no(`${at}: in produzione non si cancella mai`);
  if (writeStep) { const r = await prodWrite(ctx, st, env); return r ? no(`${at}: ${r}`) : null; }
  if (!READ_CLASSES.has(cls)) return no(`${at}: ${cls ?? "classe mancante"} non è ammessa in produzione. ${PROD_NO_WRITE}`);
  if (typeof step.target !== "string") return no(`${at}: il passo non punta a una voce dell'Atlas (SEL): in produzione input e click solo su selettori dichiarati`);
  const sel = await readSel(ctx, step.target);
  if (!sel) return no(`${at}: ${step.target} non è nell'Atlas del cliente o del prodotto: negato`);
  for (const a of touches) {
    if (a.kind === "input") {
      if (!INPUT_VERBS.has(step.verb) || sel.role !== "search_box") return no(`${at}: in produzione, fuori dai passi di scrittura, si scrive solo in un campo di ricerca dichiarato (search_box). ${PROD_NO_WRITE}`);
    } else if (!CLICK_VERBS.has(step.verb) || sel.effect !== "read") {
      return no(`${at}: click su ${sel.code} con effect ${sel.effect ?? "ignoto"}: fuori dai passi di scrittura solo target di sola lettura. ${PROD_NO_WRITE}`);
    }
  }
  return null;
});
```

Togliere `prodConfig`; import `prodStepApproval` al posto di `threeAState`.

- [ ] **Step 4: eseguire**

Run: `node --test test/hooks/prod-writes.test.mjs test/hooks/guard-production.test.mjs test/hooks/approvals-3a.test.mjs`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
node scripts/admin/integrity.mjs build
cd .. && git add plugin/hooks/lib/guards/production.mjs plugin/scripts/admin/approvals.mjs plugin/test plugin/integrity.json
git commit -m "feat(ops): produzione scrivibile con write_data e approvazione per passo; DELETE mai in prod" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Cancellazioni dentro un passo DELETE

**Files:**
- Modify: `hooks/lib/guards/config-scope.mjs`
- Modify: `scripts/decide/step-check.mjs` (`gateStep`)
- Test: `test/hooks/delete-step.test.mjs`

**Interfaces:**
- Consumes: `isDeleteLabel` (`hooks/lib/effect-labels.mjs`), `bindingRefusal` (esistente).
- Produces: `COMMIT_VERBS` con `DELETE`; `GUARDED_CLASSES` e `COMP_CLASSES` con `ACT-DELETE` (e `ACT-BULK` in `COMP_CLASSES`).

- [ ] **Step 1: test che fallisce**

`test/hooks/delete-step.test.mjs`, quattro casi costruiti come `test/decide/step-check.test.mjs` (`envWs({ env: "preprod", scope: "P2P", autonomy: "alto" })`, `demoAtlas`, `writePlan`, `check`, `browserCall("guard-config-scope", …)`, `patchSession` per `browser.snapshot.names`):
1. passo `{ verb: "DELETE", action_class: "ACT-DELETE", target: <SEL "Elimina">, expect: { elements: [] } }` senza `compensations` ⇒ `check` all'attivazione del passo: `status: "denied"`, `reason` `/restore/`;
2. con `compensations: [{ step: n, kind: "restore", ref: "runs/<RUN>/evidence/before.json" }]`, file presente, `APPROVO PIANO` registrata ⇒ click sull'uid del SEL "Elimina" consentito;
3. passo SAVE (ACT-CREATE) attivo, click su un uid il cui nome nello snapshot è "Elimina riga" ⇒ `deny`, `/cancellazione/`;
4. passo DELETE attivo, click su un uid diverso dal SEL del passo con nome "Elimina" ⇒ `deny`.

- [ ] **Step 2: eseguire e vedere il fallimento**

Run: `node --test test/hooks/delete-step.test.mjs`
Expected: FAIL (oggi DELETE non è nemmeno nel vocabolario prima del Task 3; dopo il Task 3, casi 1 e 3 falliscono).

- [ ] **Step 3: implementazione**

`hooks/lib/guards/config-scope.mjs`:

```js
export const COMMIT_VERBS = new Set(["SAVE", "SUBMIT", "TOGGLE", "UPLOAD", "DELETE"]);
export const GUARDED_CLASSES = new Set(["ACT-CFG-CHANGE", "ACT-SUBMIT", "ACT-APPROVE", "ACT-TRANSMIT", "ACT-PUBLISH", "ACT-BULK", "ACT-CREATE", "ACT-UPDATE", "ACT-CLOSE", "ACT-UPLOAD", "ACT-DELETE"]);
const COMP_CLASSES = new Set(["ACT-CREATE", "ACT-UPDATE", "ACT-SUBMIT", "ACT-BULK", "ACT-DELETE"]);
```

Dopo `const bind = bindingRefusal(ctx, step); if (bind) return no(…);`:

```js
  // spec 2026-10-06 §3.7: un click su un'etichetta di cancellazione vale solo dentro un passo DELETE del piano
  if (cls !== "ACT-DELETE") {
    const names = s.browser?.snapshot?.names ?? {};
    for (const a of ctx.actions.filter((x) => x.kind === "click" || x.kind === "input")) {
      for (const r of Array.isArray(a.targets) ? a.targets : []) {
        const name = Object.hasOwn(names, r) ? String(names[r] ?? "") : "";
        if (name && isDeleteLabel(name)) return no(`${at0}: "${name}" è una cancellazione: solo dentro un passo DELETE del piano`);
      }
    }
  }
```

Nella sezione «(a) compensazione»:

```js
    if (cls === "ACT-DELETE" && !comps.some((c) => c?.plan === ap.plan_id && c.step === step.n && c.kind === "restore" && c.ref)) {
      return no(`${at}: prima di cancellare serve la lettura completa dell'oggetto salvata nel run (compensazione restore con ref)`);
    }
```

`scripts/decide/step-check.mjs`, `gateStep`, dopo il blocco della compensazione:

```js
  if (cls === "ACT-DELETE") {
    const c = (Array.isArray(plan.compensations) ? plan.compensations : []).find((x) => x && x.step === step.n);
    const ref = c?.kind === "restore" && typeof c.ref === "string" ? c.ref : null;
    const custDir = planFile ? resolve(dirname(planFile), "..", "..") : null;
    const abs = ref && custDir ? resolve(custDir, ref) : null;
    const ok = !!abs && /^runs\/RUN\.[A-Z0-9]{4}\.\d{8}\.\d{4}\.[A-Z0-9]{3}\/evidence\//.test(ref) && abs.startsWith(join(custDir, "runs")) && existsSync(abs);
    if (!ok) return { ...out, status: "denied", reason: `${at}: prima di cancellare serve la lettura completa dell'oggetto in runs/<RUN>/evidence/ (compensazione restore con ref)` };
  }
```

(import `resolve`, `dirname`, `join`, `existsSync` se mancano).

- [ ] **Step 4: eseguire**

Run: `node --test test/hooks/delete-step.test.mjs test/hooks/explore-complete.test.mjs test/hooks/explore-complete-review.test.mjs test/decide/step-check.test.mjs`
Expected: PASS (l'esplorazione continua a negare ogni cancellazione).

- [ ] **Step 5: commit**

```bash
node scripts/admin/integrity.mjs build
cd .. && git add plugin/hooks/lib/guards/config-scope.mjs plugin/scripts/decide/step-check.mjs plugin/test/hooks/delete-step.test.mjs plugin/integrity.json
git commit -m "feat(ops): cancellazioni solo dentro un passo DELETE, con lettura salvata prima (restore)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Intento (DT-026) per livello e produzione

**Files:**
- Modify: `decision-tables/DT-026.yaml`
- Modify: `scripts/decide/intent.mjs`
- Test: `test/decide/autonomy-intent.test.mjs`; aggiornare `test/decide/intent.test.mjs` e `test/decide/dt-catalog.test.mjs` nei casi prod e DELETE.

**Interfaces:**
- Consumes: `autonomyLevel`, `ACT`.
- Produces: input DT-026 `needs_approval` (boolean, default `true`); esiti: prod scrittura ⇒ `mostra-piano`; ACT-DELETE in prod ⇒ `rifiuta`; ACT-DELETE in sandbox/preprod ⇒ `mostra-piano`; `needs_approval: false` ⇒ `avvia`; l'intento accetta l'opzione `autonomy` (altrimenti la calcola dalla sessione).

- [ ] **Step 1: test che fallisce**

Prima: `grep -n "^export" scripts/decide/intent.mjs` per il nome della funzione che restituisce `{ outcome, reason, … }` e le sue opzioni; usarlo al posto di `classifyIntent`.

```js
// test/decide/autonomy-intent.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../../scripts/decide/intent.mjs";

test("intento: preprod alto crea ⇒ avvia; con invio ⇒ mostra-piano; basso ⇒ mostra-piano; prod crea ⇒ mostra-piano; prod cancella ⇒ rifiuta; preprod cancella ⇒ mostra-piano", () => {
  const o = (text, autonomy = "alto") => classifyIntent(text, { customers: ["ACME"], autonomy }).outcome;
  assert.equal(o("su ACME pre-produzione crea un ordine di 3 sedie"), "avvia");
  assert.equal(o("su ACME pre-produzione crea e invia un ordine di 3 sedie"), "mostra-piano");
  assert.equal(o("su ACME pre-produzione crea un ordine di 3 sedie", "basso"), "mostra-piano");
  assert.equal(o("su ACME produzione crea un ordine di 3 sedie"), "mostra-piano");
  assert.equal(o("su ACME produzione cancella la RdA 10045"), "rifiuta");
  assert.equal(o("su ACME pre-produzione cancella la RdA 10045"), "mostra-piano");
});
```

- [ ] **Step 2: eseguire e vedere il fallimento**

Run: `node --test test/decide/autonomy-intent.test.mjs`
Expected: FAIL (prod crea ⇒ `rifiuta`).

- [ ] **Step 3: implementazione**

`decision-tables/DT-026.yaml`: `version: 2`; input in più `- { name: needs_approval, label: "Il piano chiede almeno un'approvazione col livello di autonomia attuale (spec 2026-10-06 §3.5)", weight: 0, domain: { boolean: { true: 0, false: 0 } } }`; `null_policy.needs_approval: "default:true"`; `overrides` in quest'ordine:

```yaml
overrides:
  - { when: { critical_missing: true }, outcome: chiedi, source: "§29.5" }
  - { when: { action_class_allowed: false }, outcome: rifiuta, source: "§29.4 aggiornato (spec 2026-10-06 §3.3): ACT-DELETE in produzione" }
  - { when: { max_risk: R0 }, outcome: avvia, source: "§29.5: R0 ovunque" }
  - { when: { needs_approval: false }, outcome: avvia, source: "spec 2026-10-06 §3.5: nessuna approvazione col livello attuale" }
  - { when: { environment: prod }, outcome: mostra-piano, source: "spec 2026-10-06 §3.6: in produzione piano + approvazione per passo" }
  - { when: { max_risk: R3 }, outcome: mostra-piano, source: "spec 2026-10-06 §2.2" }
```

`outcomes`: togliere `approvazione-3A` solo se `grep -rn "approvazione-3A" scripts hooks commands agents skills` non trova altri usi; altrimenti lasciarlo. Aggiornare `description` e `sources`.

`scripts/decide/intent.mjs`, nel calcolo dell'esito:

```js
  const lvl = opts.autonomy ?? sessionAutonomy ?? "alto";   // sessionAutonomy: autonomyLevel({ ws, customer, records, envType: env }) quando c'è una sessione
  const isDelete = actions.includes("ACT-DELETE");
  const needsApproval = env === "prod" || (env === "preprod" && lvl !== "alto")
    || actions.some((a) => a === "ACT-CFG-CHANGE" || a === "ACT-DELETE" || (a === "ACT-BULK" && lvl !== "alto")
      || (env === "preprod" && /R2|R3/.test(ACT[a]?.risk ?? "")));
  const dt = evaluate(loadTable("DT-026"), {
    critical_missing: critical,
    action_class_allowed: notAllowed.length === 0 || !env,
    config_change: actions.includes("ACT-CFG-CHANGE"),
    max_risk: risk_max,
    environment: env ?? "prod",
    needs_approval: needsApproval,
  });
```

`critical` non esclude più le cancellazioni; `reason`: `isDelete && env === "prod"` ⇒ `DELETE_REFUSAL` (testo: «in produzione non si cancella mai; in sandbox e pre-produzione sì, dentro un piano»); `mostra-piano` ⇒ `Piano da approvare in ${env} (autonomia ${lvl})`; `avvia` ⇒ `Parte subito con autonomia ${lvl} in ${env}`.

- [ ] **Step 4: eseguire**

Run: `node --test test/decide/autonomy-intent.test.mjs test/decide/intent.test.mjs test/decide/dt-catalog.test.mjs`
Expected: PASS dopo aver aggiornato le asserzioni esistenti su prod e DELETE (elencarle nel commit).

- [ ] **Step 5: commit**

```bash
node scripts/admin/integrity.mjs build
cd .. && git add plugin/decision-tables/DT-026.yaml plugin/scripts/decide/intent.mjs plugin/test/decide plugin/integrity.json
git commit -m "feat(ops): DT-026 per livello di autonomia, produzione con piano, DELETE solo fuori prod" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Guard dell'upload (file del run con impronta)

**Files:**
- Modify: `hooks/lib/browser-tools.mjs` (DevTools `upload_file` → `files: [filePath]`; Playwright `file_upload` → `files: paths`)
- Modify: `hooks/lib/guards/config-scope.mjs` (`uploadRefusal`)
- Test: `test/hooks/upload-guard.test.mjs`

**Interfaces:**
- Produces: azione classificata `{ kind: "upload", files: string[] }`.

- [ ] **Step 1: test che fallisce**

`test/hooks/upload-guard.test.mjs`: piano attivo (`envWs({ env: "sandbox", scope: "ADM", autonomy: "alto" })`, `sealActivePlan`) con passo `{ verb: "UPLOAD", action_class: "ACT-BULK", target: <SEL "Carica file">, file: { path: "runs/<RUN>/import/de.xlsx", sha256: <sha del file scritto>, rows: 2 }, expect: { toast: "ok" } }`; snapshot con l'uid del SEL legato (come negli altri test di config-scope):
1. `upload_file { uid, filePath: <ws>/customers/ACME/runs/<RUN>/import/de.xlsx, pageId: 1 }` ⇒ consentito;
2. stesso percorso, contenuto riscritto dopo il piano ⇒ `deny` `/impronta/`;
3. `filePath: <ws>/customers/ACME/runs/<RUN>/import/../../../config/environments.yaml` ⇒ `deny`;
4. `filePath` su un file fuori dal workspace (creato in `tmpdir()`) ⇒ `deny`;
5. upload sotto un passo SAVE ⇒ `deny` `/UPLOAD/`.

(sha256 con `createHash("sha256").update(buf).digest("hex")`.)

- [ ] **Step 2: eseguire e vedere il fallimento**

Run: `node --test test/hooks/upload-guard.test.mjs`
Expected: FAIL (casi 2–4 consentiti oggi).

- [ ] **Step 3: implementazione**

`hooks/lib/browser-tools.mjs`:

```js
  upload_file: { keys: ["pageId", "uid", "filePath", ...SNAP], fn: (ti) => ({ kind: "upload", target: targetOf(ti), files: [str(ti.filePath)].filter(Boolean) }) },
```

e nella voce Playwright del caricamento (`grep -n "upload" hooks/lib/browser-tools.mjs`) `files: Array.isArray(ti.paths) ? ti.paths.map(String) : []`.

`hooks/lib/guards/config-scope.mjs`:

```js
import { createHash } from "node:crypto";
// spec 2026-10-06 §3.8: si carica solo il file compilato del run attivo, con l'impronta dichiarata nel passo UPLOAD
function uploadRefusal(ctx, step, ap, a) {
  if (step.verb !== "UPLOAD" || !step.file?.path || !step.file?.sha256) return "caricamento di file solo in un passo UPLOAD con file { path, sha256 } nel piano";
  const sep = process.platform === "win32" ? "\\" : "/";
  const runDir = resolve(ctx.ws, "customers", ctx.customer, "runs", String(ap.run ?? ""));
  const expected = resolve(ctx.ws, "customers", ctx.customer, step.file.path);
  if (!ap.run || !expected.startsWith(runDir + sep)) return "il file del passo non è nel run attivo";
  const files = Array.isArray(a.files) ? a.files : [];
  if (files.length !== 1) return "un caricamento alla volta, del solo file del passo";
  let real; let realExpected;
  try { real = realpathSync(resolve(ctx.cwd ?? ctx.ws, files[0])); } catch { return `file da caricare inesistente: ${files[0]}`; }
  try { realExpected = realpathSync(expected); } catch { return "il file compilato del passo non esiste"; }
  const same = process.platform === "win32" ? real.toLowerCase() === realExpected.toLowerCase() : real === realExpected;
  if (!same) return `si carica solo ${step.file.path} (fuori dal run o file diverso: ${files[0]})`;
  if (createHash("sha256").update(readFileSync(real)).digest("hex") !== step.file.sha256) return "il file è cambiato dopo il piano (impronta diversa): ricompila e ricomponi il piano";
  return null;
}
```

Subito dopo `bindingRefusal`:

```js
  for (const a of ctx.actions.filter((x) => x.kind === "upload")) { const u = uploadRefusal(ctx, step, ap, a); if (u) return no(`${at0}: ${u}`); }
```

(import `realpathSync` da `node:fs`).

- [ ] **Step 4: eseguire**

Run: `node --test test/hooks/upload-guard.test.mjs` più i test che coprono la classificazione (`grep -rl "upload_file" test/hooks`).
Expected: PASS.

- [ ] **Step 5: commit**

```bash
node scripts/admin/integrity.mjs build
cd .. && git add plugin/hooks/lib/browser-tools.mjs plugin/hooks/lib/guards/config-scope.mjs plugin/test/hooks/upload-guard.test.mjs plugin/integrity.json
git commit -m "feat(ops): upload solo del file del run con l'impronta del passo" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Template — `kb template-learn` e voce `TPL`

**Files:**
- Create: `scripts/ingest/lib/zip-write.mjs` (spostato da `test/helpers/zip-write.mjs`, che diventa `export * from "../../scripts/ingest/lib/zip-write.mjs";`)
- Create: `schemas/tpl.schema.json`
- Modify: `schemas/registry.json` (`"TPL": ["S","C"]`), `scripts/lib/kb-items.mjs` (`TYPE_DIRS.TPL = "templates"`), la mappa tipo → schema degli item (`grep -rn "sel.schema.json" scripts`)
- Modify: `scripts/ingest/parse-xlsx.mjs` (celle `t="inlineStr"` se non già lette; `table.start_row` = riga 1-based dell'intestazione)
- Create: `scripts/kb/template-learn.mjs`; voce in `commands/kb.md`
- Test: `test/kb/template-learn.test.mjs`

**Interfaces:**
- Consumes: `parseXlsx(buffer, { id })`, `rangeRef`.
- Produces: `learnTemplate({ ws, customer, scope, file, object, page = null, source = "utente", module = null }) → { code, item, blank }`; item in `customers/<C>/kb/scopes/<S>/templates/<code>.yaml`, file vuoto in `customers/<C>/kb/scopes/<S>/templates/files/<code>.xlsx`:

```yaml
id: C.ACME.ADM.TPL.0001
type: TPL
object: data element
module: null
page: null
source: utente
file: templates/files/C.ACME.ADM.TPL.0001.xlsx
sha256: <64 hex>
sheet: Data Elements
header_row: 1
columns:
  - { name: Codice, required: true, type: text, values: null, example: null }
  - { name: Tipo, required: true, type: list, values: [Testo, Numero, Data], example: null }
learned_at: "2026-10-07"
```

- [ ] **Step 1: test che fallisce**

```js
// test/kb/template-learn.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { makeZip } from "../../scripts/ingest/lib/zip-write.mjs";
import { learnTemplate } from "../../scripts/kb/template-learn.mjs";

export function demoTemplate() {
  const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Codice *</t></is></c><c r="B1" t="inlineStr"><is><t>Descrizione</t></is></c><c r="C1" t="inlineStr"><is><t>Tipo (obbligatorio)</t></is></c></row></sheetData><dataValidations count="1"><dataValidation type="list" sqref="C2:C1000"><formula1>"Testo,Numero,Data"</formula1></dataValidation></dataValidations></worksheet>`;
  const wb = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data Elements" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
  return makeZip([{ name: "xl/workbook.xml", data: wb }, { name: "xl/_rels/workbook.xml.rels", data: rels }, { name: "xl/worksheets/sheet1.xml", data: sheet }]);
}

test("template-learn: colonne, obbligatori da '*' e '(obbligatorio)', liste dalle convalide; item TPL e file vuoto", () => {
  const ws = mkdtempSync(join(tmpdir(), "tpl-")); mkdirSync(join(ws, "customers/ACME"), { recursive: true });
  const f = join(ws, "de.xlsx"); writeFileSync(f, demoTemplate());
  const r = learnTemplate({ ws, customer: "ACME", scope: "ADM", file: f, object: "data element" });
  assert.equal(r.code, "C.ACME.ADM.TPL.0001");
  const it = YAML.parse(readFileSync(join(ws, "customers/ACME/kb/scopes/ADM/templates/C.ACME.ADM.TPL.0001.yaml"), "utf8"));
  assert.deepEqual(it.columns.map((c) => [c.name, c.required, c.type, c.values]), [["Codice", true, "text", null], ["Descrizione", false, "text", null], ["Tipo", true, "list", ["Testo", "Numero", "Data"]]]);
  assert.equal(it.sheet, "Data Elements"); assert.equal(it.header_row, 1); assert.equal(it.source, "utente");
  assert.ok(existsSync(join(ws, "customers/ACME/kb/scopes/ADM/templates/files/C.ACME.ADM.TPL.0001.xlsx")));
  assert.equal(learnTemplate({ ws, customer: "ACME", scope: "ADM", file: f, object: "data element", source: "tenant" }).code, "C.ACME.ADM.TPL.0001", "stesso oggetto ⇒ stessa voce aggiornata");
});
```

- [ ] **Step 2: eseguire e vedere il fallimento**

Run: `node --test test/kb/template-learn.test.mjs`
Expected: FAIL — moduli inesistenti.

- [ ] **Step 3: implementazione**

Spostamento dello scrittore ZIP: contenuto di `test/helpers/zip-write.mjs` invariato in `scripts/ingest/lib/zip-write.mjs` (commento: «Scrittore ZIP minimo: fixture dei test e template compilati, spec 2026-10-06 §3.8»).

`scripts/ingest/parse-xlsx.mjs`: se la lettura delle celle non gestisce `t="inlineStr"`, leggere `<is><t>` (o `<is><r><t>`) nello stesso punto in cui gestisce `t="s"`; aggiungere a `table` `start_row: first + 1`. Test in più in `test/ingest/parsers.test.mjs`: una cella `inlineStr` letta.

```js
// scripts/kb/template-learn.mjs
// kb template-learn (spec 2026-10-06 §3.8): impara un template di caricamento massivo (xlsx) — foglio, intestazione,
// colonne, obbligatori, liste di valori — e lo salva come voce TPL del cliente, con il file vuoto accanto.
//   node scripts/kb/template-learn.mjs --file <xlsx> --object "<oggetto>" --scope <S> [--customer C] [--page <sig>] [--fonte utente|tenant] [--json]
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { parseXlsx, rangeRef } from "../ingest/parse-xlsx.mjs";
import { SCOPES } from "./codes.mjs";

const REQ = /\s*(\*|\((obbligatorio|required|mandatory)\))\s*$/i;
const norm = (s) => String(s ?? "").trim().toLowerCase();
export const templatesDir = (ws, customer, scope) => join(ws, "customers", customer, "kb", "scopes", scope, "templates");

export function learnTemplate({ ws, customer, scope, file, object, page = null, source = "utente", module = null, now = new Date() }) {
  if (!/^[A-Z0-9]{4}$/.test(String(customer ?? ""))) throw new Error(`cliente non valido: ${customer}`);
  if (!SCOPES.has(scope)) throw new Error(`scope non valido: ${scope}`);
  if (!String(object ?? "").trim()) throw new Error("serve --object (es. \"data element\")");
  if (!["utente", "tenant"].includes(source)) throw new Error("--fonte: utente o tenant");
  const buf = readFileSync(file);
  const doc = parseXlsx(buf, { id: "tpl" });
  const sec = doc.sections.find((s) => !s.hidden && s.tables?.length && s.tables[0].headers.some((h) => h));
  if (!sec) throw new Error("nessun foglio visibile con un'intestazione: non sembra un template di caricamento");
  const t = sec.tables[0];
  const lists = (sec.validations ?? []).filter((v) => v.type === "list" && Array.isArray(v.values));
  const listFor = (c) => lists.find((v) => String(v.sqref).split(/\s+/).some((ref) => { const r = rangeRef(ref); return r && c >= r.c1 && c <= r.c2; }))?.values ?? null;
  const columns = t.headers.map((h, c) => {
    const values = listFor(c);
    const example = t.rows.find((r) => r[c] != null)?.[c] ?? null;
    return { name: String(h).replace(REQ, "").trim(), required: REQ.test(h), type: values ? "list" : typeof example === "number" ? "number" : "text", values, example };
  }).filter((c) => c.name);
  const d = templatesDir(ws, customer, scope);
  mkdirSync(join(d, "files"), { recursive: true });
  const yamls = readdirSync(d).filter((f) => f.endsWith(".yaml"));
  const existing = yamls.map((f) => YAML.parse(readFileSync(join(d, f), "utf8"))).find((x) => norm(x?.object) === norm(object));
  const code = existing?.id ?? `C.${customer}.${scope}.TPL.${String(yamls.length + 1).padStart(4, "0")}`;
  copyFileSync(file, join(d, "files", `${code}.xlsx`));
  const item = { id: code, type: "TPL", object: String(object).trim(), module, page, source, file: `templates/files/${code}.xlsx`,
    sha256: createHash("sha256").update(buf).digest("hex"), sheet: sec.title, header_row: t.start_row ?? 1, columns, learned_at: now.toISOString().slice(0, 10) };
  writeFileSync(join(d, `${code}.yaml`), YAML.stringify(item));
  return { code, item, blank: join(d, "files", `${code}.xlsx`) };
}
```

CLI con `parseArgs`/`fail`/`isMain` come in `scripts/decide/compose-plan.mjs` (exit 0 scritto · 1 uso · 2 sistema), workspace da `--workspace` / `JVC_WORKSPACE`, cliente dalla sessione se manca `--customer`.

`schemas/tpl.schema.json`: oggetto con i campi dell'item; `required: ["id","type","object","source","file","sha256","sheet","header_row","columns"]`; `id` con pattern `^[SC]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.TPL\.\d{4}$`; `columns.items.required: ["name","required","type"]`, `type` in `text|number|list`. Registrare `TPL` dove sono registrati gli altri tipi.

- [ ] **Step 4: eseguire**

Run: `node --test test/kb/template-learn.test.mjs test/ingest/parsers.test.mjs`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
node scripts/admin/integrity.mjs build
cd .. && git add plugin/scripts/ingest plugin/test/helpers/zip-write.mjs plugin/schemas plugin/scripts/lib/kb-items.mjs plugin/scripts/kb/template-learn.mjs plugin/commands/kb.md plugin/test plugin/integrity.json
git commit -m "feat(kb): template-learn — voce TPL dai template di caricamento massivo" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: `ops template-fill`

**Files:**
- Create: `scripts/decide/template-fill.mjs`
- Test: `test/decide/template-fill.test.mjs`

**Interfaces:**
- Consumes: item TPL e `templatesDir` (Task 10), `openZip`, `makeZip`.
- Produces: `checkRows(item, rows) → [{ row, column, message }]`; `fillTemplate({ ws, customer, scope, tpl, rows, out }) → { ok: true, path, sha256, rows } | { ok: false, errors }`; `out` relativo a `customers/<C>/`, dentro `runs/<RUN>/import/`, mai sovrascritto.

- [ ] **Step 1: test che fallisce**

```js
// test/decide/template-fill.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { learnTemplate } from "../../scripts/kb/template-learn.mjs";
import { fillTemplate } from "../../scripts/decide/template-fill.mjs";
import { parseXlsx } from "../../scripts/ingest/parse-xlsx.mjs";
import { demoTemplate } from "../kb/template-learn.test.mjs";

const OUT = "runs/RUN.ACME.20261007.1000.ADM/import/de.xlsx";
function setup() {
  const ws = mkdtempSync(join(tmpdir(), "tf-")); mkdirSync(join(ws, "customers/ACME/runs/RUN.ACME.20261007.1000.ADM"), { recursive: true });
  const f = join(ws, "de.xlsx"); writeFileSync(f, demoTemplate());
  learnTemplate({ ws, customer: "ACME", scope: "ADM", file: f, object: "data element" });
  return ws;
}

test("template-fill: righe valide ⇒ xlsx rileggibile con convalide intatte; righe invalide ⇒ errori, nessun file", () => {
  const ws = setup();
  const ok = fillTemplate({ ws, customer: "ACME", scope: "ADM", tpl: "C.ACME.ADM.TPL.0001", out: OUT, rows: [{ Codice: "DE_001", Descrizione: "Centro & costo", Tipo: "Testo" }, { Codice: "DE_002", Tipo: "Numero" }] });
  assert.equal(ok.ok, true); assert.equal(ok.rows, 2); assert.match(ok.sha256, /^[0-9a-f]{64}$/);
  const doc = parseXlsx(readFileSync(join(ws, "customers/ACME", OUT)), { id: "x" });
  assert.deepEqual(doc.sections[0].tables[0].rows.map((r) => r.slice(0, 3)), [["DE_001", "Centro & costo", "Testo"], ["DE_002", null, "Numero"]]);
  assert.deepEqual(doc.sections[0].validations[0].values, ["Testo", "Numero", "Data"]);
  const bad = fillTemplate({ ws, customer: "ACME", scope: "ADM", tpl: "C.ACME.ADM.TPL.0001", out: OUT.replace("de.xlsx", "de2.xlsx"), rows: [{ Descrizione: "x", Tipo: "Booleano" }, { Codice: "A", Colore: "rosso" }] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map((e) => [e.row, e.column]), [[1, "Codice"], [1, "Tipo"], [2, "Tipo"], [2, "Colore"]]);
});

test("template-fill: uscita fuori da runs/<RUN>/import/ o file già esistente ⇒ errore", () => {
  const ws = setup();
  assert.throws(() => fillTemplate({ ws, customer: "ACME", scope: "ADM", tpl: "C.ACME.ADM.TPL.0001", out: "config/x.xlsx", rows: [{ Codice: "A", Tipo: "Testo" }] }), /runs\/<RUN>\/import/);
  fillTemplate({ ws, customer: "ACME", scope: "ADM", tpl: "C.ACME.ADM.TPL.0001", out: OUT, rows: [{ Codice: "A", Tipo: "Testo" }] });
  assert.throws(() => fillTemplate({ ws, customer: "ACME", scope: "ADM", tpl: "C.ACME.ADM.TPL.0001", out: OUT, rows: [{ Codice: "B", Tipo: "Testo" }] }), /esiste già/);
});
```

- [ ] **Step 2: eseguire e vedere il fallimento**

Run: `node --test test/decide/template-fill.test.mjs`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: implementazione**

```js
// scripts/decide/template-fill.mjs
// ops template-fill (spec 2026-10-06 §3.8): copia il file vuoto del TPL e scrive le righe nel foglio (stringhe inline;
// stili, convalide e altri fogli intatti); prima controlla ogni riga e, con errori, non scrive nulla.
//   node scripts/decide/template-fill.mjs --tpl <codice> --data <righe.json|yaml> --out runs/<RUN>/import/<file>.xlsx --scope <S> [--customer C] [--json]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { openZip } from "../ingest/lib/zip.mjs";
import { makeZip } from "../ingest/lib/zip-write.mjs";
import { templatesDir } from "../kb/template-learn.mjs";

const OUT = /^runs\/RUN\.[A-Z0-9]{4}\.\d{8}\.\d{4}\.[A-Z0-9]{3}\/import\/[A-Za-z0-9._-]+\.xlsx$/;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const colName = (c) => { let s = ""; for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

export function checkRows(item, rows) {
  const errors = [];
  const names = new Set(item.columns.map((c) => c.name));
  rows.forEach((r, i) => {
    const row = i + 1;
    for (const c of item.columns) {
      const v = r?.[c.name];
      const empty = v == null || String(v).trim() === "";
      if (c.required && empty) errors.push({ row, column: c.name, message: "obbligatorio" });
      if (!empty && c.values && !c.values.includes(String(v))) errors.push({ row, column: c.name, message: `valore fuori elenco (${c.values.join(", ")})` });
      if (!empty && c.type === "number" && !Number.isFinite(Number(v))) errors.push({ row, column: c.name, message: "atteso un numero" });
    }
    for (const k of Object.keys(r ?? {})) if (!names.has(k)) errors.push({ row, column: k, message: "colonna inesistente nel template" });
  });
  return errors;
}

export function fillTemplate({ ws, customer, scope, tpl, rows, out }) {
  if (!OUT.test(String(out ?? ""))) throw new Error("l'uscita deve stare in runs/<RUN>/import/<file>.xlsx");
  const dir = templatesDir(ws, customer, scope);
  const item = YAML.parse(readFileSync(join(dir, `${tpl}.yaml`), "utf8"));
  const errors = checkRows(item, rows);
  if (errors.length) return { ok: false, errors };
  const abs = join(ws, "customers", customer, out);
  if (existsSync(abs)) throw new Error(`${out} esiste già: il file legato a un piano non si riscrive (usa un nome nuovo)`);
  const zip = openZip(readFileSync(join(dir, "..", item.file)));
  const wb = zip.text("xl/workbook.xml");
  const rid = new RegExp(`<sheet\\b[^>]*name="${reEsc(esc(item.sheet))}"[^>]*r:id="([^"]+)"`).exec(wb)?.[1];
  const rels = zip.text("xl/_rels/workbook.xml.rels");
  const target = (rid && new RegExp(`Id="${reEsc(rid)}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]) ?? "worksheets/sheet1.xml";
  const sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  const first = item.header_row + 1;
  const body = rows.map((r, i) => {
    const n = first + i;
    const cells = item.columns.map((c, k) => {
      const v = r[c.name];
      if (v == null || String(v) === "") return "";
      return c.type === "number" ? `<c r="${colName(k)}${n}"><v>${Number(v)}</v></c>` : `<c r="${colName(k)}${n}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    }).join("");
    return `<row r="${n}">${cells}</row>`;
  }).join("");
  let xml = zip.text(sheetPath);
  // le righe d'esempio sotto l'intestazione si tolgono; le nuove vanno dopo l'intestazione
  xml = xml.replace(/<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>|<row\b[^>]*\br="(\d+)"[^>]*\/>/g, (m, a, b) => (Number(a ?? b) > item.header_row ? "" : m));
  xml = xml.includes("<sheetData/>") ? xml.replace("<sheetData/>", `<sheetData>${body}</sheetData>`) : xml.replace("</sheetData>", `${body}</sheetData>`);
  const last = first + rows.length - 1;
  xml = xml.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:${colName(item.columns.length - 1)}${Math.max(last, item.header_row)}"/>`);
  const buf = makeZip(zip.names.map((name) => ({ name, data: name === sheetPath ? Buffer.from(xml, "utf8") : zip.read(name) })));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buf, { flag: "wx" });
  return { ok: true, path: out, sha256: createHash("sha256").update(buf).digest("hex"), rows: rows.length };
}
```

(`join(dir, "..", item.file)`: `dir` = `…/scopes/<S>/templates`, `item.file` = `templates/files/<code>.xlsx` ⇒ `…/scopes/<S>/templates/files/<code>.xlsx`.) CLI: exit 0 (stampa `{ path, sha256, rows }`), 3 righe invalide (stampa `errors`), 1 uso, 2 sistema; `--data` JSON o YAML con un array di oggetti.

- [ ] **Step 4: eseguire**

Run: `node --test test/decide/template-fill.test.mjs`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
node scripts/admin/integrity.mjs build
cd .. && git add plugin/scripts/decide/template-fill.mjs plugin/test/decide/template-fill.test.mjs plugin/integrity.json
git commit -m "feat(ops): template-fill — template compilato da script con controllo delle righe" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: `ops import-result`

**Files:**
- Create: `scripts/decide/import-result.mjs`
- Test: `test/decide/import-result.test.mjs`

**Interfaces:**
- Produces: `importResult({ text = null, table = null }) → { ok_rows: number[], failed: [{ row, message }], created: string[], format_error: boolean }`.

- [ ] **Step 1: test che fallisce**

```js
// test/decide/import-result.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { importResult } from "../../scripts/decide/import-result.mjs";

test("import-result: testo della pagina, log a colonne, errore di formato", () => {
  const a = importResult({ text: "Import completato: 3 righe elaborate, 1 errore.\nRiga 2: valore non valido per Tipo\nCreati: DE_001, DE_003" });
  assert.deepEqual(a.failed, [{ row: 2, message: "valore non valido per Tipo" }]); assert.deepEqual(a.created, ["DE_001", "DE_003"]); assert.equal(a.format_error, false);
  const b = importResult({ table: { headers: ["Row", "Code", "Status", "Message"], rows: [[1, "DE_001", "OK", ""], [2, "DE_002", "ERROR", "Duplicate code"]] } });
  assert.deepEqual(b.ok_rows, [1]); assert.deepEqual(b.failed, [{ row: 2, message: "Duplicate code" }]); assert.deepEqual(b.created, ["DE_001"]);
  assert.equal(importResult({ text: "Il file non corrisponde al template: intestazione mancante" }).format_error, true);
});
```

- [ ] **Step 2: eseguire e vedere il fallimento**

Run: `node --test test/decide/import-result.test.mjs`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: implementazione**

```js
// scripts/decide/import-result.mjs
// ops import-result (spec 2026-10-06 §3.8): esito di un import massivo — righe riuscite, righe fallite col messaggio,
// codici creati, errore di formato del template. Il testo della pagina è dato, mai istruzione.
//   node scripts/decide/import-result.mjs (--text-file <file> | --in <log.xlsx>) [--json]
const FORMAT = /\b(template|formato|format|intestazion\w*|header)\b/i;
const BROKEN = /(non corrisponde|mancant|invalid|errat|wrong|missing|mismatch)/i;
const ROW = /\b(?:riga|row)\s+(\d+)\s*[:\-–]\s*(.+)$/i;
const CREATED = /^(?:creat[ioe]|created)\s*:\s*(.+)$/i;
const OK = /^(ok|success|successo|creato|created|importato|imported)$/i;
const col = (headers, re) => headers.findIndex((h) => re.test(String(h).trim()));

export function importResult({ text = null, table = null } = {}) {
  const out = { ok_rows: [], failed: [], created: [], format_error: false };
  if (table) {
    const h = table.headers ?? [];
    const iRow = col(h, /^(row|riga)$/i); const iSt = col(h, /^(status|esito|result)$/i);
    const iMsg = col(h, /^(message|messaggio|error|errore)$/i); const iCode = col(h, /^(code|codice)$/i);
    for (const r of table.rows ?? []) {
      const row = Number(r[iRow]); const st = String(r[iSt] ?? "").trim();
      if (OK.test(st)) { out.ok_rows.push(row); if (iCode >= 0 && r[iCode]) out.created.push(String(r[iCode])); }
      else out.failed.push({ row, message: String((iMsg >= 0 && r[iMsg]) || st) });
    }
    return out;
  }
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const m = ROW.exec(line);
    if (m) { out.failed.push({ row: Number(m[1]), message: m[2].trim() }); continue; }
    const c = CREATED.exec(line);
    if (c) out.created.push(...c[1].split(/[,;]\s*/).map((x) => x.trim()).filter(Boolean));
    if (FORMAT.test(line) && BROKEN.test(line)) out.format_error = true;
  }
  return out;
}
```

CLI: `--text-file` legge testo; `--in` `.xlsx` usa `parseXlsx(buf).sections[0].tables[0]`.

- [ ] **Step 4: eseguire**

Run: `node --test test/decide/import-result.test.mjs`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
node scripts/admin/integrity.mjs build
cd .. && git add plugin/scripts/decide/import-result.mjs plugin/test/decide/import-result.test.mjs plugin/integrity.json
git commit -m "feat(ops): import-result — righe riuscite, fallite, codici creati, errore di formato" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: compose-plan — via massiva preferita e FILL in un colpo

**Files:**
- Modify: `scripts/decide/compose-plan.mjs`
- Modify: `hooks/lib/guards/config-scope.mjs` (`bindingRefusal` per passi con `fields`)
- Test: `test/decide/compose-plan-bulk.test.mjs`

**Interfaces:**
- Consumes: item TPL (Task 10), schema `file`/`fields` (Task 3).
- Produces: `composePlan({ ..., filled = null })` — con un TPL per l'oggetto dell'obiettivo: senza `filled` ⇒ `gaps: [{ kind: "fill-template", what: <tpl>, hint }]`; con `filled = { path, sha256, rows }` ⇒ piano `[percorso…, UPLOAD (ACT-BULK, file), SUBMIT (ACT-BULK), READ (ACT-READ)]`; nel piano a maschera i FILL/CHOOSE della pagina diventano **un** passo `{ verb: "FILL", action_class: "ACT-CREATE", fields: [{ target, value }], expect }`. CLI: `--filled <path>:<sha256>:<righe>`.

- [ ] **Step 1: test che fallisce**

`test/decide/compose-plan-bulk.test.mjs`, costruito come `test/decide/compose-plan.test.mjs` (stesso modo di scrivere SEL, FLD, FLW del cliente):
1. TPL `{ object: "data element", page: "adm/import/de#import-data-element" }`, SEL `Carica file` (role button, effect write, page = sig) e `Importa` (effect write, stessa pagina), FLW `Percorso: Import data element` con ultimo `expect.page_sig: "adm/import/de"`; `composePlan({ goal: "crea 3 data element", filled: { path: "runs/RUN.ACME.20261007.1000.ADM/import/de.xlsx", sha256: "a".repeat(64), rows: 3 }, ... })` ⇒ ultimi tre passi `UPLOAD` (con `file` uguale a `filled`), `SUBMIT` ACT-BULK, `READ`; nessun passo FILL; senza `filled` ⇒ `gaps[0].kind === "fill-template"`;
2. il piano a maschera del test esistente di compose-plan ⇒ un solo passo FILL con `fields.length` uguale al numero di campi con dati.

- [ ] **Step 2: eseguire e vedere il fallimento**

Run: `node --test test/decide/compose-plan-bulk.test.mjs`
Expected: FAIL.

- [ ] **Step 3: implementazione**

In `composePlan`, all'inizio (prima di `OBJECTS.find`), con `filled` fra i parametri:

```js
  // spec 2026-10-06 §3.8: con un template di caricamento per l'oggetto la via massiva è sempre preferita, anche per un record
  const tpls = items(ws, customer, scope, "templates");
  const tpl = tpls.find((t) => t.object && new RegExp(`\\b${reEsc(String(t.object)).replace(/\s+/g, "\\s*")}\\b`, "i").test(goal));
  if (tpl) return bulkPlan({ tpl, sels: items(ws, customer, scope, "selectors"), flws: items(ws, customer, scope, "flows"), filled, planId, customer, env, goal });
```

```js
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const UPLOAD_LABEL = /\b(carica|upload|sfoglia|browse|scegli file|choose file|seleziona file)\b/i;
const START_LABEL = /\b(importa|import|avvia|start|conferma|confirm|carica|upload)\b/i;

function bulkPlan({ tpl, sels, flws, filled, planId, customer, env, goal }) {
  if (!filled) return { gaps: [{ kind: "fill-template", what: tpl.id, hint: `compila con template-fill --tpl ${tpl.id} e ripassa --filled <path>:<sha256>:<righe>` }] };
  const gaps = [];
  const page = tpl.page;
  const route = page ? flws.find((f) => String((f.steps ?? []).at(-1)?.expect?.page_sig ?? "") === pathOf(page)) : null;
  const onPage = sels.filter((s) => s.page === page);
  const upload = onPage.find((s) => UPLOAD_LABEL.test(s.label));
  const start = onPage.find((s) => s.effect === "write" && START_LABEL.test(s.label) && s.id !== upload?.id);
  if (!route) gaps.push({ kind: "no-route", what: tpl.object, hint: "pagina di import non ancora vista: esplora fino all'import massivo" });
  if (!upload) gaps.push({ kind: "no-upload", what: tpl.object, hint: "campo di caricamento del file non visto nella pagina di import" });
  if (!start) gaps.push({ kind: "no-submit", what: tpl.object, hint: "pulsante che avvia l'import non visto" });
  if (gaps.length) return { gaps };
  const steps = [...route.steps.map((s) => ({ verb: s.verb, action_class: s.action_class ?? "ACT-OBS", target: s.target, expect: s.expect ?? { page_sig: pathOf(page) } })),
    { verb: "UPLOAD", action_class: "ACT-BULK", target: upload.id, file: filled, expect: { elements: [{ sel: upload.id }] } },
    { verb: "SUBMIT", action_class: "ACT-BULK", target: start.id, expect: { page_sig: pathOf(page) } },
    { verb: "READ", action_class: "ACT-READ", target: start.id, expect: { messages: "esito dell'import" } }].map((s, i) => ({ n: i + 1, ...s }));
  const plan = { plan_id: planId, customer, env: env.id, goal, steps,
    compensations: [{ step: steps.length - 1, kind: "deactivate", entity: tpl.object, action: `${tpl.object}.deactivate` }],
    repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } };
  const v = validatePlan(plan, { env });
  if (!v.ok) throw new Error(`piano composto non valido (bug del compositore): ${v.errors.join("; ")}`);
  return { plan };
}
```

FILL raggruppato (ramo senza procedura), nella costruzione di `steps`, al posto di `...fills`:

```js
      ...(fills.length > 1 ? [{ verb: "FILL", action_class: "ACT-CREATE", fields: fills.map((f) => ({ target: f.target, value: f.data })), expect: { elements: fills.map((f) => ({ sel: f.target, value: f.data })) } }] : fills),
```

e `saveN = steps.length` resta corretto (calcolato dopo). La compensazione dell'UPLOAD massivo si registra sullo stesso passo UPLOAD (`COMP_CLASSES` contiene ACT-BULK dal Task 7): usare `step: <n del passo UPLOAD>`.

CLI: `--filled` → `{ path, sha256, rows: Number(rows) }`.

`bindingRefusal` in config-scope: quando `Array.isArray(step.fields)`, l'insieme dei SEL ammessi è `step.fields.map((f) => f.target)` invece di `[step.target]`; ogni ref della chiamata deve legarsi a uno di questi (stessa mappa ref → `atlas_match` usata oggi) e nessun ref fuori dall'insieme.

- [ ] **Step 4: eseguire**

Run: `node --test test/decide/compose-plan-bulk.test.mjs test/decide/compose-plan.test.mjs test/kb/solution-a-review.test.mjs test/kb/solution-a-review2.test.mjs`
Expected: PASS (aggiornare nei test esistenti le asserzioni sul numero di passi FILL, elencandole nel commit).

- [ ] **Step 5: commit**

```bash
node scripts/admin/integrity.mjs build
cd .. && git add plugin/scripts/decide/compose-plan.mjs plugin/hooks/lib/guards/config-scope.mjs plugin/test plugin/integrity.json
git commit -m "feat(ops): compose-plan preferisce l'import massivo; campi della pagina in un solo FILL" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Istruzioni agli agenti e documenti

**Files:**
- Modify: `commands/ops.md`, `agents/scope-expert.md`, `skills/agent-manager/SKILL.md`, `docs/MANUAL.md` (§57.2 frasi, §52), `MANUALE-UTENTE.md`, `docs/GUIDA-PRIMO-USO.md`, `README.md`, `commands/kb.md`, `docs/IMPLEMENTATION-CHECKLIST.md`
- Test: `test/docs/ops-veloce-docs.test.mjs` più i test esistenti su documenti e agenti

- [ ] **Step 1: test che fallisce**

```js
// test/docs/ops-veloce-docs.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers/hook-env.mjs";

const read = (p) => readFileSync(join(ROOT, p), "utf8");
test("documenti: frasi AUTONOMIA, template, produzione, cancellazioni; nessuna frase letterale nel corpo dell'agente", () => {
  for (const p of ["docs/MANUAL.md", "MANUALE-UTENTE.md", "README.md"]) assert.match(read(p), /AUTONOMIA ALTA/, p);
  assert.match(read("commands/ops.md"), /template-fill/);
  assert.match(read("commands/kb.md"), /template-learn/);
  assert.match(read("MANUALE-UTENTE.md"), /APPROVO PASSO/);
  assert.match(read("MANUALE-UTENTE.md"), /write_data/);
  assert.doesNotMatch(read("agents/scope-expert.md").split("---").slice(2).join("---"), /AUTONOMIA (ALTA|MEDIA|BASSA)/);
});
```

(Se esiste già una cartella di test dei documenti con un altro nome, mettere il file lì: `ls test`.)

- [ ] **Step 2: eseguire e vedere il fallimento**

Run: `node --test test/docs/ops-veloce-docs.test.mjs`
Expected: FAIL.

- [ ] **Step 3: scrivere i documenti**

In italiano, col tono dei documenti esistenti:
- `commands/ops.md`: livello di autonomia (`use show`), tabella 2.2 della spec; import massivo: template forniti dall'utente prima (`kb template-learn --fonte utente`), altrimenti scaricarlo dal tenant (click su "scarica template" + `get_network_request` con `responseFilePath` nella cartella della sessione, poi `kb template-learn --fonte tenant`), `template-fill`, `compose-plan --filled`, esecuzione, `import-result`, reimport delle sole righe fallite al massimo 2 volte; con errore di formato riscaricare e reimparare una volta; produzione: `write_data: true` e approvazione per passo; cancellazioni: lettura salvata in `runs/<RUN>/evidence/` e compensazione `restore` prima del passo DELETE.
- `agents/scope-expert.md`: le stesse istruzioni **senza** frasi letterali dell'utente («la frase di autonomia», «l'approvazione del passo»); `includeSnapshot: true` su click e compilazioni; `fill_form` per i passi FILL con `fields`; `take_snapshot` separato solo dopo navigazioni senza snapshot nella risposta.
- `skills/agent-manager/SKILL.md`: in produzione, prima di chiedere l'approvazione di un passo, il manager mostra file, righe e oggetti toccati; con autonomia alta in sandbox non chiede nulla; elenco finale delle modifiche.
- `docs/MANUAL.md` §57.2: `AUTONOMIA ALTA · AUTONOMIA MEDIA · AUTONOMIA BASSA`; §52 produzione.
- `MANUALE-UTENTE.md`, `GUIDA-PRIMO-USO.md`, `README.md`: frasi, livelli, `autonomy.yaml`, `write_data` di produzione, `APPROVO PASSO` in produzione, rischi.
- `docs/IMPLEMENTATION-CHECKLIST.md`: voce «Ops veloce» con stato e percentuale.

- [ ] **Step 4: eseguire**

Run: `node --test test/docs/ops-veloce-docs.test.mjs` e i test esistenti di documenti e agenti (`grep -rl "agents/" test --include=*.test.mjs`).
Expected: PASS.

- [ ] **Step 5: commit**

```bash
node scripts/admin/integrity.mjs build
cd .. && git add plugin/commands plugin/agents plugin/skills plugin/docs plugin/MANUALE-UTENTE.md plugin/README.md plugin/test plugin/integrity.json
git commit -m "docs(ops): autonomia, import massivi con template, produzione, cancellazioni" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Verifica finale

- [ ] **Step 1:** `node scripts/admin/integrity.mjs build`, poi `npm test` (suite completa con corpus) e `npm run test:timing`. Expected: tutto verde; annotare i numeri.
- [ ] **Step 2:** revisione indipendente dell'intero ramo (sicurezza: produzione, cancellazioni, upload, frasi, livelli) con i rilievi scritti nel registro SDD `.superpowers/sdd/2026-10-07-ops-veloce/progress.md` (radice del repo, ignorato da git); ogni rilievo Critical/Important corretto con un test che prima fallisce.
- [ ] **Step 3:** push del ramo `feature/autonomia-ops` e aggiornamento della PR #3 (cosa cambia, test, rischi); il merge lo fa l'utente.
