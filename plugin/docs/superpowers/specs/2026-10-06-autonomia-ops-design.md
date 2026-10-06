# Autonomia di ops — meno cerimonie, un livello scelto dall'utente

Stato: **proposta da approvare** · ramo `feature/autonomia-ops` · data 06/10/2026.
Il merge su `main` lo fa l'utente. Il codice si scrive solo dopo l'approvazione di questa specifica e del piano.

## 1. Obiettivo

Richiesta dell'utente (06/10/2026): «vorrei ops più veloce e meno cerimoniale, possiamo dare un livello di autonomia
ad ops? impostiamolo di default ad alto».

Oggi "crea ordine e invialo" costa, in scambi con l'utente:

| | solo bozza | con invio |
|---|---|---|
| sandbox | 0 | 1 (`sì`) |
| pre-produzione | 1 (`APPROVO PIANO`) | 2–3 (`APPROVO PIANO` + un `sì` per ogni passo R2) |
| produzione | rifiutato | rifiutato |

e ogni approvazione fa ripartire l'agente (nuovo dispatch). Con questa specifica il numero di frasi dipende da un
**livello di autonomia** — `alto` (predefinito), `medio`, `basso` — che solo l'utente può cambiare.

Criterio di successo: con il livello predefinito, in sandbox "crea ordine e invialo" parte e finisce senza domande; in
pre-produzione un piano di sola creazione parte senza domande e un piano con invio chiede **una sola** frase.

Sotto-progetto separato (specifica successiva, non qui): trasformare le procedure lette nei documenti in piani
eseguibili (collegamento passi del documento ↔ SEL/FLD della mappa, verbi del piano, compose-plan oltre "crea").

## 2. Regole per livello (approvate dall'utente il 06/10/2026)

| | sandbox | pre-produzione | produzione |
|---|---|---|---|
| **alto** (predefinito) | nessuna frase per creare, aggiornare, inviare, approvare, pubblicare; `APPROVO PIANO` solo se il piano contiene configurazione (ACT-CFG-CHANGE) o operazioni massive (ACT-BULK) | piano di sola creazione/aggiornamento (R0–R1): nessuna frase; altrimenti **un solo** `APPROVO PIANO` che copre invii, approvazioni, pubblicazioni, configurazione e massive | invariata: nessuna scrittura |
| **medio** | nessuna frase per creare e inviare; configurazione e massive come oggi | `APPROVO PIANO` sempre, e copre i passi R2 (niente `sì` per passo); configurazione e massive come oggi | invariata |
| **basso** | come oggi | come oggi | invariata |

Restano **a ogni livello**:

- `APPROVO PROVA` (A2) quando l'ambiente ha `second_approver_required` (persona diversa da A1);
- le frasi le scrive solo l'utente (guard-phrase), il registro delle approvazioni è protetto e a catena di hash, ogni
  record è confermato nel transcript;
- A1 legata all'impronta del piano (piano cambiato ⇒ nuova A1) e finestra di `config_window_minutes` (default 60);
- in produzione nessuna scrittura (configurazione solo con 3A e secondo approvatore, come oggi); niente DELETE; host
  dichiarati; nessuno script nella pagina; verifica dell'impronta dell'ambiente;
- compensazione registrata prima di creare/aggiornare/inviare; ogni click/input legato al SEL del passo;
- il referente in pre-produzione resta un'istruzione dell'agente (come oggi, non un blocco).

## 3. Componenti

### 3.1 Livello effettivo — `hooks/lib/autonomy.mjs` (nuovo)

`autonomyLevel({ ws, customer, records })` → `{ level: "alto"|"medio"|"basso", source: "frase"|"cliente"|"predefinito" }`:

1. l'ultimo record `{ kind: "autonomy", level }` nel registro delle approvazioni della sessione (frase dell'utente);
2. altrimenti `customers/<C>/config/autonomy.yaml` → `{ default: alto|medio|basso }`;
3. altrimenti `alto`.

Fail-closed: file del cliente illeggibile o valore fuori elenco ⇒ `basso`, con un avviso. Registro delle approvazioni
corrotto ⇒ come oggi (negato prima di arrivare qui). Modulo senza dipendenze pesanti: è sul percorso dei guard.

### 3.2 Frasi `AUTONOMIA ALTA` · `AUTONOMIA MEDIA` · `AUTONOMIA BASSA`

- `parseApprovalPrompt` (scripts/admin/approvals.mjs) → `{ kind: "autonomy", level }`; approval-capture registra il
  record (catena di hash, conferma nel transcript come le altre frasi). Vale per la sessione, da subito.
- guard-phrase (`hooks/lib/guards/phrase.mjs`): `AUTONOMIA\s+(ALTA|MEDIA|BASSA)` fra le frasi che il modello non può
  scrivere negli input degli strumenti.
- Nessuna finestra: il livello resta finché l'utente non scrive un'altra frase o la sessione finisce.

### 3.3 Configurazione del cliente — `customers/<C>/config/autonomy.yaml`

- `default: alto|medio|basso`; schema `schemas/autonomy.schema.json`. `customers/*/config/**` è già scrivibile solo
  dall'utente (config-scope): il modello non può alzarsi il livello.

### 3.4 Approvazioni richieste — `requiredApprovals` (config-scope, condivisa con step-check)

Firma nuova `requiredApprovals(cls, step, env, cfgLevel, autonomy)`; `autonomy` assente ⇒ `basso` (compatibilità e
prudenza). Esito `{ a1, a2, a3, action }`:

