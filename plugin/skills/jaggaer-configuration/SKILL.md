---
name: jaggaer-configuration
description: Metodo per il lavoro di configurazione — procedura CFP composta S più deviazioni C, rischio con DT-007 e perimetro verde · giallo · rosso, check pre e post, snapshot, compensazione registrata prima del passo, prova a vuoto, approvazioni per rischio (A1 piano, A2 prova, A3 passo) e protocollo 3A in produzione, checkpoint e ripresa idempotente, rollback proposto e mai applicato da solo, verificatore NRT…CFG, custom del cliente, audit di deriva. Usala quando progetti una modifica (/cfg design), la applichi su Chrome (/cfg apply, anche --dry-run o --resume), la verifichi, fai l'audit delle regole e della deriva, o misuri la copertura della configurazione.
---

# jaggaer-configuration — configurare con disciplina (§28)

Configurare è l'azione con più leva e più rischio: una modifica sbagliata a un workflow o a un permesso tocca tutti
gli utenti. Il metodo rende ogni modifica **progettata, provata, approvata, compensabile e verificata**.

## I tre confini (§28.1)

1. **Sandbox o ambiente di test.** In produzione: solo con il protocollo 3A (sotto) e mai sugli oggetti in perimetro
   rosso non espressamente ammessi dal cliente; **nessun dato** si scrive in produzione, mai.
2. **Snapshot prima, verificatore dopo.** Ogni modifica è preceduta dallo snapshot degli oggetti governati e seguita
   dal verificatore `NRT.<C>.<S>.CFG`. Il rollback si **propone**, non si applica in autonomia.
3. **Autonomia per rischio** (DT-007): verde = approvazione in sessione; giallo = più change request e finestra;
   rosso = eseguibile solo con approvazione esplicita **passo per passo**.

## Progettare (§28.3 passi 1–7)

| Passo | Metodo |
|-------|--------|
| 1 risoluzione | `kb resolve` → CFP standard (S) e deviazioni del cliente (C), con W |
| 2 composizione | S più deviazioni **in ordine di passo** (la C dichiara il delta, skill `coding-system`) |
| 3 richiamo | precedenti sulla CFP e sul cluster CL-CFG; forma epistemica del CFG governato; `gaps` |
| 4 strategia | DT-017: consolidato con precedente → `STR-REPLAY`; libresco → `STR-VERIFY-FIRST` → `STR-DRY-RUN`; con ipotesi → `STR-MIN-CHANGE` |
| 5 confronto | composizione contro l'ultima osservazione della schermata: elemento previsto assente → CTR e stop |
| 6 rischio | DT-007 con il prior di smentita per area e cliente → rischio e perimetro |
| 7 domande | dai gaps, se DT-002 lo dice, **prima** di toccare (skill `asking-the-user`) |

Impatto a valle prima di toccare un campo o un oggetto: `kb impact` e `kb related` (skill `field-modeling`). Su una
forma `libresco` il progettista **elenca prima le osservazioni R0** necessarie: non si progetta su ciò che non si è
mai visto qui. Il piano porta: CFP composta, traccia attesa con `expect` per passo, impatto, rischio, CHK pre e post,
snapshot previsto, rollback, verificatore, approvazioni che serviranno, finestra.

**Rischio tipico per area** (§28.5) da cui DT-007 parte e che poi corregge (rollback esistente, raggio sul grafo,
finestra, maturità, forma epistemica, prior): struttura organizzativa, permessi, workflow, numerazioni,
integrazioni, SSO, valute e fiscalità sono di norma R3; form, cataloghi, tassonomie, validazioni R2; template,
notifiche, allegati, lingue, scadenze, scorecard R1. **Un R2 su soggetto `libresco` sale a R3 di fatto.**

## Eseguire (§28.3 passi 8–13, §45.4)

| Passo | Metodo |
|-------|--------|
| 8 check pre | i CHK della famiglia pre-modifica, da script; un fallimento blocca |
| 9 snapshot | di **tutti** gli oggetti governati (lo snapshot incompleto è la causa classica di un rollback impossibile) |
| 10 esecuzione | su Chrome via MCP, un passo alla volta con step-check; la compensazione è registrata **prima** del passo che crea o modifica; ogni SAVE/SUBMIT/TOGGLE è preceduto da un READ dello stato (idempotenza) |
| 11 check post | CHK post-modifica e verificatore NRT...CFG |
| 12 lezione | esito atteso dichiarato (di norma: il verificatore verde entro la sessione) |
| 13 osservazioni | l'estrattore dello scope le legge: Atlas, CFG, forma epistemica aggiornati |

