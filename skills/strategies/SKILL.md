---
name: strategies
description: Metodo per scegliere ed eseguire una strategia di ragionamento codificata (i dodici STR-* in strategies/) con strategy-select e DT-017, comprese le combinazioni (STR-PREMORTEM, STR-DISCONFIRM, STR-MIN-CHANGE, STR-DRY-RUN poi la strategia di forma). Usala al passo DECIDERE di ogni compito, prima della tabella del caso, quando la forma epistemica, il rischio del passo, il precedente più vicino e le sorprese devono tradursi in un ordine di lavoro — replica, verifica prima, prova a vuoto, esplora a budget, chiedi presto, triangola, bisezione in diagnosi, fermati e registra.
---

# strategies — il repertorio e la selezione (§14)

Una strategia è un **piano di ragionamento codificato**: dice in che ordine fare le cose e quali tabelle applicare.
Non la inventi: la selezioni con uno script e la esegui. I piani stanno in `strategies/STR-*.yaml` (id, codice,
`applies_when`, `plan` a passi, `cost`, `success_criteria`): li legge lo script con `--plan`, tu non li copi.

## Selezionare

    node "${CLAUDE_PLUGIN_ROOT}/scripts/decide/strategy-select.mjs" --shape <forma> --risk <R> --precedent <classe> --surprises <n> --mode <modalità> --depth <profondità> --plan --json

Input (tutti dal passo VALUTARE, mai stimati):

