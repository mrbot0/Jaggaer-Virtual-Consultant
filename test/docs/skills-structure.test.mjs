// WP10c — struttura delle skill (§44.3, brief wp10c-skills): agent-manager più ESATTAMENTE le 26 skill dell'elenco di
// §44.3 (uguaglianza di insiemi: la prosa dice "22", l'elenco 26); SKILL.md ≤ 400 righe con frontmatter name +
// description (condizioni d'uso), niente allowed-tools né context: fork; references/ collegati e tutti citati; ogni
// §n citato esiste nella spec; skill, script, schemi, template, DT e STR citati esistono; righe di comando semplici
// (tokenizzatore dei guard, niente JSON in linea) di script che rispondono a --help.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, cleanEnv } from "../helpers/hook-env.mjs";
import { simpleArgv } from "../../hooks/lib/exact-argv.mjs";
import { commandLines, renderLine } from "../helpers/commands.mjs";
import { skillRefs, scriptRefs } from "../helpers/agents-md.mjs";
import { SKILLS_DIR, MANAGER, WP10C_SKILLS, ALL_SKILLS, SPEC_FILE, SECTIONS_FIXTURE, skillDirs, allSkills, fullText, sectionCitations, specSections, knownSections } from "../helpers/skills-md.mjs";

const flat = (s) => s.replace(/\s+/g, " ");

test("skills/: agent-manager più esattamente le 26 skill di §44.3 (27 cartelle, niente di più né di meno)", () => {
  assert.equal(WP10C_SKILLS.length, 26, "l'elenco di §44.3 ha 26 nomi (la prosa dice 22: vale l'elenco)");
  assert.equal(new Set(WP10C_SKILLS).size, 26);
  assert.ok(!WP10C_SKILLS.includes(MANAGER), "agent-manager non è una delle 26");
  assert.ok(existsSync(join(SKILLS_DIR, MANAGER, "SKILL.md")), "manca skills/agent-manager/SKILL.md");
  assert.deepEqual(skillDirs(), [...ALL_SKILLS].sort());
  for (const d of ALL_SKILLS) assert.ok(existsSync(join(SKILLS_DIR, d, "SKILL.md")), `${d}: SKILL.md`);
  for (const d of skillDirs()) for (const f of readdirSync(join(SKILLS_DIR, d))) assert.ok(["SKILL.md", "references"].includes(f), `${d}: file inatteso ${f}`);
});

test("SKILL.md ≤ 400 righe; frontmatter name = cartella e description con le condizioni d'uso; niente allowed-tools né context: fork", () => {
  for (const s of allSkills()) {
    assert.ok(s.lines <= 400, `${s.name}: ${s.lines} righe (> 400)`);
    assert.ok(s.fm, `${s.name}: frontmatter YAML`);
    assert.equal(s.fm.name, s.name, `${s.name}: name`);
    assert.ok(typeof s.fm.description === "string" && s.fm.description.length >= 120 && s.fm.description.length <= 1024, `${s.name}: description (120–1024 caratteri)`);
    assert.match(s.fm.description, /\bUsala\b/, `${s.name}: la description dichiara quando usarla`);
    const allowed = s.name === MANAGER ? ["name", "description", "disable-model-invocation"] : ["name", "description"];
    for (const k of Object.keys(s.fm)) assert.ok(allowed.includes(k), `${s.name}: chiave di frontmatter inattesa ${k}`);
    assert.ok(!("allowed-tools" in s.fm) && !("context" in s.fm), s.name);
    assert.ok(s.body.trim().length > 0 && /^# /m.test(s.body), `${s.name}: corpo con titolo`);
  }
});

test("references/: ogni file è citato da SKILL.md e ogni collegamento references/… esiste", () => {
  for (const s of allSkills()) {
    const linked = new Set([...s.text.matchAll(/\]\((references\/[^)\s]+\.md)\)/g)].map((m) => m[1]));
    for (const l of linked) assert.ok(existsSync(join(SKILLS_DIR, s.name, l)), `${s.name}: ${l} inesistente`);
    for (const r of s.refs) assert.ok(linked.has(`references/${r.file}`), `${s.name}: references/${r.file} non citato da SKILL.md`);
    for (const r of s.refs) assert.ok(r.text.split("\n").length <= 400, `${s.name}: references/${r.file} oltre 400 righe`);
  }
});

