# WP10c — Report di fase: la skill agent-manager e le 26 skill di metodo

Stato: **pronto**. Deliverable A (`skills/agent-manager/`) e B (le 26 skill dell'elenco di §44.3) del brief
`wp10c-skills.md`, con le rulings del controllore (description stretta del manager + guardia per i sub-agenti; il
manager usa il layer di orchestrazione di WP10d, `docs/orchestration.md`). Suite completa alla consegna: **1076 test,
1076 verdi** (1050 precedenti + 26 nuovi). Dettagli, deviazioni e rischi: `.superpowers/sdd/wp10c-report.md`.

## Evidenza

| Controllo | Esito | Test |
|-----------|-------|------|
| 27/27 cartelle: agent-manager + esattamente le 26 di §44.3 (uguaglianza di insiemi; la prosa "22" non si riproduce) | verde | `test/docs/skills-structure.test.mjs` |
| ogni SKILL.md ≤ 400 righe (massimo 218, agent-manager); overflow in `references/` collegati | verde | idem |
| frontmatter `name` + `description` con le condizioni d'uso; niente `allowed-tools`, niente `context: fork` | verde | idem |
| ogni §n citato esiste nell'indice o nei titoli della spec (elenco in `test/fixtures/spec/sections.txt`, allineato alla spec quando è presente) | verde | idem |
| skill, script, schemi, template, DT e STR citati esistono; righe di comando semplici (tokenizzatore dei guard), niente JSON in linea, script che rispondono a `--help` | verde | idem |
| ogni skill citata dai 15 agenti esiste; ogni skill di metodo è usata da almeno un agente (salvo `jaggaer-domain`, attivata dalla description); nessun agente usa agent-manager | verde | `test/docs/skills-agent-coverage.test.mjs` |
| confine: regole di contenuto di `scripts/kb/validate-boundary.mjs`, nessuna cartella o codice di cliente concreto, nessun frammento del corpus JAGGAER DOC (in locale), nessuna frase dell'utente nelle 26 skill di metodo | verde | `test/docs/skills-boundary.test.mjs` |
| agent-manager codifica i contratti 1–9, le nove responsabilità di §23.2 e le sequenze §45.2–45.6 | verde | `test/docs/skills-agent-manager.test.mjs` |
| integrità del pacchetto ricostruita con `skills/` (414 file) | fatto | `integrity.json` |

## Le skill

| Gruppo | Skill (righe di SKILL.md) |
|--------|---------------------------|
| manager | `agent-manager` 218 (+ `references/sequences.md` 103) |
| cognizione (1–8) | `reasoning-cycle` 103 · `epistemic-awareness` 96 · `precedents` 78 · `belief-revision` 98 · `strategies` 88 · `decision-tables` 82 · `asking-the-user` 86 · `self-check-and-lesson` 96 |
| struttura della conoscenza (9–13) | `field-modeling` 99 · `coding-system` 88 · `faceting-and-weights` 102 · `clustering-rules` 83 · `token-economy` 87 |
| dominio e collaudo (14–19) | `jaggaer-domain` 105 · `identity-and-keys` 79 · `integration-testing` 73 · `nrt-authoring` 94 · `selector-strategy` 77 · `evidence-and-xray` 88 |
| sicurezza e confini (20–26) | `data-safety` 84 · `doc-ingestion` 133 (+ `references/deontic-signals.md` 59) · `failure-forensics` 111 · `jaggaer-configuration` 109 · `domain-boundary` 74 · `scope-discipline` 78 · `customer-isolation` 63 |

## Decisioni che contano

- **Le frasi dell'utente solo nel manager.** Le 26 skill di metodo nominano le approvazioni per tipo (A1, A2, A3,
  promote…) e il campo `approval_request`, mai la frase: un sub-agente che copiasse il testo in un input verrebbe
  negato da guard-phrase. Il test usa le stesse espressioni del guard.
- **Blackboard in sola lettura per il manager.** §45.3 dice "salva blackboard"; WP10d lo ha reso un file del monitor
  scritto da subagent-trace: la skill istruisce a comporre dai rapporti e dal blackboard senza modificarlo.
- **Lock della digestione settimanale allo script.** §45.6 lo mette in mano al manager; il codice (WP09d,
  `commands/learn.md`) lo fa prendere allo script della pipeline: la sequenza di riferimento segue il codice e lo dice.
- **Confine applicato a tutte le 27 skill**, anche a `jaggaer-domain` (il brief lo esentava): nessuna skill ne ha
  avuto bisogno.
- **Manuale**: nuova sezione 57.6 con l'elenco delle skill e come il manager le usa.
