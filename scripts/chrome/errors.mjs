// Riconoscimento degli errori della piattaforma in una pagina osservata (§20.6, K6.2): funzione pura
// sui pattern compilati di scripts/chrome/error-patterns.yaml. Nessun modulo esterno.
//   detectErrors(page) → [{ message, code, category, kind, blocking, lang }]
import P from "../../hooks/lib/generated/error-patterns.mjs";
import { clean } from "./snapshot-parse.mjs";

const re = (src) => new RegExp(src, "iu");
const CODE = new RegExp(P.code, "u");
const SUCCESS = re(P.success);
const ERROR_TEXT = re(P.error_text);
const CATS = P.categories.map((c) => ({ ...c, itRe: re(c.it), enRe: re(c.en) }));
const IT_WORDS = /\b(il|la|non|è|di|del|della|per|campo|obbligatori|sessione|errore|stato)\b/iu;

export function categorize(text) {
  for (const c of CATS) {
    if (c.itRe.test(text)) return { category: c.id, blocking: c.blocking, lang: "it" };
    if (c.enRe.test(text)) return { category: c.id, blocking: c.blocking, lang: "en" };
  }
  return null;
}

export function detectErrors(page) {
  const out = [];
  const seen = new Set();
  const consider = (text, role) => {
    const t = clean(text);
    if (!t || seen.has(t)) return;
    const code = CODE.exec(t)?.[0] ?? null;
    const cat = categorize(t);
    const errorish = cat || code || ERROR_TEXT.test(t);
    if (!errorish || (SUCCESS.test(t) && !cat)) return;
    seen.add(t);
    const lang = cat?.lang ?? (IT_WORDS.test(t) ? "it" : "en");
    out.push({ message: t, code, category: cat?.category ?? "validation", kind: P.kinds[role] ?? "red-text", blocking: cat?.blocking ?? true, lang });
  };
  for (const m of page?.messages ?? []) consider(m.text, m.role);
  for (const e of page?.elements ?? []) if (["alert", "alertdialog", "dialog", "status"].includes(e.role) && e.name) consider(e.name, e.role);
  for (const t of page?.texts ?? []) if (ERROR_TEXT.test(clean(t) ?? "") || CODE.test(t)) consider(t, "text");
  return out;
}
