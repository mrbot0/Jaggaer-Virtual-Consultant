# Ops veloce — autonomia, import massivi con template, scritture in produzione, cancellazioni

Stato: **proposta da approvare** · ramo `feature/autonomia-ops` · data 06–07/10/2026.
Il merge su `main` lo fa l'utente. Il codice si scrive solo dopo l'approvazione di questa specifica e del piano.

## 1. Obiettivo

Richieste dell'utente:

- 06/10: «vorrei ops più veloce e meno cerimoniale, possiamo dare un livello di autonomia ad ops? impostiamolo di
  default ad alto».
- 07/10: «massimizzare la velocità dell'apprendimento sulle singole pagine e nella riproduzione di configurazioni, es.
  per la creazione di uno o più data element vogliamo che gli agenti scarichino il template di caricamento massivo, lo
  compilino e poi lo importino, nel modo più veloce possibile, stessa cosa per tutte le operazioni massive possibili»;
  «gli import massivi come dei workflow, template, se richiesti devono essere consentiti anche in prod come le
  operazioni e le configurazioni, ma in prod il grado di autonomia non può essere alto ma al limite medio, e prima di
  modificare/caricare chiede sempre approvazione»; «in preprod attiviamo anche le cancellazioni».

Questa specifica **cambia decisioni dell'architettura v8.0** per scelta esplicita dell'utente: §52.1 (in produzione mai
scritture), §29.4 (catalogo delle azioni: ACT-BULK solo sandbox, ACT-DELETE mai), ADR-06 (nessun verbo DELETE).
I documenti dell'architettura e il catalogo `product/kb/actions/` vanno aggiornati insieme al codice.

Criteri di successo:

- sandbox, autonomia alta: "crea ordine e invialo" parte e finisce senza domande;
- pre-produzione, autonomia alta: un piano di sola creazione parte senza domande; un piano con invii, configurazione o
  cancellazioni chiede **una sola** frase;
- "crea 30 data element" con un template noto: un import invece di 30 maschere, senza domande in sandbox e
  pre-produzione (alto);
- produzione: operazioni, configurazioni e import possibili, ogni modifica o caricamento approvato prima.

Fuori da questa specifica (specifiche successive): agenti in parallelo su schede diverse (lo stato del browser oggi è
uno per sessione); trasformare le procedure dei documenti in piani eseguibili.

## 2. Regole (decise dall'utente il 06–07/10/2026)

### 2.1 Livelli e tetto per ambiente

Livelli: `alto` (predefinito), `medio`, `basso`. Il livello **effettivo** è il minimo fra quello scelto e il tetto
dell'ambiente: sandbox e pre-produzione → `alto`; **produzione → `medio`**.

### 2.2 Cosa si chiede

| | sandbox | pre-produzione | produzione (tetto medio) |
|---|---|---|---|
| creare, aggiornare (R1) | nulla | alto: nulla · medio/basso: `APPROVO PIANO` | `APPROVO PIANO` + `APPROVO PASSO n` prima di ogni passo che modifica |
| inviare, approvare, trasmettere, pubblicare, chiudere, caricare (R2) | alto/medio: nulla · basso: `sì` per passo | alto/medio: coperti da `APPROVO PIANO` · basso: `sì` per passo | `APPROVO PIANO` + `APPROVO PASSO n` |
| configurazione (ACT-CFG-CHANGE) | alto: `APPROVO PIANO` · medio/basso: per policy (A1/A3/A2) | alto: `APPROVO PIANO` · medio/basso: per policy | `APPROVO PIANO` + `APPROVO PASSO n` (+ istantanea prima) |
| import massivi (ACT-BULK) | alto: nulla · medio/basso: `APPROVO PIANO` + `APPROVO PASSO n` | alto: nulla · medio/basso: `APPROVO PIANO` + `APPROVO PASSO n` | `APPROVO PIANO` + `APPROVO PASSO n` prima del caricamento |
| cancellare (ACT-DELETE) | alto: coperte da `APPROVO PIANO` · medio/basso: + `APPROVO PASSO n` | alto: coperte da `APPROVO PIANO` · medio/basso: + `APPROVO PASSO n` | **mai** |

