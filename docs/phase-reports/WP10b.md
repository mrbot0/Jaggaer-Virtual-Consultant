# WP10b — Report di fase: le 15 definizioni foglia degli agenti e la suite di eval

## PARTE 1 — Definizioni degli agenti, test di struttura e contratto, lettura trasversale

Stato: **pronta** (parte 1 di 2). La suite `evals/` (300 casi, §49.1) è la parte 2, in un dispatch separato; il tag
`agents-done` si mette dopo la parte 2. Dettaglio di consegna, TDD e rischi: `.superpowers/sdd/wp10b-report.md`.

Suite completa alla consegna: **1017/1017** (`npm test`, erano 993) · test dei tempi dei guard verde (p95 ≤ 142 ms,
massimo 156 ms per chiamata, soglia 300 ms).

### Cosa c'è

| Deliverable | File | Prova |
|-------------|------|-------|
| 15 definizioni foglia (§44.2), nessun `agents/agent-manager.md` | `agents/*.md` | `test/docs/agents-structure.test.mjs`: 15/15 file, frontmatter (name, description, model, tools) per la tabella del brief, mai `Agent` · `AskUserQuestion` · `WebFetch` |
| Strumenti MCP | browser (Chrome DevTools del plugin e utente, Claude browser / Claude in Chrome) solo per `scope-expert` e `analytics-learner`, riconosciuti da `hooks/lib/browser-tools.mjs`, mai Playwright; `mcp__plugin_jaggaer-virtual-consultant_alm__*` solo per `defect-reporter` | stesso test (famiglie da `classify`) |
| Corpo di ogni agente | Cella («L'hook nega: non provare.»), Il ciclo (sei passi con gli script; riga `Tier (§26.3): … · ciclo cognitivo: …` per la matrice di §26.3), Precedenza fra fonti (ruoli che leggono kb), Cosa non fai mai, Rapporto finale in un blocco ```yaml | stesso test (sezioni, tier e forma esatti, parole chiave dei divieti, skill citate = le 26 di WP10c, script esistenti, nel perimetro, rispondono a `--help`) |
| Contratto in uscita (§46.2) | rapporto d'esempio che chiude ogni corpo | `test/docs/agents-report-contract.test.mjs`: estratto come fa `subagent-trace`, valida con `agent-report` + `cognitive-trace` (validatori di K2), esito effettivo `ok`, strategia e DT esistenti, `usage.model` = frontmatter, bozza della lezione per i ruoli senza Write |
| Righe di comando eseguibili sotto i guard | tutte le righe `node "${CLAUDE_PLUGIN_ROOT}/scripts/…"` dei corpi | `test/docs/agents-guards.test.mjs`: rese con valori d'esempio e valutate in processo da guard-scope, guard-customer, guard-budget, guard-destructive, guard-config-scope, guard-phrase come quel sub-agente (scope CAT, XSC per profilo e mappe, ANL per analytics): nessun deny |
| Lettura trasversale di `process-mapper` e `weekly-digest` (ruling 2) | `scripts/admin/session.mjs use paths --agent <tipo> --grant\|--restore`, `session.cross_read` (schema + validatore precompilato), `crossReadPaths` in `hooks/lib/guards/scope.mjs`, onorato da guard-scope e guard-customer | `test/hooks/wp10b-cross-read.test.mjs` (7 test) |
| Input `nome=valore` per `dt-eval` (ruoli senza Write) | `scripts/decide/dt-eval.mjs` | `test/decide/dt-eval.test.mjs` (nuovo test CLI) |
| Cartella del cliente da `--db` | `scripts/lib/root-from-db.mjs`; `dt-eval --write-dec`, `learn validate`, `kb cluster admit/quarantine` | `test/decide/wp10b-root-default.test.mjs` |
| Carry d'integrità (ruling 7) | `agents/` e `skills/` in `SCOPE_DIRS`; `integrity.json` rigenerato | `test/admin/integrity.test.mjs` (agente alterato ⇒ verify ok:false) |

### Matrice §26.3 come scritta nei corpi

| Agente | Modello | Strumenti | Tier · ciclo |
|--------|---------|-----------|--------------|
| scope-expert | sonnet | Read, Write, Glob, Grep, Bash + browser | per compito (haiku T0 · sonnet T1 · opus T2) · completo |
| scope-extractor | haiku | Read, Write, Glob, Grep, Bash | T0/T1 · ridotto (1-2-6) |
| scope-digester | opus | Read, Write, Glob, Grep, Bash | T2 · completo + passata epistemica |
| customer-profiler | opus | Read, Write, Glob, Grep, Bash | T2 · completo |
| process-mapper | opus | Read, Write, Glob, Grep, Bash | T2 · completo, lettura trasversale |
| cluster-validator | opus | Read, Write, Glob, Grep, Bash | T2 · 2-4-6 |
| weekly-digest | opus | Read, Write, Glob, Grep, Bash | T2 · completo |
| root-cause-analyst | opus | Read, Write, Glob, Grep, Bash | T2 · completo, STR-BISECT |
| config-designer | opus | Read, Write, Glob, Grep, Bash | T2 · completo, gaps → domande |
| lesson-validator | sonnet | Read, Write, Glob, Grep, Bash | T1 · 2-4-6 |
| analytics-learner | sonnet | Read, Write, Glob, Grep, Bash + browser | T1/T2 · completo |
| test-mechanic | sonnet | Read, Write, Glob, Grep, Bash | T1 · completo |
| failure-triage | haiku | Read, Bash | T0→T1 · completo, con precedenti |
| config-auditor | haiku | Read, Bash | T0 · ridotto |
| defect-reporter | haiku | Read, Bash + ALM | T0 · ridotto, con precedenti |

### Decisioni che contano

- **Lettura trasversale** (ruling 2): il permesso è un campo separato `session.cross_read[<tipo>]`, non un
  `allowed_paths` allargato: `allowed_paths` resta la cella di tutti gli altri agenti in parallelo; il permesso vale
  solo per quel tipo di agente, solo per Read/Glob/Grep, scade dopo 8 ore (il massimo di `LIMITI DISPATCH`), mai
  `analysis/` (anche nello schema), per `process-mapper` mai altri clienti anche se il file dicesse altro.
  L'eccezione storica di `weekly-digest` (guard-customer) resta.
- **Perimetro della shell**: il frontmatter non restringe Bash (plugin-format-facts); il perimetro della tabella è nel
  corpo e lo verifica il test (extractor: `scripts/ingest/` + l'auto-verifica; digester: `scripts/kb/` + gli script
  del ciclo in `scripts/decide/`).
- **Ruoli con i soli Read e Bash**: input agli script come `nome=valore`, DEC scritte dagli script, bozza della
  lezione nel rapporto (`output.lesson_draft`) che il manager scrive; l'auto-verifica formale la ripassa il manager.
- **`--root` dal `--db`**: guard-scope nega a un sub-agente di citare una cartella antenata della cella; gli script
  che scrivono la DEC o validano le lezioni la ricavano dal DB.

### Rischi residui (dettaglio nel report SDD)

- `${CLAUDE_PLUGIN_ROOT}` nei corpi degli agenti: si presume sostituito come nei comandi e nelle skill (non verificato
  su un'installazione reale); altrimenti la variabile d'ambiente deve esistere nella shell dei sub-agenti.
- `self-check --depth rapida` restituisce `passed` sui soli controlli eseguiti (3), e `validateReport` tratta
  `passed < 10` come `partial`: un compito a profondità rapida torna sempre `partial`. Segnalato, non corretto qui.
- La verifica di un selettore riparato e la micro-esplorazione della diagnosi richiedono un dispatch dello
  scope-expert (test-mechanic e root-cause-analyst non hanno il browser).
