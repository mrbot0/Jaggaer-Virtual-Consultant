// Scritture fatte da interpreti di script dentro un comando di shell (fix
// round 4): sed (`w`/`W`, flag `w` di s///, -i), perl e ruby (-i, codice -e).
// → [{ tok, cwds, tree: false, soft }]: `soft` = candidato euristico estratto
// da testo non analizzabile con certezza (un percorso che non si risolve si
// ignora); gli altri si risolvono come ogni bersaglio di scrittura.
//
// FAIL-CLOSED: quando lo script non si analizza con certezza (script da file
// -f, comando `e`, sintassi sconosciuta) ogni percorso citato dall'invocazione
// è un bersaglio candidato; il codice -e di perl/ruby lo è sempre, e se il
// codice apre/rinomina/esegue o abilita l'in-place ($^I, $-i) anche i file
// passati come argomenti. `perl script.pl file` (programma in un file) resta
// una lettura: il contenuto del programma è ignoto (rischio residuo).
import { resolve } from "node:path";
import { PathPolicyError } from "../paths.mjs";

const CD = /^(cd|pushd|chdir|set-location|sl|push-location)$/i;
const INTERP = /^(g?sed|perl|ruby)(\.exe)?$/i;
const INTERP_IN_TEXT = /(^|[^\w.\/\\-])(g?sed|perl|ruby)(\.exe)?(?![\w.\/\\-])/i;
const MAX_DEPTH = 4;
const MAX_TARGETS = 512;

