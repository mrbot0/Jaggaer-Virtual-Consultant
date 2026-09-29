// Tokenizzatore UNICO delle eccezioni "a forma esatta" dei guard (WP08 giro 1, C1, decisione del controllore):
// purge ammessa (guard-destructive), chiamata di riparazione del gate d'integrità (doctor / integrity verify), script del
// plugin (guard-config-scope) e comando di sessione del plugin (common.mjs). Un'eccezione vale solo per UNA invocazione
// semplice: nessuno di ( ) , @ { } $ ` ; & | < > né a capo o NUL in tutto il comando (PowerShell valuta `( … )`, `@( … )`,
// `$( … )` e gli elenchi con la virgola PRIMA di avviare il programma; bash espande `$`, backtick e graffe), e ogni
// token è una parola semplice o una stringa fra virgolette con lo stesso alfabeto (più lo spazio). Nessun jolly (* ? [).
// Unico segnaposto ammesso: "${CLAUDE_SESSION_ID}" (sostituito da SID prima del controllo), come nei comandi del plugin.
// Solo moduli built-in: è sul percorso caldo.
import { resolve } from "node:path";

export const FORBIDDEN = /[()@{}$`;&|<>,\r\n\0]/;
const BARE = /^[\w%+=:./\\-]+$/;
const QUOTED = /^[\w%+=:./\\ -]*$/;
const TOKEN = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?=\s|$)/y;

// → argv (array di stringhe) | null se il comando non è un'invocazione semplice.
export function simpleArgv(command) {
  if (typeof command !== "string") return null;
  const s = command.trim().replace(/"\$\{CLAUDE_SESSION_ID\}"/g, "SID");
  if (!s || FORBIDDEN.test(s)) return null;
  const out = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < s.length) {
    const start = TOKEN.lastIndex;
    const m = TOKEN.exec(s);
    if (!m || TOKEN.lastIndex === start) return null;
    if (m[3] !== undefined) { if (!BARE.test(m[3])) return null; out.push(m[3]); } else {
      const body = m[1] ?? m[2];
      if (!QUOTED.test(body)) return null;
      out.push(body);
    }
    if (/^\s*$/.test(s.slice(TOKEN.lastIndex))) break;
  }
  return out.length ? out : null;
}

// `node <script> …` semplice → { script: percorso assoluto, args } | null
export function simpleNodeCall(command, cwd) {
  const argv = simpleArgv(command);
  if (!argv || !/^node(\.exe)?$/i.test(argv[0]) || !argv[1]) return null;
  return { script: resolve(cwd, argv[1]), scriptToken: argv[1], args: argv.slice(2) };
}

// WP09d giro 1: posizionali e valori delle opzioni secondo la stessa grammatica di argsRefusal (flags: null = booleana).
export function splitArgs(args, flags = {}) {
  const pos = [];
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const eq = a.indexOf("=");
    const name = eq >= 0 ? a.slice(0, eq) : a;
    if (flags[name] === null) { values[name] = true; continue; }
    values[name] = eq >= 0 ? a.slice(eq + 1) : args[++i];
  }
  return { positional: pos, values };
}

// Argomenti per forma: `positional` = regex per posizione; `flags` = { "--flag": null (booleano) | regex del valore }.
// → null se tutti validi, altrimenti il motivo.
export function argsRefusal(args, { positional = [], flags = {} }) {
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
      if (!Object.hasOwn(flags, name)) return `opzione non ammessa: ${name}`;
      const shape = flags[name];
      if (shape == null) { if (inline !== undefined) return `l'opzione ${name} non prende valore`; continue; }
      const v = inline ?? args[++i];
      if (typeof v !== "string" || !new RegExp(shape).test(v)) return `valore non ammesso per ${name}`;
    } else pos.push(a);
  }
  if (pos.length !== positional.length) return `argomenti posizionali attesi: ${positional.length}, ricevuti: ${pos.length}`;
  for (let i = 0; i < pos.length; i++) if (!new RegExp(positional[i]).test(pos[i])) return `argomento ${i + 1} non ammesso`;
  return null;
}

// WP10a giro 1 (I1): parole di un comando di shell come le vede il programma, per le regole `first_arg` di
// guard-destructive. Stessa grammatica del tokenizzatore sopra (parole semplici e stringhe fra virgolette, separate da
// spazi), senza rifiutare nulla: ogni parola in due letture, perché il guard non sa quale shell eseguirà il comando —
//   raw   virgolette tolte, backslash lasciati (cmd e PowerShell: C:\percorso\kb.mjs)
//   shell la lettura POSIX: \x fuori dalle virgolette ⇒ x, '…' letterale, "…" con \ $ ` " e a capo scappati; \+a capo
//         unisce le righe
// e `bare`: la parola senza \ " ' ^ ` (escape di bash, cmd e PowerShell), per confrontare i sotto-comandi.
// Separatori di comando (; & | a capo non scappato, ( ) fuori dalle virgolette) chiudono il sotto-comando.
export function shellCommands(text) {
  const cmds = [];
  let words = [];
  let raw = null;
  let sh = null;
  let q = null;
  const flush = () => { if (raw !== null) words.push({ raw, shell: sh, bare: raw.replace(/[\\"'^`]/g, "") }); raw = null; sh = null; };
  const end = () => { flush(); if (words.length) cmds.push(words); words = []; };
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = null; else { raw += c; sh += c; } continue; }
    if (q === '"') {
      if (c === '"') { q = null; continue; }
      if (c === "\\" && i + 1 < s.length && '\$`"\n'.includes(s[i + 1])) { raw += c + s[i + 1]; if (s[i + 1] !== "\n") sh += s[i + 1]; i++; continue; }
      raw += c; sh += c; continue;
    }
    if (c === "\\" && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === "\n" || (n === "\r" && s[i + 2] === "\n")) { i += n === "\r" ? 2 : 1; continue; }
      raw ??= ""; sh ??= "";
      raw += c + n; sh += n; i++; continue;
    }
    if (c === "'" || c === '"') { raw ??= ""; sh ??= ""; q = c; continue; }
    if (/\s/.test(c)) { if (c === "\n") end(); else flush(); continue; }
    if (";&|()".includes(c)) { end(); continue; }
    raw ??= ""; sh ??= "";
    raw += c; sh += c;
  }
  end();
  return cmds;
}
