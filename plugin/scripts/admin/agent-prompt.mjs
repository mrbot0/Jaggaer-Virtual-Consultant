// Prompt del sub-agente (§46.1): resa del template e lettura dell'header YAML.
// parsePromptHeader è usato da guard-budget: niente Ajv qui in testa (la
// validazione completa carica lo schema solo se chiamata).
import YAML from "yaml";
import { validateWith } from "../lib/schemas.mjs";

// Header = primo blocco ```yaml in testa al prompt, oppure frontmatter --- … ---.
export function parsePromptHeader(prompt) {
  if (typeof prompt !== "string") return null;
  const text = prompt.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^\s*```ya?ml[ \t]*\n([\s\S]*?)\n```/.exec(text) ?? /^\s*---[ \t]*\n([\s\S]*?)\n---[ \t]*(\n|$)/.exec(text);
  if (!m) return null;
  let obj;
  try { obj = YAML.parse(m[1]); } catch { return null; }
  return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
}

export function validatePrompt(header) { return validateWith("agent-prompt.schema.json", header); }

// Sostituisce {chiave}: dentro l'header con il valore serializzato in JSON
// (JSON è YAML valido, niente iniezione di chiavi); nel testo con la stringa.
export function renderPrompt(template, values) {
  const i = template.indexOf("```", template.indexOf("```yaml") + 7);
  const head = template.slice(0, i);
  const body = template.slice(i);
  const sub = (s, asJson) => s.replace(/\{([a-z_]+)\}/g, (all, k) => (Object.hasOwn(values, k) ? (asJson ? JSON.stringify(values[k] ?? null) : String(values[k])) : all));
  return sub(head, true) + sub(body, false);
}