// ---- tokenizzazione con le virgolette ----
// Comandi semplici separati da ; | & newline ( ) e backtick non quotati; le
// redirezioni (`>f`, `2>&1`, `<f`) si tolgono (le scritture per redirezione le
// vede già REDIR). Barra rovescia letterale (percorsi Windows), salvo davanti a
// virgolette o spazi. Ogni parola: { v: valore senza virgolette, q: parti quotate }.
function commands(cmd) {
  const out = [];
  let words = [];
  let cur = null;
  let skipNext = false;
  const endWord = () => {
    if (cur) { if (skipNext) skipNext = false; else words.push(cur); }
    cur = null;
  };
  const endCmd = () => { endWord(); skipNext = false; if (words.length) out.push(words); words = []; };
  const n = cmd.length;
  let i = 0;
  while (i < n) {
    const c = cmd[i];
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      const part = j < 0 ? cmd.slice(i + 1) : cmd.slice(i + 1, j);
      cur ??= { v: "", q: [] }; cur.v += part; cur.q.push(part);
      i = j < 0 ? n : j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let part = "";
      while (j < n && cmd[j] !== '"') {
        if ((cmd[j] === "\\" || cmd[j] === "`") && cmd[j + 1] === '"') { part += '"'; j += 2; continue; }
        part += cmd[j]; j++;
      }
      cur ??= { v: "", q: [] }; cur.v += part; cur.q.push(part);
      i = j + 1;
      continue;
    }
    if (c === "\\" && i + 1 < n && /["'\s]/.test(cmd[i + 1])) { cur ??= { v: "", q: [] }; cur.v += cmd[i + 1]; i += 2; continue; }
    if (c === ">" || c === "<" || (c === "&" && cmd[i + 1] === ">")) {
      if (cur && cur.q.length === 0 && /^\d+$/.test(cur.v)) cur = null; else endWord();
      while (i < n && /[<>&|]/.test(cmd[i])) i++;
      if (/[0-9-]/.test(cmd[i] ?? "") && /&$/.test(cmd.slice(0, i))) { while (i < n && /[0-9-]/.test(cmd[i])) i++; continue; }
      while (i < n && /[ \t]/.test(cmd[i])) i++;
      if (i < n && !/[;|&\r\n()`]/.test(cmd[i])) skipNext = true;
      continue;
    }
    if (/[;|&\r\n()`]/.test(c)) { endCmd(); i++; continue; }
    if (/\s/.test(c)) { endWord(); i++; continue; }
    cur ??= { v: "", q: [] }; cur.v += c; i++;
  }
  endCmd();
  return out;
}

// ---- candidati da testo non analizzabile ----
const STATE_NAMES = /(^|[\\/])(session\.json|invocations\.jsonl|compact-summary\.md|current-session)$/i;
function pathCandidates(text) {
  const out = new Set();
  for (const p of String(text).split(/[\s'"`,;(){}<>|&=!\[\]]+/)) {
    if (!p) continue;
    for (const v of new Set([p, p.replace(/^(?:\d+|\$|\/[^/]*\/[IM]*)?[wWrR]/, "")])) {
      if (v && (/[\\/.]/.test(v) || STATE_NAMES.test(v))) out.add(v);
    }
  }
  return [...out];
}

// ---- sed ----
// Analizza uno script sed (sintassi GNU) → { writes: [file], uncertain }.
// Ogni carattere inatteso ⇒ uncertain (il chiamante passa al fail-closed).
export function parseSedScript(s) {
  const writes = [];
  let i = 0;
  const n = s.length;
  const fail = () => { throw new Error("sed"); };
  const blanks = () => { while (i < n && (s[i] === " " || s[i] === "\t")) i++; };
  const toEol = () => { const j = s.indexOf("\n", i); const t = j < 0 ? s.slice(i) : s.slice(i, j); i = j < 0 ? n : j; return t; };
  const regex = (d) => {
    while (i < n) {
      if (s[i] === "\\") { i += 2; continue; }
      if (s[i] === d) { i++; return; }
      if (s[i] === "\n" && d !== "\n") fail();
      i++;
    }
    fail();
  };
  const addr = () => {
    if (s[i] === "$") { i++; return true; }
    if (/\d/.test(s[i] ?? "")) { while (/\d/.test(s[i] ?? "")) i++; if (s[i] === "~") { i++; while (/\d/.test(s[i] ?? "")) i++; } return true; }
    if (s[i] === "/" || s[i] === "\\") {
      let d = "/";
      if (s[i] === "\\") { d = s[i + 1]; if (!d || d === "\n" || d === "\\") fail(); i += 2; } else i++;
      regex(d);
      while (/[IM]/.test(s[i] ?? "")) i++;
      return true;
    }
    return false;
  };
  try {
    while (i < n) {
      while (i < n && /[\s;]/.test(s[i])) i++;
      if (i >= n) break;
      if (addr()) {
        blanks();
        if (s[i] === ",") {
          i++; blanks();
          if (s[i] === "+" || s[i] === "~") { i++; if (!/\d/.test(s[i] ?? "")) fail(); while (/\d/.test(s[i] ?? "")) i++; } else if (!addr()) fail();
        }
      }
      blanks();
      while (s[i] === "!") { i++; blanks(); }
      const c = s[i++];
      if (c === undefined) fail();
      if (c === "{" || c === "}") continue;
      if (c === "#") { toEol(); continue; }
      if (c === ":") { while (i < n && !/[;\n]/.test(s[i])) i++; continue; }
      if (c === "a" || c === "i" || c === "c") {
        for (;;) { const line = toEol(); if (!line.endsWith("\\") || i >= n) break; i++; }
        continue;
      }
      if (c === "b" || c === "t" || c === "T") { while (i < n && !/[;\n}]/.test(s[i])) i++; }
      else if (c === "r" || c === "R") toEol();
      else if (c === "w" || c === "W") { blanks(); const f = toEol().trim(); if (f) writes.push(f); continue; }
      else if (c === "s" || c === "y") {
        const d = s[i++];
        if (!d || d === "\n" || d === "\\") fail();
        regex(d); regex(d);
        if (c === "s") {
          for (;;) {
            const f = s[i];
            if (f !== undefined && /[gpiImM0-9]/.test(f)) { i++; continue; }
            if (f === "e") return { writes, uncertain: true };
            if (f === "w") { i++; blanks(); const t = toEol().trim(); if (t) writes.push(t); break; }
            break;
          }
        }
      } else if (c === "q" || c === "Q" || c === "l" || c === "L") { blanks(); while (/\d/.test(s[i] ?? "")) i++; }
      else if (c === "v") { while (i < n && !/[;\n}]/.test(s[i])) i++; }
      else if (c === "e") return { writes, uncertain: true };
      else if (!"=dDgGhHnNpPxzF".includes(c)) fail();
      blanks();
      if (i < n && !/[;\n}#]/.test(s[i])) fail();
    }
  } catch {
    return { writes, uncertain: true };
  }
  return { writes, uncertain: false };
}

const SED_LONG_OK = /^--(quiet|silent|posix|debug|sandbox|separate|unbuffered|null-data|zero-terminated|regexp-extended|follow-symlinks|binary|help|version)$/;
function analyzeSed(args) {
  const scripts = [];
  const files = [];
  let inPlace = false;
  let uncertain = false;
  let endOpts = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (endOpts || a === "-" || !a.startsWith("-")) { files.push(a); continue; }
    if (a === "--") { endOpts = true; continue; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      const val = eq < 0 ? undefined : a.slice(eq + 1);
      if ("--expression".startsWith(name) && name.length > 3) scripts.push(val ?? args[++i] ?? "");
      else if ("--file".startsWith(name) && name.length > 3) { uncertain = true; if (val === undefined) i++; }
      else if ("--in-place".startsWith(name) && name.length > 3) inPlace = true;
      else if ("--line-length".startsWith(name) && name.length > 3) { if (val === undefined) i++; }
      else if (!SED_LONG_OK.test(name)) uncertain = true;
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const ch = a[j];
      const rest = a.slice(j + 1);
      if (ch === "e") { scripts.push(rest !== "" ? rest : args[++i] ?? ""); break; }
      if (ch === "f") { uncertain = true; if (rest === "") i++; break; }
      if (ch === "i") { inPlace = true; break; }
      if (ch === "l") { if (rest === "") i++; break; }
      if ("nrEsuzb".includes(ch)) continue;
      uncertain = true; break;
    }
  }
  if (!scripts.length && !uncertain && files.length) scripts.push(files.shift());
  const hard = [];
  if (inPlace) hard.push(...files);
  if (scripts.length) {
    const r = parseSedScript(scripts.join("\n"));
    hard.push(...r.writes);
    if (r.uncertain) uncertain = true;
  }
  return { hard, soft: uncertain ? pathCandidates(args.join(" ")) : [] };
}

// ---- perl / ruby ----
const PERL_WRITES = /\b(open|sysopen|rename|unlink|truncate|system|exec|qx|link|symlink|mkdir|rmdir|chmod|chown|utime|copy|move|cp|mv|dbmopen|syscall|write_file|spew)\b|`|\$\^I|File::/;
const RUBY_WRITES = /\b(File|IO|FileUtils|Pathname|open|write|rename|delete|unlink|symlink|system|exec|spawn|syscall)\b|`|%x|\$-i/;
function analyzeInterp(kind, args) {
  const ruby = kind === "ruby";
  const code = [];
  let inPlace = false;
  let codeGiven = false;
  let k = 0;
  for (; k < args.length; k++) {
    const a = args[k];
    if (a === "--") { k++; break; }
    if (!a.startsWith("-") || a === "-") break;
    if (ruby && a.startsWith("--")) continue;
    for (let j = 1; j < a.length; j++) {
      const ch = a[j];
      const rest = a.slice(j + 1);
      if (ch === "e" || (!ruby && ch === "E")) { code.push(rest !== "" ? rest : args[++k] ?? ""); codeGiven = true; break; }
      if (ch === "i") { inPlace = true; break; }
      // opzioni che prendono il resto del gruppo (o, se vuoto, l'argomento seguente)
      if ((ruby ? "IrCE" : "I").includes(ch)) { if (rest === "") k++; break; }
      // opzioni che prendono solo il resto del gruppo
      if ((ruby ? "FxKWT" : "MmxdDFV").includes(ch)) break;
      if (ch === "0") { if (/^[xX]/.test(rest)) { j++; while (/[0-9a-fA-F]/.test(a[j + 1] ?? "")) j++; } else while (/[0-7]/.test(a[j + 1] ?? "")) j++; continue; }
      if (ch === "l") { while (/[0-7]/.test(a[j + 1] ?? "")) j++; continue; }
      if (!ruby && ch === "C") { while (/[0-9IOEioSDALa]/.test(a[j + 1] ?? "")) j++; continue; }
    }
  }
  const rest = args.slice(k);
  if (!codeGiven) rest.shift(); // il programma in un file: contenuto ignoto, non è un bersaglio
  const text = code.join("\n");
  const writesArgs = inPlace || (codeGiven && (ruby ? RUBY_WRITES : PERL_WRITES).test(text));
  return { hard: writesArgs ? rest : [], soft: codeGiven ? pathCandidates(text) : [] };
}

function analyze(head, args) {
  const kind = head.replace(/\.exe$/i, "").toLowerCase();
  return kind.endsWith("sed") ? analyzeSed(args) : analyzeInterp(kind, args);
}

// In una stringa quotata (testo che può essere prosa: `-m "fix: sed …"`) conta
// solo un'invocazione in posizione di comando: preceduta soltanto da wrapper,
// assegnazioni, opzioni o numeri, oppure subito dopo `-exec` di find. Al primo
// livello conta ogni parola sed/perl/ruby (`xargs -n 1 sed …`).
const WRAPPER = /^(sudo|doas|env|xargs|nice|nohup|time|command|builtin|exec|timeout|stdbuf|busybox|then|do|else|if|while|until|!|\{|\$)$/i;
function headLike(words, idx) {
  if (idx > 0 && /^-(exec|execdir|ok|okdir)$/i.test(words[idx - 1].v)) return true;
  return words.slice(0, idx).every(({ v }) => WRAPPER.test(v.replace(/^.*[\\/]/, "")) || /^\w+=/.test(v) || v.startsWith("-") || /^\d+$/.test(v));
}

// Bersagli di scrittura di sed/perl/ruby nel comando, seguendo i `cd` e
// scendendo nelle stringhe quotate che contengono un'invocazione
// (`bash -c "sed …"`, `"$(sed …)"`).
export function scriptWriteTargets(cwd0, cmd) {
  const out = [];
  const push = (tok, cwds, soft) => {
    if (out.length >= MAX_TARGETS) throw new PathPolicyError(`comando troppo lungo per l'analisi del guard (oltre ${MAX_TARGETS} bersagli)`);
    out.push({ tok, cwds, tree: false, soft });
  };
  const walk = (text, cwds, depth) => {
    if (depth > MAX_DEPTH) throw new PathPolicyError("comando con troppi livelli di annidamento per l'analisi del guard");
    for (const words of commands(text)) {
      const head = words[0].v.replace(/^.*[\\/]/, "");
      if (CD.test(head)) {
        const arg = words.slice(1).map((w) => w.v).find((w) => !w.startsWith("-"));
        if (arg) cwds = [...new Set([...cwds, ...cwds.map((d) => resolve(d, arg.replace(/\\/g, "/")))])].slice(0, 16);
        continue;
      }
      words.forEach((w, idx) => {
        const base = w.v.replace(/^.*[\\/]/, "");
        if (!w.v.startsWith("-") && INTERP.test(base) && (depth === 0 || headLike(words, idx))) {
          const { hard, soft } = analyze(base, words.slice(idx + 1).map((x) => x.v));
          for (const t of hard) if (t) push(t, cwds, false);
          for (const t of soft) push(t, cwds, true);
        }
        // una stringa quotata che contiene un'invocazione (non la sola parola `'sed'`)
        for (const q of w.q) if (/[\s;|&()`$]/.test(q) && INTERP_IN_TEXT.test(q)) walk(q, cwds, depth + 1);
      });
    }
  };
  walk(cmd, [cwd0], 0);
  return out;
}
