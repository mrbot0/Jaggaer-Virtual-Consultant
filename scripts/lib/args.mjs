// Parsing minimale degli argomenti CLI: `--chiave valore`, flag booleani
// dichiarati, posizionali. Nessuna dipendenza, nessun effetto collaterale.
export function parseArgs(argv, { flags = [] } = {}) {
  const opts = {};
  const positional = [];
  const flagSet = new Set(["help", "json", ...flags]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (flagSet.has(key)) opts[key] = true;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opts[key] = argv[++i];
      else opts[key] = undefined;
    } else positional.push(a);
  }
  return { opts, positional };
}

// Stampa un errore in formato coerente con --json e restituisce l'exit code.
export function fail(asJson, code, msg, extra = {}) {
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg, ...extra }));
  else console.error(`errore: ${msg}`);
  return code;
}
