# JAGGAER Virtual Consultant — Manuale utente

Tutto quello che serve per usare il plugin, dalla A alla Z: installazione del plugin e del workspace della conoscenza,
come gli si parla, chi sono gli agenti, quali comandi e skill ha, come si seguono e si controllano. Per il
riferimento tecnico completo vedi il [Manuale di riferimento](docs/MANUAL.md).

**Indice** — [1. In un minuto](#1-in-un-minuto) · [2. Come funziona](#2-come-funziona) ·
[3. Installazione dalla A alla Z](#3-installazione-dalla-a-alla-z) · [4. Il primo cliente](#4-il-primo-cliente) ·
[5. I comandi](#5-i-comandi) · [6. Gli agenti](#6-gli-agenti) · [7. Le skill](#7-le-skill) · [8. Le frasi](#8-le-frasi) ·
[9. Seguire il lavoro](#9-seguire-il-lavoro) · [10. Scenari tipici](#10-scenari-tipici) ·
[11. Salvare e aggiornare](#11-salvare-e-aggiornare) · [12. Problemi frequenti](#12-problemi-frequenti) ·
[13. Glossario](#13-glossario)

---

## 1. In un minuto

Il plugin è un **consulente JAGGAER virtuale** dentro Claude Code. Lavora su JAGGAER **attraverso Chrome**, come farebbe
un consulente: esplora il sistema, esegue attività (crea richieste, ordini, contratti…), collauda le release,
progetta e applica configurazioni, diagnostica i problemi. Quello che impara lo **memorizza** in una conoscenza che
cresce, cliente per cliente.

Gli si parla in tre modi:

| Modo | Esempio | Quando |
|---|---|---|
| **A parole** (un intento) | *"Su ACME pre-produzione crea un ordine per 5 sedie, centro di costo IT-0442, lascialo in bozza"* | Quasi sempre: il plugin capisce cosa fare e con quale agente |
| **Con un comando** | `/jaggaer-virtual-consultant:ops crea ordine …` | Quando vuoi essere preciso o l'azione è amministrativa |
| **Con una frase** di approvazione o di controllo | `APPROVO PIANO PLAN.ACME.0003` · `sì` · `PAUSA TUTTI` | Quando il plugin te la chiede, o per fermare gli agenti |

Le frasi le scrivi **solo tu**, da sole nel messaggio, in maiuscolo: il plugin non può scriverle al posto tuo.

---

## 2. Come funziona

```
  TU  ──intento / comando / frase──►  MANAGER (la sessione principale, skill agent-manager)
                                        │  capisce, divide il lavoro, sceglie agente e modello,
                                        │  ti mostra piani e domande, raccoglie i risultati
                                        ▼
                                    15 AGENTI specialisti (sub-agenti)
                                        │  ognuno lavora in una "cella": un cliente, uno scope, una modalità
                                        │  seguono un ciclo di ragionamento fisso e le skill del loro mestiere
                                        ▼
                              CHROME (via MCP) · SCRIPT del plugin · CONOSCENZA (knowledge/)
                                        ▲
                         CONTROLLI DI SICUREZZA E MONITOR (hook: codice, non il modello)
                         bloccano ciò che non è permesso · registrano tutto · applicano le tue frasi
```

- **Il manager** non fa il lavoro di dominio: instrada, coordina, ti parla. È la sessione di Claude Code stessa,
  guidata dalla skill `agent-manager`.
- **Gli agenti** fanno il lavoro. Ognuno ha un compito preciso, un modello adatto (haiku per i compiti meccanici,
  sonnet per l'operatività, opus per il ragionamento difficile) e solo gli strumenti che gli servono.
- **I controlli di sicurezza** sono codice: negano un'azione vietata anche se un agente la tentasse (salvare in
  produzione, uscire dal proprio cliente, premere "Elimina"…).
- **Il monitor** registra ogni azione di ogni agente: puoi vedere in ogni momento cosa sta facendo e fermarlo.
- **La conoscenza** sta nella cartella `knowledge/` del repository, **fuori dal plugin**: conoscenza del prodotto
  (livello **S**), di ogni cliente (livello **C**, in `customers/<CODICE>/`) e appresa sul campo (livello **L**).

### Il repository

```
Jaggaer-Virtual-Consultant/
├── plugin/        il plugin (questo manuale è qui) — si installa in Claude Code
├── knowledge/     la conoscenza — si apre come workspace di Claude Code
├── .claude-plugin/marketplace.json   il "negozio" privato da cui Claude Code installa il plugin (nome: jaggaer-vc)
└── README.md
```

Sono separate perché il plugin installato è un pacchetto protetto (verifica d'integrità, controlli di sicurezza) e
viene copiato da Claude Code nella sua cache: la conoscenza deve crescere fuori da esso.

### Ambienti: cosa si può fare dove

| Ambiente | Leggere | Esplorare cliccando | Creare / modificare dati | Configurare |
|---|---|---|---|---|
| **sandbox** | sì | sì (`ESPLORA SANDBOX`) | sì, con piano | sì, approvazioni per rischio |
| **pre-produzione** | sì | solo click senza effetto (`ESPLORA PREPROD`) | sì, con `APPROVO PIANO` e `sì` all'invio | sì, approvazioni per rischio |
| **produzione** | sì | no | **mai** | solo con tre approvazioni, una da una seconda persona |

Prima di agire il plugin **verifica** di essere davvero nell'ambiente dichiarato (almeno due segnali sulla pagina:
titolo, banner, id del tenant). Finché non è verificato può solo navigare e leggere.

### Modalità

`nrt` (collaudo) · `config` (configurazione) · `ops` (operatività) · `diag` (diagnosi) · `esplorazione`. Di solito il
plugin la deduce dall'intento; si forza con `/jaggaer-virtual-consultant:use mode <modalità>`.

---

## 3. Installazione dalla A alla Z

### A. Prerequisiti

| Cosa | Note |
|---|---|
| **Claude Code** | Desktop o CLI, con un account che può usare i sub-agenti |
| **Node.js 22 o successivo** | `node --version` |
| **git** | Accesso al repository privato `mrbot0/Jaggaer-Virtual-Consultant` (utente GitHub autorizzato; `gh auth login` o credenziali git) |
| **Google Chrome** | Lo apre il server Chrome DevTools MCP del plugin |
| **Utenza JAGGAER** | Del tenant su cui lavori (sandbox o pre-produzione per iniziare); il login lo fai tu, il plugin non inserisce mai credenziali |

### B. Scaricare il repository

```bash
git clone https://github.com/mrbot0/Jaggaer-Virtual-Consultant.git
```

Da qui in poi `<REPO>` è la cartella scaricata (per esempio `C:\Users\<utente>\Jaggaer-Virtual-Consultant`).

### C. Installare le dipendenze del plugin

```bash
cd <REPO>/plugin
npm ci
```

Usa sempre `npm ci`, mai `npm install`: il file delle versioni è sotto verifica d'integrità e `npm install` potrebbe
riscriverlo (e allora i controlli di sicurezza negano tutto). Senza dipendenze i controlli negano ogni azione: è voluto.

### D. Installare il plugin in Claude Code

**Modo consigliato — dal marketplace del repository.** In Claude Code:

```
/plugin marketplace add <REPO>
/plugin install jaggaer-virtual-consultant@jaggaer-vc
```

(al posto della cartella locale puoi indicare il repository GitHub `mrbot0/Jaggaer-Virtual-Consultant`). Riavvia
Claude Code se richiesto.

> Claude Code copia il plugin installato nella sua cache. Se al passo G il controllo `deps` è rosso, `doctor` mostra
> la cartella esatta della copia installata: esegui lì `npm ci`.

**Modo alternativo — per provare o sviluppare**, avviando la CLI con il plugin preso direttamente dalla cartella:

```bash
claude --plugin-dir <REPO>/plugin
```

### E. Preparare il workspace della conoscenza (KB)

Il workspace è la cartella `<REPO>/knowledge`: contiene già la conoscenza del prodotto estratta dalla documentazione
JAGGAER (livello S, database compreso). Si apre **sempre questa cartella** in Claude Code, non `plugin/`.

1. Copia le impostazioni consigliate del workspace (abilitano il plugin e fissano i permessi minimi). Non sono nel
   repository di proposito: chi clona non eredita permessi in automatico. Leggile prima di copiarle:

   ```bash
   cd <REPO>/knowledge
   mkdir -p .claude
   cp ../plugin/templates/settings.template.json .claude/settings.json
   ```

2. Apri Claude Code in `<REPO>/knowledge` (CLI: `cd <REPO>/knowledge` e poi `claude`; desktop: apri la cartella).

3. Solo se il database della conoscenza manca o è danneggiato, ricostruiscilo:

   ```
   /jaggaer-virtual-consultant:kb reindex --all
   ```

   Per rigenerare la conoscenza del prodotto dai documenti originali (cartella di documentazione JAGGAER, che non è
   nel repository):

   ```bash
   cd <REPO>/plugin
   node scripts/ingest/ingest.mjs --input "<cartella della documentazione>" --root ../knowledge --scope XSC --origin vendor
   ```

**Un workspace nuovo e vuoto** (per esempio per un altro gruppo di clienti) nasce da solo: crea una cartella vuota,
aprila in Claude Code con le impostazioni del passo 1 ed esegui `/jaggaer-virtual-consultant:use customer <ID> --new`.
Il plugin crea la struttura (`product/`, `customers/<ID>/`, database). **Non creare mai il workspace dentro la
cartella `plugin/`**: il plugin lo rifiuta.

### F. Variabili d'ambiente (solo se servono)

| Variabile | Serve per |
|---|---|
| `XRAY_*`, `JIRA_*` | Pubblicare esiti e Defect su Xray/Jira |
| `NRT_<ENV>_*` | Credenziali delle utenze di collaudo per la corsia compilata (Playwright), opzionale |
| `JVC_PSEUDO_SALT` | Digestione settimanale fra clienti e analisi dei ticket |

Esporta solo quelle dell'ambiente su cui lavori. **Non impostare mai `JVC_DEV`** (disattiva le protezioni: è solo per
chi sviluppa il plugin).

### G. Verificare l'installazione

1. `/hooks` — ogni hook del plugin deve comparire **una sola volta**.
2. `/jaggaer-virtual-consultant:vc doctor` — tutto verde (il browser resta giallo finché non lo usi). Ogni riga rossa
   dice cosa fare.

### H. Consigli di sicurezza

- Rendi la cartella del plugin installato e `~/.claude` **di sola lettura** per il sistema operativo, o usa le
  impostazioni gestite di Claude Code: i controlli del plugin sono testuali e un modello ostile potrebbe aggirarli.
- Il repository contiene estratti della documentazione JAGGAER e, col tempo, dati dei clienti: deve restare
  **privato**.

---

## 4. Il primo cliente

1. **Crea il cliente** (codice di 4 caratteri):

   ```
   /jaggaer-virtual-consultant:use customer ACME --new
   ```

2. **Dichiara i suoi ambienti** con un editor, **fuori** da Claude Code (i controlli impediscono al plugin di
   modificarlo): `knowledge/customers/ACME/config/environments.yaml`. Esempio per la pre-produzione:

   ```yaml
   environments:
     - id: preprod
       type: preprod
       label: "ACME Pre-produzione"
       base_url: "https://acme-pre.jaggaer.com"
       allowed_hosts: ["acme-pre.jaggaer.com", "sso.acme.it"]
       fingerprint: { title_pattern: "^ACME PRE", banner: { text_pattern: "PRE-PROD" }, tenant_id: { value: "acme-pre" } }
       policy:
         write_data: true
         write_data_requires_referent: true
         config_levels: [verde, giallo, rosso]
         approvals: { config_verde: 1, config_giallo: 2, config_rosso: 3 }
         evidence_profile: strict
         budget_multiplier: 0.8
       credentials_prefix: "NRT_PRE_"
   ```

   - `allowed_hosts`: **tutti** gli host che il browser apre, compreso quello del login SSO.
   - `fingerprint`: almeno due segnali veri della pagina (apri il tenant a mano e copiali).
   - Tipi ammessi: `sandbox`, `preprod`, `dev`, `prod`. In produzione `write_data` è sempre `false`.

3. **Dichiara l'ambiente**: `/jaggaer-virtual-consultant:use env preprod`
4. **Fai il login**: alla prima navigazione si apre la finestra Chrome del plugin; accedi tu (SSO compreso).
5. **Fai verificare l'ambiente**: scrivi *"verifica l'ambiente"*.
6. **Controlla lo stato**: `/jaggaer-virtual-consultant:vc` — dice cosa fare adesso.

Da qui scrivi quello che vuoi fare. Percorso consigliato per un tenant nuovo: prima **esplora e memorizza** (§10),
poi **crea** documenti.

---

## 5. I comandi

Tutti iniziano con `/jaggaer-virtual-consultant:`. Sono otto famiglie.

### `vc` — il cruscotto
| Azione | A cosa serve |
|---|---|
| *(niente)* · `status` | Stato della sessione e **cosa fare adesso**, in ordine, con il perché |
| `agents` · `agents show <task_id>` · `agents history` | Cosa fa ogni agente adesso; la cronologia completa di uno; i compiti chiusi |
| `doctor` | Diagnosi dell'installazione (verde prima di operare) |
| `watch <sessione>` | Il workflow di una sessione, anche da un'altra finestra |
| `why <codice>` | Perché è stata presa una decisione (tabella, dati, strategia, cosa cambierebbe idea) |

### `use` — il contesto di lavoro
| Azione | A cosa serve |
|---|---|
| `customer <ID> [--new]` | Sceglie (o crea) il cliente |
| `env <id>` | Dichiara l'ambiente |
| `scope <ID>` | Sceglie l'area funzionale (vedi glossario) |
| `mode <nrt\|config\|ops\|diag\|esplorazione>` | Forza la modalità |
| `budget <n>` | Cambia il budget di token della sessione (es. `200k`) |
| `show` · `close-stale` | Mostra lo stato; chiude i sotto-compiti rimasti aperti |

### `ops` — operatività quotidiana
| Azione | A cosa serve |
|---|---|
| `esplora <modulo>` | Esplora un modulo (menu, pagine, pulsanti, campi, tendine) e lo **memorizza** |
| `crea <richiesta\|ordine\|fornitore\|evento\|contratto> …` | Crea in bozza; il piano nasce dalla memoria; al primo successo la procedura si memorizza |
| `approva` · `chiudi` · `pubblica <riferimento>` | Azioni che coinvolgono altri: sempre con il tuo `sì` |
| `query "<domanda>"` · `tables` · `learn-analytics` | Domande a JAGGAER Analytics, in sola lettura (anche in produzione) |

### `kb` — la conoscenza
| Azione | A cosa serve |
|---|---|
| `ingest <cartella> [--scope <S>]` | Carica documenti (manuali, specifiche, export): li legge, li spezza in unità, toglie i dati personali |
| `digest` · `review` | Gli agenti trasformano il materiale in conoscenza codificata; tu la rivedi (accetti, correggi, rifiuti) |
| `find` · `resolve "<domanda>"` | Cerca nella conoscenza |
| `fields --doc <documento>` · `identity <campo>` | I campi di un documento con i loro obblighi; la carta d'identità di un dato |
| `precedents` · `epistemic` · `impact` · `coverage` | Decisioni passate; quanto si sa di un argomento; cosa tocca una modifica; copertura |
| `graph` · `scopes` · `handoffs` · `clusters` · `contradictions` | Registri e coerenza della conoscenza |
| `atlas-build` · `atlas-write` | Li usano gli agenti: il primo trasforma le pagine registrate durante l'esplorazione in mappa e dice cosa manca ancora (tendine da aprire, campi senza etichetta, pagine senza percorso…), che l'agente completa da solo; il secondo corregge a mano (non serve chiamarli) |
| `reindex` · `migrate` | Manutenzione dell'indice e del database |

### `nrt` — collaudo (Non-Regression Test)
| Azione | A cosa serve |
|---|---|
| `plan <release>` · `run [--suite smoke\|full\|delta]` | Piano di collaudo di una release; esecuzione su Chrome |
| `explore <capability>` | Esplorazione a budget in sandbox |
| `triage` · `heal` | Classifica i fallimenti; ripara i test fragili con una PR da rivedere |
| `evidence` · `push-xray` · `report` | Evidenze, pubblicazione su Xray/Jira, report |
| `integration` · `compile` · `release-check` · `author "<descrizione>"` | Integrazioni; test Playwright opzionali; collaudo completo di una release; un caso di test su richiesta |

### `cfg` — configurazione
| Azione | A cosa serve |
|---|---|
| `design "<richiesta>"` | Progetta la modifica: procedura, impatto, rischio, controlli, rollback, domande |
| `apply <PLAN> [--dry-run]` | La applica su Chrome con checkpoint e approvazioni (verde 1 · giallo 2 · rosso 3 · produzione sempre 3) |
| `verify <PLAN>` · `audit` · `coverage` · `impact <CFG>` | Verifica, deriva fra ambienti, copertura, raggio d'azione |

### `learn` — apprendimento
| Azione | A cosa serve |
|---|---|
| `lessons` · `validate` | Le lezioni delle sessioni e la loro validazione |
| `outcomes` · `calibrate --propose` | Esiti delle decisioni; proposte per tarare le tabelle di decisione |
| `digest-weekly` · `competence-report` | Digestione settimanale fra clienti; cosa sa fare il sistema |
| `promote <codice>` | Promuove un'informazione del cliente a conoscenza generale (con `APPROVO PROMOZIONE`) |
| `tickets <xlsx>` · `patterns` · `brief --scope` | Analisi dei ticket di esercizio (dominio analitico) |

### `admin` — amministrazione
`retention` (pulizia dei dati scaduti) · `customer purge <ID>` (l'unica cancellazione: due approvazioni da due
persone) · `lock` · `session` · `integrity` (verifica che il plugin non sia stato alterato).

---

## 6. Gli agenti

Non li chiami direttamente: li attiva il manager in base a ciò che chiedi. Li vedi al lavoro con `vc agents`.

### L'operativo
| Agente | Cosa fa | Quando entra in gioco | Modello · Browser |
|---|---|---|---|
| **scope-expert** | Il consulente sul campo: esplora, crea, approva, collauda, configura e diagnostica su Chrome, un passo alla volta, verificando ogni pagina; memorizza ciò che vede e le procedure riuscite | `ops`, `nrt run/explore/integration/author`, `cfg apply`, diagnosi | sonnet · **sì** |

### La conoscenza (dai documenti)
| Agente | Cosa fa | Quando | Modello |
|---|---|---|---|
| **customer-profiler** | Profila il cliente: settore, moduli, ERP, integrazioni, quali documenti esistono, cosa manca | `kb ingest` della cartella di progetto | opus |
| **process-mapper** | Disegna i processi end-to-end del cliente e le differenze dallo standard; unico a leggere tutti gli scope del cliente (sola lettura) | onboarding del cliente | opus |
| **scope-extractor** | "Cosa dice questa fonte?": completa gli elementi estratti dai documenti, con citazione | `kb ingest` | haiku |
| **scope-digester** | "Cosa significa per questo cliente e come lo codifico?": trasforma i grezzi in conoscenza codificata | `kb digest` | opus |
| **cluster-validator** | Ammette, rifiuta, fonde o mette in quarantena la conoscenza digerita, con regole fisse | dopo lo scope-digester | opus |

### Collaudo e diagnosi
| Agente | Cosa fa | Quando | Modello |
|---|---|---|---|
| **failure-triage** | Classifica ogni fallimento: difetto del test o del prodotto, deriva di configurazione, ambiente, regressione… | `nrt triage` | haiku |
| **root-cause-analyst** | Trova la causa quando il triage non è sicuro: prima divergenza, ipotesi da smentire, controllo che l'avrebbe intercettato | escalation del triage | opus |
| **defect-reporter** | Scrive il Defect con evidenze e passi minimi; lo apre in Jira/Xray solo dopo che l'hai visto; mai un Incident | fallimento di prodotto o regressione | haiku · unico con accesso a Jira |
| **test-mechanic** | Ripara i test fragili senza indebolirli e prepara una PR da rivedere (mai merge automatico) | `nrt heal` | sonnet |

### Configurazione
| Agente | Cosa fa | Quando | Modello |
|---|---|---|---|
| **config-designer** | Progetta la modifica: procedura standard + deviazioni del cliente, impatto, rischio, controlli prima/dopo, rollback; non applica nulla | `cfg design` | opus |
| **config-auditor** | Controlla la configurazione contro le regole e la deriva fra ambienti; non corregge nulla | `cfg audit` | haiku |

### Apprendimento
| Agente | Cosa fa | Quando | Modello |
|---|---|---|---|
| **lesson-validator** | Verifica le lezioni delle sessioni (fondate, nuove, utili) | `learn lessons/validate` | sonnet |
| **weekly-digest** | Digestione settimanale: confronta i clienti (pseudonimizzati), propone cosa diventa conoscenza generale | `learn digest-weekly` | opus |
| **analytics-learner** | Impara il modello dati di Analytics e risponde con query verificate e salvate | `ops query/tables/learn-analytics` | sonnet · sì (sola lettura fuori sandbox) |

### Come lavora ogni agente

Ogni agente segue lo stesso **ciclo in sei passi** e lascia traccia di ognuno nel suo rapporto:

1. **Situare** — dove sono, cosa mi si chiede, con quale budget.
2. **Richiamare** — cosa so già (conoscenza, decisioni passate, cosa vedo adesso).
3. **Valutare** — quanto è affidabile ciò che so: consolidato, solo da documentazione, osservato, ignoto, contraddittorio.
4. **Decidere** — con una strategia e una tabella di decisione codificate, non a sensazione; ogni decisione è
   registrata con l'esito atteso.
5. **Agire** — un passo alla volta, verificando la pagina dopo ogni passo; se qualcosa sorprende, ripianifica o si ferma.
6. **Riflettere** — auto-verifica in dieci controlli e una lezione per la volta dopo.

---

## 7. Le skill

Le skill sono il **metodo**: dicono agli agenti *come* lavorare. Non contengono fatti su JAGGAER né dati dei clienti
(quelli stanno nella conoscenza) e non danno strumenti in più. Si attivano da sole quando il compito le richiede.
Sono 27.

| Gruppo | Skill | A cosa serve |
|---|---|---|
| **Regia** | `agent-manager` | Trasforma la sessione principale nel manager: instrada, coordina, ti mostra piani, domande e frasi da scrivere |
| **Ragionare** | `reasoning-cycle` | Il ciclo in sei passi |
| | `epistemic-awareness` | Capire quanto si sa di un argomento e quale fonte pesa di più |
| | `strategies` | Scegliere la strategia: ripetere, verificare prima, provare a vuoto, esplorare, chiedere presto… |
| | `decision-tables` | Usare le tabelle di decisione codificate |
| | `precedents` | Usare le decisioni passate senza ripartire da zero |
| | `belief-revision` | Reagire a sorprese e conferme durante il lavoro |
| | `asking-the-user` | Quando fare una domanda e come formularla |
| | `self-check-and-lesson` | Auto-verifica finale e lezione |
| **Conoscenza** | `coding-system` | I codici degli elementi di conoscenza |
| | `faceting-and-weights` | Le 15 caratteristiche di ogni elemento, affidabilità e qualità |
| | `clustering-rules` | Raggruppare e validare la conoscenza |
| | `field-modeling` | Modellare i campi dei documenti e i loro obblighi |
| | `identity-and-keys` | La carta d'identità dei dati e le chiavi |
| | `doc-ingestion` | Come si leggono e si digeriscono i documenti |
| | `token-economy` | Lavorare dentro il budget |
| **JAGGAER e collaudo** | `jaggaer-domain` | Orientarsi fra scope, livelli e termini del sistema |
| | `selector-strategy` | Trovare gli elementi della pagina e ripararli quando cambiano |
| | `nrt-authoring` | Scrivere casi di test |
| | `integration-testing` | Collaudare integrazioni e passaggi fra scope |
| | `evidence-and-xray` | Evidenze e pubblicazione su Xray |
| | `failure-forensics` | Diagnosi dei fallimenti |
| | `jaggaer-configuration` | Disciplina del lavoro di configurazione |
| **Sicurezza e confini** | `data-safety` | Mai dati personali o segreti nella conoscenza |
| | `scope-discipline` | Restare nella propria cella; leggere un blocco invece di aggirarlo |
| | `customer-isolation` | Mai attraversare i dati di un altro cliente |
| | `domain-boundary` | Tenere separate la conoscenza operativa e l'analisi dei ticket |

---

## 8. Le frasi

Scritte da te, **da sole nel messaggio**, in maiuscolo (un punto finale è tollerato).

### Approvazioni
| Frase | Quando |
|---|---|
| `sì` | Il plugin chiede conferma per un'azione che coinvolge altri (invio, approvazione, pubblicazione) |
| `APPROVO PIANO <PLAN>` | Per attivare un piano fuori dalla sandbox (per esempio "crea ordine" in pre-produzione) o una configurazione |
| `APPROVO PASSO <n> <PLAN>` · `APPROVO PROVA <PLAN>` | Configurazioni gialle e rosse; in produzione tutte e tre, con `DA <Nome Cognome>`, la prova da una seconda persona |
| `ESPLORA SANDBOX` · `ESPLORA PREPROD` | Aprire l'esplorazione (poi `use mode esplorazione` entro 10 minuti) |
| `APPROVO PROMOZIONE <codice>` · `APPROVO RETENTION <C>` · `APPROVO PURGE <ID> DA <Nome Cognome>` | Operazioni amministrative |
| `compensa tutto` · `lascia <entità>` | A fine sessione: annullare o tenere ciò che è stato creato |

### Controllo degli agenti
| Frase | Effetto |
|---|---|
| `PAUSA AGENTE <task_id>` · `PAUSA TUTTI` | Ferma temporaneamente (subito) |
| `RIPRENDI AGENTE <task_id>` · `RIPRENDI TUTTI` | Riprende |
| `FERMA AGENTE <task_id>` · `FERMA TUTTI` | Interrompe definitivamente (subito) |
| `PASSO PASSO <task_id\|TUTTI>` · `PASSO PASSO OFF` | Ogni azione con effetto aspetta il tuo `sì` |
| `SBLOCCA SCOPE <S>` | Sblocca un'area dopo tre compiti fermati da sorprese |
| `LIMITI DISPATCH <chiamate> <minuti>` | Cambia i limiti di ogni agente (predefiniti: 200 azioni, 30 minuti) |

Le frasi che aumentano la protezione valgono subito; quelle che la riducono dopo la conferma.

---

## 9. Seguire il lavoro

- **In conversazione**: il blocco del workflow mostra ambiente, passi (▶ in corso · ✓ fatto · ⏸ attende · ✗ fermato),
  budget e sorprese. Una riga ⏸ è sempre seguita dalla domanda; una ✗ dal motivo e da cosa serve per riprendere.
- **Console**: `/jaggaer-virtual-consultant:vc agents` — una riga per agente: cosa fa, da quanto, quanto budget ha
  usato, ultima azione, domande aperte. `vc agents show <task_id>` racconta tutto quello che ha fatto un agente e perché.
- **Da un terminale separato**, mentre gli agenti lavorano (sola lettura, senza modello):

  ```bash
  node "<cartella del plugin>/scripts/admin/agents.mjs" watch --session <SES.C.AAAAMMGG.NNN> --interval 5
  ```

- **Report**: ogni azione produce un report con l'esito (SUCCESS, EXPECTED-ERROR-AS-SUCCESS, ERROR-AS-LESSON,
  ERROR-BLOCKING…), cosa è stato creato, cosa resta pendente e cosa fare dopo.

---

## 10. Scenari tipici

| Vuoi… | Scrivi | Cosa succede |
|---|---|---|
| Imparare com'è fatto un modulo | `ESPLORA PREPROD` → `use mode esplorazione` → `ops esplora ordini` | scope-expert naviga, apre moduli e tendine, memorizza pagine, pulsanti e campi; non salva mai |
| Creare un ordine | `use mode ops` → `ops crea ordine fornitore …, articolo …, quantità …` | Piano dalla memoria (se mancano dati obbligatori te li chiede prima) → `APPROVO PIANO …` → compilazione automatica → `sì` prima dell'invio → procedura memorizzata |
| Sapere perché un documento è fermo | *"Su ACME produzione, perché l'ordine 4500012345 è fermo?"* | Diagnosi in sola lettura, con evidenze |
| Collaudare una release | `nrt release-check R25.3` | Piano dal delta, esecuzione per scope, triage, Defect, Xray, report |
| Cambiare una configurazione | `cfg design "rendi obbligatorio Codice progetto sopra 10.000 €"` → `cfg apply <PLAN>` | Progetto con rischio e rollback, poi applicazione con le approvazioni del livello |
| Caricare documentazione | `kb ingest <cartella> --scope P2P` → `kb digest --scope P2P` → `kb review` | Lettura, redazione, digestione, tua revisione |
| Una domanda sui dati | `ops query "ordini sopra 50k nell'ultimo mese per fornitore"` | Query in Analytics, verificata, salvata per riuso |

Consigli: esplora un modulo alla volta (il budget di un agente è limitato); dai ai file da caricare nomi neutri
(senza nomi di persone); scrivi sempre "fin dove" arrivare (*"lascialo in bozza"*, *"portalo in approvazione"*).

---

## 11. Salvare e aggiornare

**Salvare la conoscenza** — dopo una sessione di lavoro, dalla cartella del repository:

```bash
cd <REPO>
git pull
git add knowledge
git commit -m "conoscenza: esplorazione ordini ACME"
git push
```

Prima di iniziare una sessione fai `git pull`, così lavori sulla conoscenza più recente. Non finiscono in git le
sessioni, le credenziali e i file temporanei del database (esclusi da `.gitignore`).

**Aggiornare il plugin** — `git pull`, poi `npm ci` in `<REPO>/plugin`; in Claude Code aggiorna il marketplace
`jaggaer-vc` dal menu `/plugin` e reinstalla il plugin; infine `/jaggaer-virtual-consultant:vc doctor`. Dopo un
aggiornamento una sessione aperta si ripara con `/jaggaer-virtual-consultant:use customer <ID>`.

---

## 12. Problemi frequenti

| Messaggio o situazione | Cosa fare |
|---|---|
| Ogni azione negata, `doctor` con `deps` rosso | `npm ci` nella cartella che `doctor` indica |
| "Integrità del pacchetto fallita" | Il plugin è stato modificato: reinstallalo (`npm ci`), non operare |
| "nessun piano attivo" | Serve un piano approvato, oppure l'esplorazione aperta con la frase |
| "ambiente non verificato" | Scrivi *"verifica l'ambiente"*; controlla `fingerprint` in `environments.yaml` |
| "host non ammesso" | Aggiungi l'host (anche quello del login SSO) ad `allowed_hosts` |
| Tutto negato a un agente | `vc agents`: può essere in pausa o oltre i limiti (`RIPRENDI AGENTE …`, `LIMITI DISPATCH …`) |
| "il modello di questo scope va rifatto" | Tre compiti fermati per sorprese: segui il giro di osservazioni proposto, poi `SBLOCCA SCOPE <S>` |
| "Approvazione non valida" | La frase non è esatta o è scaduta: il messaggio mostra quella attesa |
| Il plugin rifiuta di creare il workspace | Stai usando una cartella dentro `plugin/`: usa `knowledge/` o una cartella esterna |

Elenco completo: [Manuale di riferimento, §58](docs/MANUAL.md).

---

## 13. Glossario

| Termine | Significato |
|---|---|
| **Scope** | Area funzionale: `CAT` catalogo · `SRC` sourcing · `VEN` fornitori · `CON` contratti · `P2P` richieste, ordini, ricezioni · `INV` fatture · `QLT` qualità · `ANL` analytics · `ADM` amministrazione · `XSC` trasversale |
| **Livelli S · C · L** | Conoscenza del prodotto (standard) · del cliente · appresa sul campo |
| **Workspace** | La cartella della conoscenza aperta in Claude Code (`knowledge/`) |
| **Cella** | Il perimetro di un agente: un cliente, uno scope, una modalità |
| **Piano** (`PLAN.…`) | Sequenza di passi che un agente eseguirà, ognuno con il risultato atteso; si approva prima |
| **Compensazione** | Come annullare ciò che un passo crea (chiudere, annullare, disattivare): registrata prima del passo |
| **SEL · FLD · FLW** | Un elemento della pagina · un campo di un documento · una procedura |
| **CFP · CHK** | Una procedura di configurazione · un controllo |
| **DEC · DT** | Una decisione registrata · una tabella di decisione |
| **Rischio R0–R3** | Da sola lettura (R0) ad azioni irreversibili o di configurazione critica (R3) |
| **Sorpresa** | Quello che l'agente vede non è quello che si aspettava: ripianifica o si ferma |
| **MCP** | Il collegamento che permette agli agenti di usare Chrome (Chrome DevTools MCP) e Jira/Xray |