In produzione `sì` resta rifiutato (troppo generico): l'approvazione di ogni passo è `APPROVO PASSO <n> <PLAN>`,
monouso, legata al piano. A ogni livello e ambiente restano:

- `APPROVO PROVA` (A2, persona diversa da A1) quando l'ambiente ha `second_approver_required` — in produzione è
  preimpostato a sì in `environments.yaml` e lo cambia solo l'utente;
- le frasi le scrive solo l'utente (guard-phrase); registro delle approvazioni protetto, a catena di hash, ogni record
  confermato nel transcript; A1 legata all'impronta del piano, finestra `config_window_minutes` (default 60);
- compensazione registrata prima di creare, aggiornare, inviare, importare; per configurazioni e cancellazioni,
  lettura completa (istantanea) degli oggetti toccati salvata prima, per poterli ripristinare;
- ogni click/input legato al SEL del passo; host dichiarati; nessuno script nella pagina; verifica dell'impronta
  dell'ambiente; l'esplorazione non cancella e non carica file mai;
- elenco finale di ciò che è stato creato, modificato, importato o cancellato, con l'audit del livello applicato.

## 3. Componenti

### 3.1 Livello effettivo — `hooks/lib/autonomy.mjs` (nuovo)

`autonomyLevel({ ws, customer, records, envType })` → `{ level, chosen, source }`:

