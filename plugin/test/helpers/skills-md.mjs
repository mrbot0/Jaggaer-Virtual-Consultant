// WP10c — helper dei test delle skill (skills/<nome>/SKILL.md e references/*.md, §44.3): elenco, frontmatter YAML,
// corpo, file di riferimento, citazioni di sezione (§n) e sezioni esistenti nella spec (indice e titoli).
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { ROOT } from "./hook-env.mjs";
import { WP10C_SKILLS } from "./agents-md.mjs";

export { WP10C_SKILLS };
export const SKILLS_DIR = join(ROOT, "skills");
export const MANAGER = "agent-manager";
// Le 26 di §44.3 più la skill della sessione principale: 27 cartelle (la prosa di §44.3 dice "22", l'elenco ne ha 26).
export const ALL_SKILLS = [...WP10C_SKILLS, MANAGER];
// la spec sta accanto al repository (una o due cartelle sopra il plugin, che è in <repo>/plugin/)
export const SPEC_FILE = [join(ROOT, "..", "jaggaer-virtual-consultant-architettura.md"), join(ROOT, "..", "..", "jaggaer-virtual-consultant-architettura.md")].find((f) => existsSync(f)) ?? join(ROOT, "..", "jaggaer-virtual-consultant-architettura.md");
export const SECTIONS_FIXTURE = join(ROOT, "test", "fixtures", "spec", "sections.txt");

const lf = (s) => s.replace(/\r\n/g, "\n");

export const skillDirs = () => (existsSync(SKILLS_DIR) ? readdirSync(SKILLS_DIR).filter((d) => statSync(join(SKILLS_DIR, d)).isDirectory()).sort() : []);

export function readSkill(name) {
  const file = join(SKILLS_DIR, name, "SKILL.md");
  const text = lf(readFileSync(file, "utf8"));
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  const refDir = join(SKILLS_DIR, name, "references");
  const refs = existsSync(refDir) ? readdirSync(refDir).filter((f) => f.endsWith(".md")).sort().map((f) => ({ file: f, text: lf(readFileSync(join(refDir, f), "utf8")) })) : [];
  return { name, file, text, fm: m ? YAML.parse(m[1]) : null, body: m ? m[2] : text, refs, lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0) };
}

export const allSkills = () => skillDirs().filter((d) => existsSync(join(SKILLS_DIR, d, "SKILL.md"))).map(readSkill);
// Tutto il testo di una skill (SKILL.md e riferimenti), per i controlli di contenuto.
export const fullText = (s) => [s.text, ...s.refs.map((r) => r.text)].join("\n");

// Citazioni di sezione: §12, §19.6, §6.5.2 (anche in intervalli "§19.1–19.5": vale il primo e il secondo numero).
export function sectionCitations(text) {
  const out = new Set();
  for (const m of text.matchAll(/§(\d+(?:\.\d+)*)(?:[–-](\d+(?:\.\d+)*))?/g)) {
    out.add(m[1]);
    if (m[2]) out.add(m[2]);
  }
  return [...out];
}

// Sezioni della spec: le righe dell'indice (| … | n | Titolo |) e i titoli numerati (## n. / ### n.m / #### n.m.k).
export function specSections(specText) {
  const out = new Set();
  const text = lf(specText);
  const idx = text.indexOf("## Indice");
  const end = text.indexOf("\n---", idx);
  for (const line of text.slice(idx, end).split("\n")) { const m = /^\|[^|]*\|\s*(\d+)\s*\|/.exec(line); if (m) out.add(m[1]); }
  for (const m of text.matchAll(/^#{2,4} (\d+(?:\.\d+)*)[.\s]/gm)) out.add(m[1]);
  return [...out].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

// La spec vive fuori dal repository del plugin: se c'è si usa lei, altrimenti la copia dell'elenco in test/fixtures.
export function knownSections() {
  if (existsSync(SPEC_FILE)) return { source: "spec", sections: specSections(readFileSync(SPEC_FILE, "utf8")) };
  return { source: "fixture", sections: lf(readFileSync(SECTIONS_FIXTURE, "utf8")).split("\n").filter(Boolean) };
}

// Skill citate in un corpo, anche negli elenchi ("skill `a`, `b` e `c`"): skillRefs di agents-md prende solo la prima.
export const allSkillRefs = (body) => [...new Set([...String(body).matchAll(/skill[e]?\s+(`[a-z0-9-]+`(?:(?:,\s*|\s+e\s+)`[a-z0-9-]+`)*)/g)]
  .flatMap((m) => [...m[1].matchAll(/`([a-z0-9-]+)`/g)].map((x) => x[1])))];
