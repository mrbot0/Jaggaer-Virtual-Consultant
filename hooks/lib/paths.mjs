// Normalizzazione dei percorsi per i guard (codice di sicurezza, §48.3 T3).
// Principio: da un percorso grezzo si ricavano TUTTE le interpretazioni
// plausibili (grezza, URL-decodificata, "scheletro" senza sosia unicode,
// variante Windows senza punti/spazi finali e stream alternati; ciascuna
// risolta sia lessicalmente sia fisicamente, seguendo symlink e junction
// segmento per segmento). Il guard nega se ANCHE UNA viola la politica.
// Confronti sempre case-insensitive (Windows e macOS lo sono; su Linux
// significa negare di più, mai di meno). Separatori: `\` vale sempre come `/`.
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class PathPolicyError extends Error {}

const IS_WIN = process.platform === "win32";
const P = IS_WIN ? path.win32 : path.posix;
export const GLOB_CHARS = /[*?[\]{}]/;

// Sosia latini più comuni (greco, cirillico, altri) — lo scheletro serve solo a
// rilevare mascheramenti; non sostituisce mai il percorso reale.
const CONFUSABLES = {
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
  α: "a", β: "b", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ϲ: "c", ϳ: "j",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", Ѕ: "S", І: "I", Ј: "J", Ү: "Y",
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", ѕ: "s", і: "i", ј: "j", ӏ: "l", ԁ: "d", ԛ: "q", ԝ: "w",
  ı: "i", ſ: "s", ℓ: "l",
};
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿]/g;

export function skeleton(s) {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").replace(INVISIBLE, "").replace(/[^\x00-\x7F]/g, (c) => CONFUSABLES[c] ?? c);
}

const slash = (s) => s.replace(/\\/g, "/");
const lower = (s) => s.normalize("NFC").toLowerCase();

function stripDevice(s) {
  return s.replace(/^\/\/[?.]\/UNC\//i, "//").replace(/^\/\/[?.]\//, "");
}

// Variante Windows: via punti e spazi finali dei segmenti, via gli stream
// alternati (`nome::$DATA`, `nome:stream`); un segmento di soli punti (≥ 2)
// vale come "..".
function winStrip(s) {
  return slash(s).split("/").map((seg, i) => {
    if (seg === "." || seg === "..") return seg;
    let t = seg;
    if (!(i === 0 && /^[A-Za-z]:$/.test(t))) t = t.replace(/:.*$/, "");
    t = t.replace(/[. ]+$/, (m) => (/^[. ]+$/.test(t) ? m : ""));
    if (/^[. ]+$/.test(t)) return t.replace(/ /g, "").length >= 2 ? ".." : t.replace(/ /g, "") || ".";
    return t;
  }).join("/");
}

function decodeAll(s) {
  const out = [];
  let d = s;
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(d); i++) {
    try { d = decodeURIComponent(d); } catch { d = d.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))); }
    out.push(d);
  }
  return out;
}