| classe | basso (oggi) | medio | alto |
|---|---|---|---|
| R2 sui dati (SUBMIT, APPROVE, TRANSMIT, PUBLISH, UPLOAD, CLOSE) | `action` | sandbox: nulla · preprod: `a1` | sandbox: nulla · preprod: `a1` |
| ACT-CFG-CHANGE (non prod) | per policy (`a1`, `a3`, `a2`) | come oggi | `a1` (+ `a2` se `second_approver_required`) |
| ACT-BULK | `a1` + `a3` | come oggi | `a1` |
| ACT-CREATE / ACT-UPDATE (R1) | nulla | nulla | nulla |
| produzione | invariata | invariata | invariata |

I due punti che oggi applicano le regole leggono la stessa funzione: il guard (`config-scope.mjs`, al momento del
click) e `step-check` (`gateStep`, prima del passo). Nessuna duplicazione nuova.

### 3.5 Attivazione del piano — `step-check` `planApproval`

Oggi: fuori sandbox ogni piano richiede A1 per attivarsi. Nuovo:

- **alto**: A1 serve solo se almeno un passo del piano, con `requiredApprovals`, chiede `a1`/`a2`/`a3`/`action`
  (sandbox: solo con CFG/BULK; preprod: con R2, CFG o BULK). Piano di sola creazione ⇒ si attiva subito.
- **medio**: sandbox come oggi (nessuna A1 all'attivazione); preprod A1 sempre.
- **basso**: come oggi.
- `--close` sempre ammesso; il cambio d'impronta dopo l'attivazione resta negato come oggi.

### 3.6 Intento — DT-026

Nuovo input `autonomy` e `plan_needs_approval` (calcolato come in 3.5): con `plan_needs_approval: false` l'esito è
`avvia` invece di `mostra-piano`; con approvazione necessaria resta `mostra-piano` (che ora chiede una frase sola).
Gli override esistenti (produzione ⇒ rifiuta, classe non ammessa ⇒ rifiuta, elemento critico ⇒ chiedi) vincono.

### 3.7 Visibilità e audit

- `session show` / `/use` mostrano livello e fonte ("autonomia: alta (predefinita)").
- Ogni decisione consentita senza frase grazie al livello porta `autonomy: <livello>` nel payload d'audit del guard e
  di step-check; il rapporto finale di ops elenca i passi con effetto eseguiti (come l'elenco `effects`).

### 3.8 Istruzioni e documenti

`commands/ops.md`, `agents/scope-expert.md` (senza frasi letterali nel corpo dell'agente), `skills/agent-manager`,
`docs/MANUAL.md` (§52, §57.2, tabella frasi), `MANUALE-UTENTE.md`, `docs/GUIDA-PRIMO-USO.md`, `README.md`: livelli,
frasi, file del cliente, cosa resta sempre chiesto.

## 4. Flusso (pre-produzione, livello alto, "crea ordine e invialo")

1. ops → intent DT-026: R2 in preprod, piano con approvazione ⇒ `mostra-piano`.
2. compose-plan → piano; step-check `--activate`: `planApproval` vede passi R2 ⇒ richiesta A1 (una).
3. L'utente scrive `APPROVO PIANO <id>`; il manager riprende l'agente.
4. Passi di creazione: nessuna richiesta. Passo SUBMIT: `requiredApprovals` → `a1` (già data, nella finestra, stessa
   impronta) ⇒ consentito senza `sì`. Fine, rapporto con i passi eseguiti.

Stesso caso in sandbox: nessuna frase, l'agente va dall'inizio alla fine.

## 5. Errori e casi limite

- Livello abbassato a metà piano (`AUTONOMIA BASSA`): vale dal passo successivo — `gateStep` e il guard rileggono il
  livello a ogni passo e chiedono le approvazioni mancanti.
- Livello alzato a metà piano: vale dal passo successivo; nessuna approvazione già chiesta viene "consumata" a vuoto.
- Finestra A1 scaduta durante un piano lungo ad autonomia alta: si richiede `APPROVO PIANO` (come oggi).
- `autonomy.yaml` malformato ⇒ `basso` + avviso in `session show`.

## 6. Test (prima rossi, poi verdi)

- `autonomyLevel`: frase > cliente > predefinito; file malformato ⇒ basso.
- Frasi: parse, registrazione, guard-phrase nega `AUTONOMIA ALTA` scritta dal modello.
- `requiredApprovals`: tabella 3.4 per livello × classe × ambiente; produzione invariata; `second_approver_required`.
- step-check: attivazione senza A1 in preprod (alto, piano R1); con A1 una volta e SUBMIT senza `sì` (alto); medio e
  basso come la tabella; abbassamento a metà piano.
- guard config-scope: click di SUBMIT in preprod consentito con A1 ad alto, negato senza `sì` a basso.
- DT-026: `avvia` con `plan_needs_approval: false`.
- Documenti: frasi nuove nella tabella, nessuna frase letterale nel corpo degli agenti.
- Suite completa con corpus e `test:timing` verdi.

## 7. Rischi

- In pre-produzione, ad autonomia alta, un piano di sola creazione scrive dati senza chiedere; con invio basta una
  frase per e-mail ai fornitori o dati verso l'ERP: verificare col cliente che la pre-produzione non li mandi davvero,
  oppure impostare `default: medio` in `customers/<C>/config/autonomy.yaml`.
- Configurazione e massive in pre-produzione coperte da una sola frase (scelta dell'utente): il secondo approvatore
  resta dove la policy lo richiede.
