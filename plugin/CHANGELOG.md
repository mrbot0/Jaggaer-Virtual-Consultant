# Changelog

Le versioni seguono `x.y.z`. Claude Code tiene i plugin in cache per versione
(`~/.claude/plugins/cache/<marketplace>/<plugin>/<versione>/`): ogni rilascio alza la versione in
`.claude-plugin/plugin.json` e `package.json`, rigenera `integrity.json` (`node scripts/admin/integrity.mjs build`) e
aggiunge qui la sua voce. `doctor` (controllo `plugin-version`) e il contesto di avvio della sessione avvisano quando il
marketplace installato ha una versione più nuova di quella in uso.

## 0.2.0 — 2026-10-29

- **Esplorazione libera in sandbox e pre-produzione**: niente blocchi su host, ambiente non verificato, URL ignoto e
  script; restano negate solo le cancellazioni.
- **Cattura integrale e mappa del sito**: letture a pezzi che si sommano, snapshot su file per le pagine pesanti, Atlas
  senza tetto per pagina.
- **File di ambiente scrivibili dagli agenti** con ricarica automatica.
- **Nuovi agenti** `workspace-manager` e `health-keeper`.
- **SQLite senza binario nativo**: dopo il ripiego del 28/10 su `node:sqlite`, il plugin usa solo `node:sqlite`
  (incluso in Node; senza flag da 22.13) e non dipende più da `better-sqlite3`.
- **Correzioni Windows**: percorsi assoluti nella forma corta 8.3 dentro il workspace riconosciuti come interni.
- **Versioni**: versione portata a 0.2.0 (era ferma a 0.1.0), controllo `doctor` `plugin-version` e versione in uso nel
  contesto di SessionStart.

## 0.1.0

- Prima versione pre-rilascio.