export function variants(raw) {
  if (typeof raw !== "string" || raw === "") throw new PathPolicyError("percorso mancante o non testuale");
  if (raw.includes("\0")) throw new PathPolicyError("percorso con byte NUL");
  const out = new Set([raw]);
  for (const d of decodeAll(raw)) {
    if (d.includes("\0")) throw new PathPolicyError("percorso con byte NUL (codificato)");
    out.add(d);
  }
  for (const v of [...out]) {
    if (/^file:\/\//i.test(v)) { try { out.add(fileURLToPath(v.replace(/\\/g, "/"))); } catch { /* URL non valido */ } }
  }
  for (const v of [...out]) { out.add(skeleton(v)); out.add(winStrip(v)); out.add(winStrip(skeleton(v))); }
  return [...out].map((v) => stripDevice(slash(v)));
}

// Risoluzione fisica: segmento per segmento, realpath dopo ogni passo, così
// `link/..` va al padre del BERSAGLIO del link, come fa il sistema operativo.
function physical(v, cwd) {
  const native = IS_WIN ? v.replace(/\//g, "\\") : v;
  let cur; let rest;
  if (P.isAbsolute(native)) { const root = P.parse(P.resolve(native)).root; cur = root; rest = native.slice(P.parse(native).root.length); } else { cur = cwd; rest = native; }
  try { cur = realpathSync.native(cur); } catch { /* radice inesistente: resta lessicale */ }
  let exists = true;
  for (const seg of rest.split(/[\\/]+/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { cur = P.dirname(cur); continue; }
    cur = P.join(cur, seg);
    if (!exists) continue;
    try { cur = realpathSync.native(cur); } catch (err) {
      if (err.code === "ELOOP") throw new PathPolicyError("percorso con ciclo di link simbolici");
      exists = false;
    }
  }
  return cur;
}

const absForm = (p) => lower(slash(p)).replace(/\/+$/, (m, off, s) => (s.length === 1 || /^[a-z]:\/$/.test(s) ? m : ""));

function relTo(abs, base) {
  if (abs === base) return "";
  const b = base.endsWith("/") ? base : `${base}/`;
  return abs.startsWith(b) ? abs.slice(b.length) : null;
}

export function bases(dir) {
  const out = new Set([absForm(P.resolve(dir))]);
  try { out.add(absForm(realpathSync.native(dir))); } catch { /* inesistente */ }
  return [...out];
}

// → { ws: Set<rel minuscolo>, plugin: Set<rel>, abs: Set<assoluto minuscolo> }
export function resolveTarget(raw, { cwd, ws, plugin }) {
  const wsB = bases(ws);
  const plB = plugin ? bases(plugin) : [];
  const out = { ws: new Set(), plugin: new Set(), abs: new Set() };
  for (const v of variants(raw)) {
    const native = IS_WIN ? v.replace(/\//g, "\\") : v;
    for (const a of [P.resolve(cwd, native), physical(v, cwd)]) {
      const abs = absForm(a);
      out.abs.add(abs);
      for (const b of wsB) { const r = relTo(abs, b); if (r !== null) out.ws.add(r); }
      for (const b of plB) { const r = relTo(abs, b); if (r !== null) out.plugin.add(r); }
    }
  }
  // Lo scheletro va applicato anche al relativo: con un percorso assoluto il
  // prefisso del workspace (es. una cartella utente con accenti) non
  // sopravvive allo scheletro e il mascheramento sfuggirebbe.
  for (const set of [out.ws, out.plugin]) for (const r of [...set]) { set.add(lower(skeleton(r))); set.add(lower(winStrip(skeleton(r)))); }
  return out;
}

// Pattern di ricerca (Glob / Grep): il prefisso letterale si risolve come un
// percorso; il resto (dal primo segmento con jolly) non può contenere '..'.
// Se il prefisso è un antenato del workspace, la ricerca può raggiungere
// tutto il workspace: rel = "**". `unanchoredBasename`: un pattern senza '/'
// vale a ogni profondità (semantica gitignore/ripgrep).
export function resolvePattern(baseDir, pattern, { cwd, ws, plugin, unanchoredBasename = false }) {
  if (typeof pattern !== "string" || pattern === "") throw new PathPolicyError("pattern mancante");
  if (pattern.includes("\0")) throw new PathPolicyError("pattern con byte NUL");
  const out = { ws: new Set(), plugin: new Set(), abs: new Set() };
  for (const pv of new Set([pattern, ...decodeAll(pattern), skeleton(pattern)])) {
    let pat = slash(pv);
    if (unanchoredBasename && !pat.replace(/\/+$/, "").includes("/") && !P.isAbsolute(pat)) pat = `**/${pat}`;
    const segs = pat.split("/");
    const absolute = pat.startsWith("/") || /^[A-Za-z]:/.test(pat);
    let i = segs.findIndex((s) => GLOB_CHARS.test(s));
    if (i < 0) i = segs.length;
    const restSegs = segs.slice(i).filter((s) => s !== "" && s !== ".");
    if (restSegs.some((s) => s === ".." || /^\.{2,}\s*$/.test(s))) throw new PathPolicyError("pattern con '..' dopo un carattere jolly");
    const rest = lower(restSegs.join("/"));
    const prefix = segs.slice(0, i).join("/");
    const prefixPath = absolute ? prefix || "/" : `${slash(baseDir)}/${prefix}`;
    const t = resolveTarget(prefixPath, { cwd, ws, plugin });
    const join = (r) => (r === "" ? rest : rest ? `${r}/${rest}` : r);
    for (const r of t.ws) out.ws.add(join(r));
    for (const r of t.plugin) out.plugin.add(join(r));
    for (const a of t.abs) {
      out.abs.add(rest ? `${a}/${rest}` : a);
      if (rest) {
        for (const b of bases(ws)) if (b.startsWith(a.endsWith("/") ? a : `${a}/`)) out.ws.add("**");
        if (plugin) for (const b of bases(plugin)) if (b.startsWith(a.endsWith("/") ? a : `${a}/`)) out.plugin.add("**");
      }
    }
  }
  return out;
}

// ---------- confronto fra pattern (segmenti, minuscolo) ----------

export const segs = (p) => lower(slash(p)).split("/").filter((s) => s !== "" && s !== ".");
const hasGlob = (s) => GLOB_CHARS.test(s);
const reCache = new Map();

function segRegex(g) {
  if (reCache.has(g)) return reCache.get(g);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") { const j = g.indexOf("}", i); if (j < 0) { re += "\\{"; continue; } re += `(?:${g.slice(i + 1, j).split(",").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, "[^/]*").replace(/\\\?/g, "[^/]")).join("|")})`; i = j; }
    else if (c === "[") { const j = g.indexOf("]", i + 1); if (j < 0) { re += "\\["; continue; } let cls = g.slice(i + 1, j); if (cls.startsWith("!")) cls = `^${cls.slice(1)}`; re += `[${cls.replace(/\\/g, "\\\\")}]`; i = j; }
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  const r = new RegExp(`^${re}$`, "u");
  reCache.set(g, r);
  return r;
}

function segCompat(a, b) {
  const ga = hasGlob(a); const gb = hasGlob(b);
  if (!ga && !gb) return a === b;
  if (ga && gb) return true;
  return ga ? segRegex(a).test(b) : segRegex(b).test(a);
}

// Esiste un percorso che soddisfa sia p sia q?
export function intersects(p, q) {
  const A = segs(p); const B = segs(q);
  const memo = new Map();
  const go = (i, j) => {
    const k = i * 1000 + j;
    if (memo.has(k)) return memo.get(k);
    let r;
    if (i === A.length && j === B.length) r = true;
    else if (A[i] === "**") r = go(i + 1, j) || (j < B.length && go(i, j + 1));
    else if (B[j] === "**") r = go(i, j + 1) || (i < A.length && go(i + 1, j));
    else if (i === A.length || j === B.length) r = false;
    else r = segCompat(A[i], B[j]) && go(i + 1, j + 1);
    memo.set(k, r);
    return r;
  };
  return go(0, 0);
}

// Ogni percorso che soddisfa p soddisfa anche q? (approssimazione prudente:
// in caso di dubbio risponde false, e il guard nega)
export function subset(p, q) {
  const A = segs(p); const B = segs(q);
  const memo = new Map();
  const go = (i, j) => {
    const k = i * 1000 + j;
    if (memo.has(k)) return memo.get(k);
    let r;
    if (j === B.length) r = i === A.length;
    else if (B[j] === "**") r = go(i, j + 1) || (i < A.length && go(i + 1, j));
    else if (i === A.length || A[i] === "**") r = false;
    else if (!hasGlob(A[i])) r = segCompat(A[i], B[j]) && go(i + 1, j + 1);
    else r = (B[j] === "*" || A[i] === B[j]) && go(i + 1, j + 1);
    memo.set(k, r);
    return r;
  };
  return go(0, 0);
}

export const matchGlob = (p, globs) => globs.some((g) => subset(p, g));