test("§n citati: ogni sezione citata esiste nell'indice o nei titoli della spec (elenco allineato alla spec quando c'è)", () => {
  const { sections } = knownSections();
  const known = new Set(sections);
  if (existsSync(SPEC_FILE)) {
    const fixture = readFileSync(SECTIONS_FIXTURE, "utf8").replace(/\r\n/g, "\n").split("\n").filter(Boolean);
    assert.deepEqual(fixture, specSections(readFileSync(SPEC_FILE, "utf8")), "test/fixtures/spec/sections.txt non è allineato alla spec: rigeneralo");
  }
  const bad = [];
  for (const s of allSkills()) for (const c of sectionCitations(fullText(s))) if (!known.has(c)) bad.push(`${s.name}: §${c}`);
  assert.deepEqual(bad, []);
  const all = allSkills();
  for (const s of all.filter((x) => x.name !== MANAGER)) assert.ok(sectionCitations(fullText(s)).length >= 1, `${s.name}: nessuna sezione della spec citata`);
});

test("riferimenti interni: skill, script, schemi, template, tabelle DT e strategie STR citati esistono", () => {
  const dts = new Set(readdirSync(join(ROOT, "decision-tables")).filter((f) => /^DT-\d{3}\.yaml$/.test(f)).map((f) => f.slice(0, -5)));
  const strs = new Set(readdirSync(join(ROOT, "strategies")).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)));
  const bad = [];
  for (const s of allSkills()) {
    const t = fullText(s);
    for (const r of skillRefs(t)) if (!ALL_SKILLS.includes(r)) bad.push(`${s.name}: skill ${r}`);
    for (const r of scriptRefs(t)) if (!existsSync(join(ROOT, r))) bad.push(`${s.name}: ${r}`);
    for (const m of t.matchAll(/\b(schemas\/[a-z0-9-]+\.(?:schema\.json|yaml)|templates\/[a-z0-9-]+\.md|docs\/[a-z0-9-]+\.md|decision-tables\/[A-Za-z0-9-]+\.yaml)\b/g)) if (!existsSync(join(ROOT, m[1]))) bad.push(`${s.name}: ${m[1]}`);
    for (const m of t.matchAll(/\bDT-(\d{3})\b/g)) if (!dts.has(`DT-${m[1]}`)) bad.push(`${s.name}: DT-${m[1]}`);
    for (const m of t.matchAll(/\bSTR-[A-Z][A-Z-]*[A-Z]\b/g)) if (!strs.has(m[0])) bad.push(`${s.name}: ${m[0]}`);
  }
  assert.deepEqual(bad, []);
});

test("righe di comando delle skill: invocazioni semplici del plugin (tokenizzatore dei guard), niente JSON in linea, script che rispondono a --help", () => {
  const bad = [];
  const scripts = new Set();
  for (const s of allSkills()) {
    for (const line of commandLines(fullText(s))) {
      if (!simpleArgv(renderLine(line, "C:/plugin"))) bad.push(`${s.name}: riga non semplice: ${line}`);
      if (/['"]\{|\{"|--inputs\s+['"{]/.test(line)) bad.push(`${s.name}: JSON in linea: ${line}`);
      const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[^"]+\.mjs)"/.exec(line);
      if (!m) bad.push(`${s.name}: non è uno script del plugin: ${line}`); else scripts.add(m[1]);
    }
  }
  assert.deepEqual(bad, []);
  const failed = [];
  for (const sc of scripts) {
    if (!existsSync(join(ROOT, sc))) { failed.push(`${sc}: inesistente`); continue; }
    const r = spawnSync(process.execPath, [join(ROOT, sc), "--help"], { env: cleanEnv(), encoding: "utf8", timeout: 30000 });
    if (r.status !== 0) failed.push(`${sc}: exit ${r.status}`);
  }
  assert.deepEqual(failed, []);
});

test("le 26 skill di metodo: niente comandi di sessione, console o grant (sono della sessione principale), niente --session con l'id di Claude", () => {
  for (const s of allSkills().filter((x) => x.name !== MANAGER)) {
    const lines = commandLines(fullText(s));
    for (const l of lines) {
      assert.doesNotMatch(l, /scripts\/admin\/(session|agents|control|purge|retention)\.mjs/, `${s.name}: ${l}`);
      assert.doesNotMatch(l, /CLAUDE_SESSION_ID/, `${s.name}: ${l}`);
    }
    assert.doesNotMatch(flat(s.body), /use paths --agent [a-z-]+ --grant/, `${s.name}: il permesso trasversale lo concede solo il manager`);
  }
});
