---
name: decision-tables
description: Metodo per leggere un file di tabella in decision-tables/ (DT-<nnn>.yaml) e chiamare dt-eval correttamente — input nome=valore nei domini chiusi, priori dal registro (--priors auto), null_policy, overrides e bande, --write-dec per registrare la DEC prima di leggere l'esito. Usala al passo DECIDERE ogni volta che una scelta ha una tabella — chiedere o procedere (DT-002), classificare un fallimento (DT-001), rischio di configurazione (DT-007), localizzazione (DT-008), cluster (DT-005), lezione (DT-004), contraddizione (DT-011), promozione (DT-010), tipo/livello/completezza di un item digerito (DT-020/021/022), incertezza (DT-024) — e quando un input ti manca o è fuori dominio.
---

# decision-tables — applicare una tabella, non "valutare" (§15)

Un agente non valuta a sensazione: applica una tabella. Input con domini chiusi, pesi, soglie ed esiti sono nel
file; lo script calcola, registra la decisione (`DEC`) e ti restituisce l'esito. Le tabelle cambiano solo con una
nuova `version`, una motivazione e un umano — mai in sessione (§15.1, §12.5).

## Leggere un file DT (prima di chiamarlo)

| Chiave | Cosa ti dice | Cosa ne fai |
|--------|-------------|-------------|
| `inputs[]` | `name`, `weight`, `domain` (`enum` di valori con il loro punteggio, o `boolean`) | i **nomi** e i **valori ammessi** degli argomenti: esattamente quelli, niente sinonimi |
| `priors[]` | tassi dal registro degli esiti, con `weight` e `neutral` | non li passi a mano: `--priors auto` |
| `scoring` | di norma `weighted_sum` | punteggio = Σ peso × punteggio + Σ peso × prior |
| `thresholds[]` | bande `[from, to)` → esito (l'ultima include 1) | capisci quanto sei vicino al confine |
| `overrides[]` | condizioni che decidono prima delle bande (es. R3 → fermati) | non aggirarle cambiando un input |
| `outcome_selectors[]` | correzioni dell'esito dentro una banda | come sopra |
| `null_policy` | cosa succede se un input manca: `error` · `default:<valore>` · `worst` (il punteggio peggiore) | un input che non conosci **non lo inventi**: lo ometti e lasci la politica |
| `log_as: DEC` | la valutazione diventa una decisione registrata | con `--write-dec` |
| `calibration` | `spec` · `bootstrap` · `mixed` | una tabella bootstrap è da ricalibrare sugli esiti: la confidenza dichiarata ne tiene conto |

`decision-tables/README.md` ha il catalogo (codice, decisione, priori, esiti). Il file è l'unica fonte: non
riportare nel rapporto pesi o soglie, cita il codice e la versione (`table_version`).

## Chiamare dt-eval

Gli agenti passano gli input come `nome=valore` (mai JSON in linea negli argomenti; `--inputs <file>` solo se hai
un file da scrivere nella tua cartella di lavoro):

    node "${CLAUDE_PLUGIN_ROOT}/scripts/decide/dt-eval.mjs" --table DT-002 risk=<R> shape=<forma> mandatory_missing=<true-false> open_contradiction=<true-false> novelty=<true-false> --priors auto --customer <C> --scope <S> --db customers/<C>/knowledge.db --session <SES> --agent scope-expert --subject <codice> --strategy <STR> --write-dec --json

| Opzione | Regola |
|---------|--------|
| `--table DT-0nn` | la tabella del caso, scelta dalla strategia o dal ruolo |
| `nome=valore` | un argomento per input; `true`/`false`/`null`/numeri sono tipizzati |
| `--priors auto` | tassi dal registro; sotto la soglia minima di DEC verificate vale `neutral` e non sposta nulla |
| `--customer --scope --db` | la tua cella; `--root` solo se il DB non è `customers/<C>/knowledge.db` |
| `--session --agent --subject --cluster --strategy` | il contesto della DEC: servono ai precedenti di domani |
| `--effects` / `--no-effects` | dichiara se la decisione ha effetti (il self-check lo usa per esigere l'esito atteso) |
| `--confidence 0.85` | la tua confidenza dichiarata: entra nella calibrazione (§17.4) |
| `--write-dec` | scrive la DEC **prima** di stampare l'esito (§29.6) |

Uscita: `{ outcome, score, components[], prior_used, table_version, dec_code }`. `dec_code` va in
`cognitive_trace.decisions`; `components` ti dice quali input hanno pesato di più (ti serve per il blocco `why`).

## Exit code e cosa significano

- `0` — esito prodotto. Anche `chiedi` o `fermati` sono esiti validi: si seguono, non si ripete la valutazione con
  input "più favorevoli".
- `1` — input fuori dominio, nome sbagliato, input obbligatorio mancante (`null_policy: error`), tabella sconosciuta.
  Non approssimare: correggi il nome o il valore leggendo il file, o restituisci `needs-input` se il dato non c'è.
- `2` — errore di sistema: riportalo.

## Dall'esito al comportamento

| Tabella | Esito | Cosa fai |
|---------|-------|----------|
| DT-002 | `procedi` · `procedi-con-assunzione` · `chiedi` · `fermati` | l'assunzione va dichiarata in `why.assumed`; `chiedi` → `needs-input` (skill `asking-the-user`); `fermati` → `escalate` o `needs-input` |
| DT-001 | categoria del fallimento | sotto la confidenza richiesta → `escalate` (skill `failure-forensics`) |
| DT-007 | rischio R0–R3 e perimetro verde/giallo/rosso | decide le approvazioni (skill `jaggaer-configuration`) |
| DT-018 | `replay` · `orienta` · `ignora` | skill `precedents` |
| DT-016, DT-024 | sorpresa compatibile/incompatibile; incertezza | di norma li applica step-check; skill `belief-revision` |

## Il blocco `why` (§17.5)

Ogni rapporto con effetti porta `why`: la decisione, i tre input che hanno pesato di più (da `components`), le
assunzioni dichiarate, **l'osservazione che ti farebbe cambiare idea** (`would_change_my_mind`) e l'alternativa
scartata con lo scarto di punteggio. `would_change_my_mind` è ciò che distingue una spiegazione da una
giustificazione: se si verifica, step-check la marca come sorpresa prioritaria.

    node "${CLAUDE_PLUGIN_ROOT}/scripts/decide/why.mjs" <DEC> --db customers/<C>/knowledge.db --json

## Errori tipici

- Inventare un valore per un input che non conosci invece di lasciare la `null_policy`.
- Rivalutare con input ritoccati finché l'esito piace: è la stessa decisione, registrata due volte.
- Decidere senza `--write-dec` una scelta con effetti (controllo 4 del self-check).
- Citare nel rapporto soglie o pesi a memoria: cita codice e versione della tabella.
