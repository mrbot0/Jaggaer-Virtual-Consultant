// Digestione settimanale, passo 1 RACCOLTA (§22, §45.6) — WP09d. SOLA LETTURA su ogni cliente del workspace:
// lezioni validate, item L clusterizzati (con il file e i cluster), CTR (registro e item), OBS con ≥ 3 conferme,
// DEC + esiti della settimana, forme epistemiche, sessioni (sorprese, budget) e check. Il DB si apre in sola lettura
// (mai openDb: applicherebbe le migrazioni), i file si leggono e basta. I valori restano in memoria: escono dal
// cliente solo pseudonimizzati (pseudonymize.mjs), nel report e nei candidati.
import Database from "../kb/sqlite.mjs";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { parseLesson } from "../kb/lesson.mjs";

export const CUSTOMER_RE = /^[A-Z0-9]{4}$/;
export const MIN_CONFIRMATIONS = 3;

export function listCustomers(ws) {
  try { return readdirSync(join(ws, "customers"), { withFileTypes: true }).filter((e) => e.isDirectory() && CUSTOMER_RE.test(e.name)).map((e) => e.name).sort(); } catch { return []; }
}

export function openReadonly(file) {
  if (!existsSync(file)) return null;
  return new Database(file, { readonly: true, fileMustExist: true });
}

const safe = (fn, d) => { try { return fn(); } catch { return d; } };
const parseJson = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const inWindow = (at, { from, to }) => { const t = Date.parse(at ?? ""); return Number.isFinite(t) && (!from || t >= Date.parse(from)) && (!to || t < Date.parse(to)); };

// Settimana ISO (YYYY-Www) e finestra [lunedì, lunedì successivo) di una data.
export function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - y0) / 86400000 + 1) / 7);
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() || 7) - 1)));
  const next = new Date(monday.getTime() + 7 * 86400000);
  return { id: `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`, week, year: d.getUTCFullYear(), from: monday.toISOString(), to: next.toISOString() };
}

function readItemFile(root, path) {
  if (!path) return null;
  const f = join(root, path);
  try { return YAML.parse(readFileSync(f, "utf8")); } catch { return null; }
}

function lessons(dir, window) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => /^L\..*\.LSN\.\d{4}(\.v\d+)?\.md$/.test(x)).sort()) {
    const l = parseLesson(readFileSync(join(dir, f), "utf8"));
    const fm = l.frontmatter;
    if (fm?.status !== "validated") continue;
    const at = fm.validation?.at ?? null;
    if (window.from && at && !inWindow(at, window)) continue;
    out.push({ code: fm.id ?? f.replace(/\.md$/, ""), scope: fm.scope ?? null, subject: fm.subject ?? null, at, confirmations: fm.confirmations ?? 0 });
  }
  return out;
}

// Sorprese per compito (§13.2-13.3): il compito è il piano (plan) a cui step-check le attribuisce; la 3ª sorpresa di un
// compito lo ferma (escalate). Sorprese senza piano contano come un compito della sessione.
export function surprisesByTask(surprises) {
  const by = new Map();
  for (const x of surprises) { const k = x?.plan ?? x?.task ?? "_sessione"; by.set(k, (by.get(k) ?? 0) + 1); }
  return { tasks: Math.max(1, by.size), stopped: [...by.values()].filter((n) => n >= 3).length };
}

function sessions(dir, window) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const f = join(dir, e.name, "session.json");
    if (!existsSync(f)) continue;
    const s = safe(() => JSON.parse(readFileSync(f, "utf8")), null);
    if (!s) continue;
    const at = s.updated_at ?? new Date(statSync(f).mtimeMs).toISOString();
    if (window.from && !inWindow(at, window)) continue;
    const surprises = Array.isArray(s.surprises) ? s.surprises : [];
    const t = surprisesByTask(surprises);
    out.push({ id: e.name, at, surprises: surprises.length, tasks: t.tasks, stopped: t.stopped,
      tokens: s.budget?.used ?? 0, by_model: s.budget?.by_model ?? {} });
  }
  return out;
}

export function collectCustomer(ws, customer, window = {}) {
  const root = join(ws, "customers", customer);
  const out = { customer, items: [], lessons: lessons(join(root, "lessons"), window), contradictions: [], ctr_items: [], observations: [],
    decisions: [], epistemic: [], checks: { total: 0, new: 0 }, sessions: sessions(join(root, ".sessions"), window), releases: [] };
  const db = openReadonly(join(root, "knowledge.db"));
  if (!db) return out;
  try {
    out.releases = safe(() => parseJson(db.prepare("select value from meta where key='releases'").get()?.value, []), []);
    const members = new Map();
    for (const m of safe(() => db.prepare("select cluster_code, item_code from cluster_members").all(), [])) {
      if (!members.has(m.item_code)) members.set(m.item_code, []);
      members.get(m.item_code).push(m.cluster_code);
    }
    const rows = safe(() => db.prepare(`select code, scope, type, title, summary, facets, quality, confidence, status, path, verified_at, release_ref, updated_at
      from items where level = 'L' and status = 'clusterizzato' order by code`).all(), []);
    for (const r of rows) {
      const obj = readItemFile(root, r.path);
      out.items.push({ customer, code: r.code, scope: r.scope, type: r.type, title: r.title, facets: parseJson(r.facets, {}), quality: r.quality,
        confidence: r.confidence, status: r.status, release: r.release_ref, obj, clusters: [...new Set([...(members.get(r.code) ?? []), ...(Array.isArray(obj?.cluster) ? obj.cluster : [])])] });
    }
    out.contradictions = safe(() => db.prepare("select code, a_code, b_code, facet, resolution, status from contradictions").all(), []);
    out.ctr_items = safe(() => db.prepare("select code, scope, title, status from items where type = 'CTR' and status <> 'deprecato'").all(), []);
    out.observations = safe(() => db.prepare("select code, scope, page_sig, confirmed_count from observations where confirmed_count >= ?").all(MIN_CONFIRMATIONS), []);
    const decs = safe(() => db.prepare(`select d.code, d.table_code, d.outcome, d.strategy, d.subject_cluster, d.agent, d.at, o.result
      from decisions d left join outcomes o on o.decision_code = d.code order by d.code`).all(), []);
    out.decisions = window.from ? decs.filter((d) => inWindow(d.at, window)) : decs;
    out.epistemic = safe(() => db.prepare("select subject_code, shape from epistemic").all(), []);
    const chk = safe(() => db.prepare("select updated_at from items where type = 'CHK' and status <> 'deprecato'").all(), []);
    out.checks = { total: chk.length, new: window.from ? chk.filter((c) => inWindow(c.updated_at, window)).length : 0 };
    out.cluster_decay = safe(() => db.prepare("select code, empty_digests from cluster_details where empty_digests >= 2").all(), []);
    out.all_items = safe(() => db.prepare("select code, type, status, release_ref, verified_at from items where status <> 'deprecato'").all(), []);
  } finally { db.close(); }
  return out;
}

export function collect(ws, { customers = listCustomers(ws), window = {} } = {}) {
  return { window, customers: Object.fromEntries(customers.map((c) => [c, collectCustomer(ws, c, window)])) };
}