1. ultimo record `{ kind: "autonomy", level }` nel registro delle approvazioni della sessione (frase dell'utente);
2. altrimenti `customers/<C>/config/autonomy.yaml` → `{ default: alto|medio|basso }` (schema
   `schemas/autonomy.schema.json`; `customers/*/config/**` è scrivibile solo dall'utente);
3. altrimenti `alto`;

poi `level = min(chosen, tetto(envType))`. Fail-closed: file del cliente illeggibile o valore fuori elenco ⇒ `basso`
con avviso. Modulo leggero (percorso dei guard).

### 3.2 Frasi `AUTONOMIA ALTA` · `AUTONOMIA MEDIA` · `AUTONOMIA BASSA`

`parseApprovalPrompt` → `{ kind: "autonomy", level }`; approval-capture registra il record; guard-phrase le aggiunge
alle frasi che il modello non può scrivere. Valgono per la sessione finché l'utente non ne scrive un'altra.

### 3.3 Catalogo delle azioni (§29.4) — `hooks/lib/act-classes.mjs` + `product/kb/actions/*.yaml`

| classe | sandbox | preprod | prod |
|---|---|---|---|
| ACT-CREATE, ACT-UPDATE, ACT-UPLOAD, ACT-SUBMIT, ACT-CLOSE | allowed | allowed | **approval** (era never) |
| ACT-APPROVE, ACT-TRANSMIT, ACT-PUBLISH | allowed | referent | **approval** (era never) |
| ACT-CFG-CHANGE | approval | approval | approval (era 3A) |
| ACT-BULK | approval | **approval** (era never) | **approval** (era never) |
| ACT-DELETE | **approval** (era never) | **approval** (era never) | never |

Il test che confronta `act-classes.mjs` con gli item resta; gli item si aggiornano nella stessa modifica.

### 3.4 Approvazioni richieste — `requiredApprovals(cls, step, env, cfgLevel, autonomy)`

Una funzione, usata dal guard (`config-scope.mjs`, al click) e da `step-check` (`gateStep`, prima del passo), che
applica la tabella 2.2 → `{ a1, a2, a3, action }` (`a3` = `APPROVO PASSO n`). `autonomy` assente ⇒ `basso`.

### 3.5 Attivazione del piano — `step-check` `planApproval`

A1 serve all'attivazione se almeno un passo, con `requiredApprovals`, chiede qualcosa, o se il livello è medio/basso
fuori sandbox. Pre-produzione alto con piano di sola creazione/import: si attiva subito. Produzione: sempre A1.
Impronta cambiata dopo l'attivazione: negato come oggi.

### 3.6 Produzione — `guards/production.mjs`, `validate-plan.mjs`, `environments.schema.json`

- Le scritture non sono più negate in blocco: guard-production lascia passare i passi di un piano attivo con A1 e il
  token del passo; tutto il resto (azioni senza piano, scritture fuori passo, DELETE) resta negato.
- `validate-plan`: in produzione rifiuta solo ACT-DELETE.
- `prodPolicy` dello schema degli ambienti: `write_data` diventa effettivo (default `true` dopo questa modifica,
  l'utente può spegnerlo per ambiente); `second_approver_required` default `true`.
- DT-026: produzione non è più "rifiuta" per le scritture: esito `mostra-piano`; ACT-DELETE in produzione ⇒ rifiuta.

### 3.7 Cancellazioni — verbo `DELETE`

- Schema del piano: verbo `DELETE` (ADR-06 superato per sandbox e pre-produzione), classe ACT-DELETE, `target` SEL
  obbligatorio, `expect` obbligatorio (l'oggetto non c'è più).
- Prima del passo: una lettura completa dell'oggetto (`kb snapshot` degli oggetti governati o READ del record)
  salvata in `runs/<RUN>/evidence/`; compensazione `restore` dichiarata con quel riferimento.
- Guard: un click su un'etichetta di cancellazione (`isDeleteLabel`) è consentito **solo** se il passo attivo è un
  DELETE legato a quel SEL; altrove resta negato (esplorazione completa compresa). La conferma del dialogo di
  cancellazione vale solo dentro quel passo.

### 3.8 Import massivi con template

**Conoscenza — item `TPL`** (`customers/<C>/kb/scopes/<S>/templates/`, schema `schemas/tpl.schema.json`):
oggetto (es. "data element", "workflow"), modulo, pagina di import (`page_sig` + percorso), SEL di "scarica template"
e di "carica", file vuoto (percorso nella knowledge del cliente + sha256), fogli, riga d'intestazione, colonne
(`name`, `required`, `type`, `values` dalle convalide a lista, `example`), fonte (`utente` | `tenant`), data.

**Fonti** (entrambe, decisione dell'utente): i template forniti dall'utente (cartella `customers/<C>/templates-in/` o
`/kb ingest`) hanno la precedenza; se manca, l'agente scarica quello del tenant — anche in esplorazione (click su
"scarica" + `get_network_request` con `responseFilePath` nella cartella della sessione, già ammesso dai guard). Se
l'import segnala un formato cambiato, si riscarica e si reimpara.

**Script:**

- `kb template-learn --file <xlsx|csv> --object <oggetto> [--page <sig>]` — usa `parse-xlsx` (intestazioni, fogli
  nascosti, liste di valori) e scrive il `TPL` e il file vuoto;
- `ops template-fill --tpl <code> --data <righe.json> --out runs/<RUN>/import/<file>` — copia il file vuoto e scrive le
  righe nel foglio XML (stili e convalide intatti; zip scritto con `node:zlib`, nessuna dipendenza nuova); prima
  controlla ogni riga (obbligatori, valori ammessi, tipi) e restituisce gli errori senza toccare il tenant; stampa
  sha256 e numero di righe;
- `ops import-result --in <file esito>` — legge l'esito (pagina o file di log scaricato) e separa righe riuscite e
  fallite.

**Piano** (compose-plan): se per l'oggetto esiste un `TPL`, la via massiva è **sempre** preferita, anche per un solo
record. Passi: NAVIGATE alla pagina di import → UPLOAD (`file: { path, sha256, rows }`, ACT-BULK, più ACT-CFG-CHANGE
se l'oggetto è di configurazione) → SUBMIT/conferma → READ dell'esito. Righe fallite: correzione e reimport solo di
quelle, al massimo 2 volte, poi rapporto. I record creati (dall'esito) entrano nell'elenco finale.

**Guard dell'upload** (nuovo, ogni ambiente): `upload_file` solo di un file dentro `customers/<C>/runs/<RUN attivo>/`
con sha256 uguale a quello del passo UPLOAD attivo; ogni altro percorso è negato (oggi l'upload non controlla il
percorso: chiude anche il rischio di caricare file qualsiasi del PC).

### 3.9 Esecuzione più veloce

- **Moduli in un colpo**: compose-plan raggruppa i FILL/CHOOSE consecutivi della stessa pagina in un passo
  `FILL` con `fields: [{ target: SEL, value }]` eseguito con `fill_form`; il guard verifica che ogni uid sia legato al
  proprio SEL; step-check verifica una volta dopo.
- **Meno letture**: click e compilazioni con `includeSnapshot: true`; observe-append già registra lo snapshot della
  risposta, quindi niente `take_snapshot` separato prima dell'azione successiva sulla stessa pagina.
- **Una chiamata per passo**: `step-check --advance` verifica il passo appena eseguito e attiva il successivo nella
  stessa invocazione.

### 3.10 Visibilità, audit, documenti

- `session show` / `/use`: livello effettivo, scelto, fonte, tetto dell'ambiente.
- Payload d'audit con `autonomy` su ogni decisione consentita senza frase; rapporto finale con l'elenco delle modifiche.
- Aggiornati: `commands/ops.md`, `agents/scope-expert.md` (senza frasi letterali), `skills/agent-manager`,
  `docs/MANUAL.md` (§29.4, §52, §57.2, ADR-06), `MANUALE-UTENTE.md`, `docs/GUIDA-PRIMO-USO.md`, `README.md`.

## 4. Flussi

**Pre-produzione, alto, "crea 30 data element":** TPL noto → `template-fill` (controllo righe) → compose-plan: import
→ si attiva senza frase → UPLOAD (file del run, sha256 verificato) → conferma → esito: 28 ok, 2 errori → correzione e
reimport delle 2 → rapporto con i 30 codici creati.

**Produzione, "importa il workflow di approvazione":** TPL → file compilato → piano → l'utente scrive `APPROVO PIANO
<id>` (con `DA <nome>` e `APPROVO PROVA` se c'è il secondo approvatore) → istantanea della configurazione → l'agente
mostra file, righe e oggetti toccati e chiede `APPROVO PASSO <n> <id>` → caricamento → esito → rapporto.

**Sandbox, alto, "crea ordine e invialo":** nessuna frase dall'inizio alla fine.

## 5. Errori e casi limite

- Livello cambiato a metà piano: vale dal passo successivo (guard e step-check rileggono il livello a ogni passo).
- Finestra A1 scaduta in un piano lungo: nuova `APPROVO PIANO`.
- File compilato modificato dopo il piano: sha256 diverso ⇒ upload negato.
- Template del tenant cambiato: errore di formato all'import ⇒ riscarica, reimpara, ricompila (una volta), poi chiede.
- `autonomy.yaml` malformato ⇒ `basso` + avviso.

## 6. Test (prima rossi, poi verdi)

- `autonomyLevel`: frase > cliente > predefinito; tetto medio in produzione; file malformato ⇒ basso.
- Frasi: parse, registrazione, guard-phrase.
- `requiredApprovals`: tabella 2.2 per livello × classe × ambiente; `second_approver_required`.
- Catalogo: `act-classes.mjs` = item aggiornati.
- step-check: attivazione senza A1 (preprod alto, sola creazione/import); A1 una volta e SUBMIT senza `sì` (alto);
  produzione: A1 + `APPROVO PASSO` per ogni passo che modifica; `sì` rifiutato in produzione.
- guard-production: passo di piano approvato consentito; scrittura senza piano negata; DELETE negato.
- Cancellazioni: click "Elimina" consentito solo nel passo DELETE legato; negato in esplorazione; lettura prima.
- Template: `template-learn` (colonne, obbligatori, liste), `template-fill` (righe valide/invalide, xlsx rileggibile
  da `parse-xlsx` con stili e convalide), `import-result`; upload negato fuori dal run o con sha256 diverso.
- compose-plan: via massiva preferita con TPL; FILL raggruppato.
- Suite completa con corpus e `test:timing` verdi.

## 7. Rischi

- Produzione scrivibile: un piano approvato male modifica dati reali; mitigato da A1 + `APPROVO PASSO` per ogni
  modifica, istantanee, compensazioni, secondo approvatore preimpostato.
- Pre-produzione ad alto: import massivi senza frase e cancellazioni coperte da una sola frase; e-mail ai fornitori e
  dati verso l'ERP possono partire davvero — verificare col cliente o impostare `default: medio` per quel cliente.
- Cancellazioni: irreversibili nel tenant; la lettura salvata prima permette di ricreare, non di ripristinare
  identificativi e storico.