| Opzione | Da dove viene | Valori |
|---------|---------------|--------|
| `--shape` | `kb epistemic` | consolidato · empirico · libresco · ignoto · contraddittorio |
| `--risk` | rischio del **passo** critico (F10, classe d'azione) | R0 · R1 · R2 · R3 |
| `--precedent` | il più vicino di `kb precedents` (skill `precedents`) | `confermato-d<0.2` · `confermato-d<0.5` · `nessuno` · `smentito-d<0.3` |
| `--surprises` | sorprese già in sessione | 0, 1, 2 |
| `--mode` | header | nrt · config · ops · diag |
| `--depth` | header | rapida · standard · profonda |
| `--divergence-unknown` | diagnosi con prima divergenza ignota | flag |
| `--has-hypotheses` / `--preferred-prior` | registro delle ipotesi | flag / 0–1 |

L'uscita è `{ strategy, then?, combine, score, rule }`: `strategy` va in `cognitive_trace.strategy` e nella DEC
(`--strategy` di dt-eval), `combine` elenca le strategie da applicare insieme, `then` la strategia che segue.

## Come DT-017 sceglie (§14.3)

Punteggio = forma × 0.35 + rischio × 0.30 + precedente × 0.20 + sorprese × 0.15, poi le bande:

```
< 0.15                         STR-REPLAY
0.15–0.35                      nessuna strategia speciale: DT ordinaria
0.35–0.55  libresco            STR-VERIFY-FIRST
0.35–0.55  empirico            STR-GENERALIZE-CAUTIOUSLY
0.35–0.55  contraddittorio     STR-TRIANGULATE
0.55–0.75  R ≥ R2              STR-DRY-RUN, poi la strategia di forma
0.55–0.75  ignoto, R0          STR-EXPLORE-BUDGET
0.55–0.75  ignoto, R ≥ R1      STR-ASK-EARLY
> 0.75                         STR-STOP-RECORD
diagnosi, divergenza ignota    STR-BISECT (indipendente dal punteggio)
```

## Il repertorio: quando e cosa fai (§14.2)

| Strategia | Quando | Il piano in una riga | Tier tipico |
|-----------|--------|----------------------|-------------|
| `STR-REPLAY` | consolidato, precedente confermato d < 0.2 qui | riusa le scelte del precedente, CHK pre, agisci, verifica leggera | T0 |
| `STR-VERIFY-FIRST` | libresco, R ≥ R1 | osservazioni R0 mirate ai `gaps` (≤ 8 passi), ricalcola la forma; consolidato → procedi, contraddittorio → triangola, ancora libresco → chiedi presto | T0/T1 |
| `STR-TRIANGULATE` | fonti di genere diverso in disaccordo, contraddittorio | recupera un terzo genere (di norma un'osservazione), DT-011; se resta aperta, chiedi | T1 |
| `STR-DRY-RUN` | R ≥ R2, forma non consolidata | esegui con tutti i SAVE/SUBMIT sostituiti da CAPTURE, confronta ogni schermata, solo dopo per davvero | T1 |
| `STR-MIN-CHANGE` | configurazione con ipotesi da verificare (in combinazione) | il passo più piccolo che distingue le ipotesi, verifica, poi il resto | T1 |
| `STR-BISECT` | diagnosi, procedura lunga fallita, prima divergenza ignota | dimezza la sequenza, verifica a metà, ripeti fino al primo passo divergente | T1 |
| `STR-EXPLORE-BUDGET` | ignoto, R0 | naviga con budget di passi e token fissato prima; OBS e candidati, **niente verdetti** | T0 |
| `STR-ASK-EARLY` | ignoto o libresco con R ≥ R2, gaps critici | formula le domande dai gaps **prima** di agire, a lotti se indipendenti | T0 |
| `STR-GENERALIZE-CAUTIOUSLY` | empirico, precedenti solo altrove | agisci qui a R ≤ R1, cerca la fonte tecnica, chiedi "è voluto?", portabilità `ignota` | T1 |
| `STR-STOP-RECORD` | sorpresa incompatibile su R ≥ R2, terza sorpresa, R3 senza approvazione | non eseguire; CTR; `escalate` o `needs-input` con il piano di osservazioni per riprendere | T0 |
| `STR-PREMORTEM` | sempre in combinazione per R ≥ R2 in deliberazione profonda | "se fra un'ora risulta un errore, perché?" → per ogni causa un CHK pre o una verifica post; rollback provato a vuoto | T2 |
| `STR-DISCONFIRM` | in combinazione con un'ipotesi preferita a prior > 0.6 | un test progettato per smentirla; se non eseguibile, confidenza −0.15 | T1 |

## Combinazioni

- `STR-DRY-RUN` non chiude: dopo la prova a vuoto segue la strategia di forma (`then`: verifica prima, generalizza
  con cautela, triangola o chiedi presto).
- `STR-PREMORTEM`, `STR-DISCONFIRM` e `STR-MIN-CHANGE` si aggiungono a quella scelta (`combine`), non la sostituiscono.
- In configurazione la prima esecuzione di una procedura non consolidata è di norma `STR-DRY-RUN` (§28.2).
- In diagnosi `STR-BISECT` sceglie il passo successivo con lo stesso criterio del registro delle ipotesi: il test
  discriminante più economico (skill `belief-revision`, `failure-forensics`).

## Eseguire la strategia

1. Leggi il `plan` restituito con `--plan`: è l'ordine dei passi, non un suggerimento.
2. Rispetta i budget dichiarati dalla strategia (passi, minuti) dentro quello del compito.
3. Registra la strategia nella DEC della tabella del caso e nella lezione: il registro degli esiti misura il tasso
   di successo per strategia e per cluster, e la calibrazione ne sposta le soglie (§14.3).
4. Se lungo il compito la forma cambia (conferme, sorprese), la strategia si riseleziona per il passo successivo.

## Errori tipici

- Scegliere `STR-REPLAY` con un precedente lontano (d ≥ 0.2) o di un altro cliente.
- Dare verdetti in `STR-EXPLORE-BUDGET`: l'esplorazione produce osservazioni e candidati, non esiti.
- Usare `STR-DRY-RUN` e poi eseguire per davvero senza aver confrontato ogni schermata con l'atteso.
- Omettere `STR-PREMORTEM` su R ≥ R2 in profondità profonda: è il rilevatore dell'ottimismo di piano (§17.3).
