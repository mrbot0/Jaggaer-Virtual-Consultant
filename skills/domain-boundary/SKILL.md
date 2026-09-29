---
name: domain-boundary
description: Metodo per rispettare il confine fra dominio operativo (kb/, test) e dominio analitico (analysis/ con PAT, PBK, BRF, RUL, ticket) — perché kb/ non cita mai PAT PBK BRF RUL né analysis/, perché analysis/ non cita mai un test NRT, quando il dominio analitico si può leggere (solo in diagnosi, come contesto) e come riconoscere una violazione prima di scrivere. Usala prima di scrivere un item, un caso di test, un check, una lezione, un Defect o un rapporto che nasce da un ticket, da un pattern di guasto, da un briefing o da una regola di configurazione RUL; quando guard-domain-boundary nega una scrittura; quando lavori in modalità diagnosi.
---

# domain-boundary — due domini che non si mescolano (§1.1, §5.4)

Il sistema tiene separati **sapere come funziona** (dominio operativo) e **sapere cosa è andato storto** (dominio
analitico). Mescolarli produce due danni: test e configurazioni che inseguono i guasti di ieri invece delle regole del
prodotto, e un'analisi dei guasti che si auto-conferma citando i test che ha ispirato.

## I due domini

| | Operativo | Analitico |
|---|---|---|
| dove | `kb/` (prodotto e cliente), `tests/`, `runs/` | `analysis/` del cliente |
| fonti | documentazione, specifiche, osservazione, esecuzioni, utente | ticket di esercizio, guasti osservati |
| produce | FLW KEY LCY INT CFG CFP SEL HND PMP PRF TBL QRY CHK STR e i test | PAT (pattern), PBK (playbook), BRF (briefing), RUL (regole di configurazione) |
| **regola** | **non cita mai `analysis/` né un codice PAT, PBK, BRF, RUL, né un ticket** | **non cita mai un test NRT** |

La regola è anche numerica: nei pesi dei generi di fonte per tipo di decisione la colonna "analitico" vale zero
ovunque tranne che per classificare un fallimento (§6.4).

## Perché così

- Un test deve verificare una **regola** (un invariante, una chiave, un obbligo): se nasce da un ticket verifica un
  sintomo, e smette di servire quando il sintomo cambia forma.
- Un check nato da un guasto cita l'**invariante** violato, non il guasto: così resta valido e porta la conoscenza nel
  dominio giusto (§30.3).
- L'analisi dei guasti deve restare indipendente dai test per poterli giudicare: se cita i test, diventa circolare.
- I ticket contengono dati di persone e testo libero: nel dominio operativo non entrano nemmeno come riferimento
  (skill `data-safety`).

## Quando il dominio analitico si può leggere

- **In diagnosi** (`mode: diag`), l'esperto dello scope legge il **briefing** del suo scope, e la root cause i
  playbook, **come contesto**: orientano le ipotesi, non sono prove e non finiscono nel finding come evidenza.
- Chi importa ticket e costruisce pattern e briefing lo fa con script dedicati del dominio analitico, senza
  sub-agenti.
- Chi audita la configurazione esegue gli script di lint delle regole RUL: legge gli esiti, ma i codici RUL non
  entrano mai in `kb/` né nei test — nel rapporto le derive si descrivono con i codici CFG del dominio operativo.

Fuori da questi casi `analysis/` non è nella tua cella: l'hook nega la lettura.

## Riconoscere una violazione prima di scrivere

Prima di scrivere in `kb/`, in `_inbox/`, in `tests/`, in una lezione o in un Defect, rileggi il testo cercando:

1. un percorso che contiene `analysis/`;
2. un codice di item il cui **tipo** è PAT, PBK, BRF o RUL (quarta parte del codice);
3. un identificativo di ticket o di incidente (sigla seguita da un numero);
4. formulazioni che citano il guasto invece della regola ("come nel ticket…", "per evitare il problema visto…").

E prima di scrivere in `analysis/` (solo gli script lo fanno): nessun codice di test NRT.

Se trovi uno di questi elementi, **riformula dalla regola**: quale invariante, quale obbligo, quale chiave è in gioco?
Cita quel codice del dominio operativo. Se la regola non esiste ancora nel kb, è un gap: una proposta in `_inbox`
dalla fonte operativa (documento, osservazione), non dal ticket.

## Cosa fanno il codice e gli script

- `guard-domain-boundary` applica le stesse regole al **contenuto** di ogni scrittura (non solo al percorso) e nega;
  il deny non si aggira (skill `scope-discipline`).
- `scripts/kb/validate-boundary.mjs` verifica che `kb/` non citi `analysis/` né identificatori analitici e che
  `analysis/` non citi test: exit 3 = violazione.
- Il lint dei casi rifiuta codici analitici in un caso NRT; la compilazione di un caso rifiuta il dominio analitico.
- La validazione delle lezioni rifiuta una lezione che cita `analysis/` (`rejected: confine`).

## Errori tipici

- "Aggiungo al caso il riferimento al ticket per tracciabilità": no, la tracciabilità è la `derivation` dall'item.
- Scrivere nel kb un CHK il cui testo racconta l'incidente: il CHK cita l'invariante.
- Copiare nel Defect il playbook del briefing: il Defect cita la fonte del comportamento atteso e le evidenze.
- Descrivere nel rapporto di audit una deriva con il codice della regola RUL invece che con il CFG coinvolto.