La prima esecuzione su una procedura non consolidata è di norma una **prova a vuoto** (`--dry-run`: i SAVE/SUBMIT
diventano CAPTURE) con il confronto di ogni schermata; solo dopo, per davvero.

    node "${CLAUDE_PLUGIN_ROOT}/scripts/compile/compile-cfp.mjs" --cfp <CFP> --dry-run --customer <C> --env <ambiente> --json
    node "${CLAUDE_PLUGIN_ROOT}/scripts/run/checks-run.mjs" --cluster CL-CHK-002 --plan <piano> --run <RUN> --json

**Checkpoint e ripresa**: step-check scrive un checkpoint dopo ogni passo; se il browser muore, `--resume <n>` indica
le letture da fare prima di ripetere un passo con effetto — si rilegge lo stato e si salta ciò che risulta già fatto.

## Approvazioni: chi le dà e come si chiedono (§52.2)

Le approvazioni le scrive **solo l'utente**, con frasi esatte che registra un hook; tu non le scrivi mai (né in un
input di strumento, né in un file, né nel rapporto: il guard lo nega). Quando step-check risponde
`approval_required`, restituisci `status: needs-input` con il campo strutturato
`approval_request: { kind: A1 | A2 | A3, plan: <PLAN>, step: <n> }` (step solo per A3), compilato dal primo
elemento di `pending` dell'uscita — **mai** il testo del campo che contiene la frase. La frase la mostra all'utente
la sessione principale; poi ti ridispaccia con `reply_to` e riprendi dal checkpoint.

| Situazione | Approvazioni |
|------------|--------------|
| verde (fuori sandbox) | A1 del piano |
| giallo | A1, poi A3 per ogni passo che lo chiede |
| rosso | A1, A2 della prova, A3 per passo |
| **produzione, sempre (3A)** | A1 (piano, con rischi e assunzioni mostrati prima dei passi), A2 (prova: esecuzione verde in pre-produzione allineata **e** prova a vuoto in produzione senza sorprese incompatibili; se richiesto da una persona diversa), A3 per ogni passo con effetto; tutto entro la finestra dall'A1 (di default 60 minuti), scaduta si ricomincia |

In sandbox o dev un piano si attiva senza A1; negli altri ambienti l'attivazione del piano richiede l'A1 dell'utente.

## Il custom del cliente (§28.4)

| Fonte | Produce | Conferma |
|-------|---------|----------|
| documento di progetto o configurazione | CFG C con `deviates_from`, CFP C con `deviations` | osservazione |
| ricognizione del tenant | CFG L con stato attuale e impronta della baseline | tre ricognizioni → 1.00 |
| dichiarazione dell'utente | CFG L testimoniale | osservazione |
| documento ≠ tenant | CTR; di norma vince l'osservazione confermata (DT-011) | — |
| plugin del cliente | CFG C con opzioni estese, SEL dedicate | osservazione |

Un custom non documentato scoperto per osservazione è la scoperta più preziosa: registralo e chiedi "è voluto?".

## Verificare, auditare, coprire

- **Verificatore** (§28.6): il campo compare, è obbligatorio quando dichiarato, accetta i valori dichiarati, compare
  nel payload se rilevante. Si genera dalla CFP (`compile-cfp --verify`) ed è di sola lettura: ammesso anche in
  produzione.
- **Audit** (regole RUL e deriva): baseline dall'osservazione, lint delle regole, diff fra baseline o fra ambienti;
  si **propone** un drift noto, non si corregge nulla e il file degli ambienti non si tocca mai. Le regole RUL sono
  del dominio analitico: i loro codici non entrano mai in `kb/` né nei test (skill `domain-boundary`).
- **Copertura** (§28.2): per ogni scope e area CL-CFG una CFP S validata e una deviazione C dichiarata (anche vuota),
  con la forma epistemica prevalente. "Coperto ma libresco" vuol dire: la procedura esiste, non è mai stata vista
  funzionare qui.

## Errori tipici

- Eseguire senza snapshot completo o senza compensazione registrata (il passo è negato comunque).
- Applicare il rollback da solo quando la verifica fallisce: si propone, è una modifica con le sue approvazioni.
- Cancellare un oggetto: il verbo non esiste; si disattiva o si chiude.
- Riformulare o anticipare all'utente una frase di approvazione.
