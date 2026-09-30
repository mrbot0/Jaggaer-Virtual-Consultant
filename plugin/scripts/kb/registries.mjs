// Registri e coerenza della knowledge base (§8.4, §56.3, §49.3) — WP09d. Solo letture del DB (e dei file degli item,
// per il grafo e gli handoff): related, facet-count, clusters, contradictions, scopes, handoffs [--validate], graph.
// Ogni risposta è ordinata (W o conteggio) e troncata; nessun testo libero oltre ai motivi dei problemi.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { REGISTRY } from "./codes.mjs";
import { InvalidFacetError } from "./find.mjs";

const FACET_KEY_RE = /^F(1[0-5]|[1-9])$/;
export const ITEM_CODE_RE = /\b[SCL]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.[A-Z]{3}\.\d{4}(?:\.v\d+)?\b/g;
// Nomi leggibili degli scope del registro (§3); le estensioni li portano in kb/scopes.yaml (§49.3).
export const SCOPE_NAMES = Object.freeze({ CAT: "Cataloghi", SRC: "Sourcing", VEN: "Fornitori", CON: "Contratti", P2P: "Procure-to-pay",
  INV: "Fatture", QLT: "Qualità", ANL: "Analytics", ADM: "Amministrazione", XSC: "Trasversale" });
const CROSS_SCOPE = "XSC";
const OPEN_CTR = ["aperto", "aperta", "open", "irrisolta"];

const parseFile = (f) => { try { return YAML.parse(readFileSync(f, "utf8")); } catch { return null; } };

// ---- related <code> [--kind] (tabella relations, in entrambe le direzioni) ----
export function related(db, code, { kind = null, top = 20 } = {}) {
  const args = [code, code];
  let where = "(r.from_code = ? or r.to_code = ?)";
  if (kind) { where += " and r.kind = ?"; args.push(kind); }
  const rows = db.prepare(`select r.from_code, r.to_code, r.kind, i.title, i.summary, coalesce(i.weight, 0) as weight, i.status
    from relations r left join items i on i.code = case when r.from_code = ? then r.to_code else r.from_code end
    where ${where} order by weight desc, r.kind, r.from_code, r.to_code limit ?`).all(code, ...args, top + 1);
  const items = rows.slice(0, top).map((r) => ({
    code: r.from_code === code ? r.to_code : r.from_code, direction: r.from_code === code ? "out" : "in", kind: r.kind,
    title: r.title ?? null, summary: r.summary ?? null, weight: r.weight, status: r.status ?? null, exists: r.title != null,
  }));
  return { items, truncated: rows.length > top };
}

// ---- facet-count --facet Fn [--scope --type --level --customer --status] (§28.2: la matrice si conta qui) ----
export function facetCount(db, { facet, scope, type, level, customer, status } = {}) {
  if (!FACET_KEY_RE.test(String(facet ?? ""))) throw new InvalidFacetError(`faccetta non valida: ${facet} (F1..F15)`);
  const where = ["i.status <> 'deprecato'"];
  const args = [];
  if (scope) { where.push("i.scope = ?"); args.push(scope); }
  if (type) { where.push("i.type = ?"); args.push(type); }
  if (level) { where.push("i.level = ?"); args.push(level); }
  if (customer) { where.push("i.customer in (?, 'STD')"); args.push(customer); }
  if (status) { where.push("i.status = ?"); args.push(status); }
  // F6 è un elenco: ogni valore conta una volta per item; le altre faccette sono scalari (F13 è un oggetto: la release)
  const sql = facet === "F6"
    ? `select j.value as value, count(distinct i.code) as n from items i, json_each(i.facets, '$.F6') j where ${where.join(" and ")} group by j.value`
    : facet === "F13"
      ? `select json_extract(i.facets, '$.F13.release') as value, count(*) as n from items i where ${where.join(" and ")} group by value`
      : `select json_extract(i.facets, '$.${facet}') as value, count(*) as n from items i where ${where.join(" and ")} group by value`;
  const rows = db.prepare(sql).all(...args).map((r) => ({ value: r.value ?? null, n: r.n }));
  rows.sort((a, b) => b.n - a.n || String(a.value).localeCompare(String(b.value)));
  const total = db.prepare(`select count(*) as n from items i where ${where.join(" and ")}`).get(...args).n;
  return { facet, total, items: rows };
}

// ---- clusters [--family --status] ----
export function clusters(db, { family = null, status = null, top = 200 } = {}) {
  const where = ["1=1"];
  const args = [];
  if (family) { where.push("c.family = ?"); args.push(family); }
  if (status) { where.push("c.status = ?"); args.push(status); }
  const rows = db.prepare(`select c.code, c.family, c.name, c.status, coalesce(d.empty_digests, 0) as empty_digests, d.merged_into,
      (select count(*) from cluster_members m where m.cluster_code = c.code) as members
    from clusters c left join cluster_details d on d.code = c.code where ${where.join(" and ")} order by c.code limit ?`).all(...args, top + 1);
  return { items: rows.slice(0, top), truncated: rows.length > top };
}

// ---- contradictions [--open] ----
export function contradictions(db, { open = false, top = 100 } = {}) {
  const where = open ? `where lower(coalesce(status, '')) in (${OPEN_CTR.map(() => "?").join(",")}) or (status is null and resolution is null)` : "";
  const rows = db.prepare(`select code, a_code, b_code, facet, resolution, status from contradictions ${where} order by code limit ?`).all(...(open ? OPEN_CTR : []), top + 1);
  return { items: rows.slice(0, top), truncated: rows.length > top };
}

// ---- scopes: registro + estensione kb/scopes.yaml (§49.3) ----
// roots: cartelle con un kb/ (product/, customers/<C>/). Un'estensione non ancora nel registro è elencata ma i suoi
// codici non sono validi finché schemas/registry.json non la include (il registro resta la sola fonte dei codici).
export function scopes(db, { roots = [] } = {}) {
  const counts = new Map();
  if (db) for (const r of db.prepare("select scope, count(*) as n from items where status <> 'deprecato' group by scope").all()) counts.set(r.scope, r.n);
  const out = new Map(REGISTRY.scopes.map((id) => [id, { id, name: SCOPE_NAMES[id] ?? id, source: "registry", in_registry: true, items: counts.get(id) ?? 0 }]));
  const errors = [];
  for (const root of roots) {
    const f = join(root, "kb", "scopes.yaml");
    if (!existsSync(f)) continue;
    const doc = parseFile(f);
    const list = Array.isArray(doc?.scopes) ? doc.scopes : Array.isArray(doc) ? doc : null;
    if (!list) { errors.push({ file: f, error: "kb/scopes.yaml senza l'elenco scopes" }); continue; }
    for (const s of list) {
      if (!s || !/^[A-Z0-9]{3}$/.test(String(s.id ?? ""))) { errors.push({ file: f, error: `scope non valido: ${JSON.stringify(s?.id ?? s)}` }); continue; }
      const cur = out.get(s.id);
      if (cur) { if (s.name) cur.name = s.name; if (s.description) cur.description = s.description; if (s.neighbours) cur.neighbours = s.neighbours; continue; }
      out.set(s.id, { id: s.id, name: s.name ?? s.id, description: s.description ?? null, neighbours: s.neighbours ?? [], source: "extension", in_registry: false, items: counts.get(s.id) ?? 0,
        note: "estensione (§49.3): i codici dello scope valgono dopo l'aggiunta a schemas/registry.json" });
    }
  }
  return { items: [...out.values()], errors };
}

// ---- handoffs [--validate] ----
function hndFile(root, row) { return root && row.path ? join(root, row.path) : null; }
export function handoffs(db, { root = null, scope = null } = {}) {
  const rows = db.prepare("select code, scope, path, status from items where type = 'HND' and status <> 'deprecato' order by code").all();
  const items = [];
  for (const r of rows) {
    const f = hndFile(root, r);
    const it = f && existsSync(f) ? parseFile(f) : null;
    const h = { code: r.code, from_scope: it?.from_scope ?? null, to_scope: it?.to_scope ?? null, owner_of_test: it?.owner_of_test ?? null,
      reciprocal_test: it?.reciprocal_test ?? null, stop_at_step: it?.stop_at_step ?? null, contract: it?.contract ?? null, readable: !!it };
    if (scope && ![h.from_scope, h.to_scope, h.owner_of_test, r.scope].includes(scope)) continue;
    items.push(h);
  }
  return { items };
}

// Ogni HND ha i due lati (from/to diversi, contratto che produce e consuma), il proprietario del test su uno dei due
// lati, il confine (stop_at_step) e il test reciproco (§27.1, §49.3 `kb handoffs --validate`).
export function validateHandoffs(list) {
  const problems = [];
  for (const h of list) {
    const p = [];
    if (!h.readable) p.push("file dell'item non leggibile (serve --root)");
    else {
      if (!h.from_scope || !h.to_scope) p.push("manca un lato (from_scope/to_scope)");
      else if (h.from_scope === h.to_scope) p.push("i due lati coincidono");
      if (h.owner_of_test && h.from_scope && h.to_scope && ![h.from_scope, h.to_scope].includes(h.owner_of_test)) p.push(`owner_of_test ${h.owner_of_test} non è un lato dell'handoff`);
      if (h.contract && typeof h.contract === "object" && (!h.contract.produces || !h.contract.consumes)) p.push("il contratto non dice cosa produce e cosa consuma");
      if (h.stop_at_step == null) p.push("manca stop_at_step (il confine)");
      if (!h.reciprocal_test) p.push("manca il test reciproco (reciprocal_test)");
    }
    if (p.length) problems.push({ code: h.code, problems: p });
  }
  return { ok: problems.length === 0, problems };
}

// ---- graph [--scope] — coerenza: riferimenti pendenti, handoff mancanti per riferimenti fra scope ----
// known: codici esistenti altrove (es. il DB di prodotto per gli S citati da un DB cliente).
export function graph(db, { root = null, scope = null, known = null, top = 50 } = {}) {
  const all = new Map(db.prepare("select code, status, type, scope from items").all().map((r) => [r.code, r]));
  const hasS = [...all.keys()].some((c) => c.startsWith("S."));
  const items = db.prepare(`select code, scope, type, path from items where status <> 'deprecato'${scope ? " and scope = ?" : ""} order by code`).all(...(scope ? [scope] : []));
  const rel = db.prepare("select to_code from relations where from_code = ?");
  const pairs = new Set();
  const refsOf = new Map();
  let unreadable = 0;
  for (const r of items) {
    const refs = new Set(rel.all(r.code).map((x) => x.to_code));
    const f = root && r.path ? join(root, r.path) : null;
    if (f && existsSync(f)) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(ITEM_CODE_RE)) refs.add(m[0]);
      if (r.type === "HND") {
        const h = parseFile(f);
        if (h?.from_scope && h?.to_scope) { pairs.add(`${h.from_scope}>${h.to_scope}`); pairs.add(`${h.to_scope}>${h.from_scope}`); }
      }
    } else if (root) unreadable++;
    refs.delete(r.code);
    refs.delete(r.code.replace(/\.v\d+$/, ""));
    refsOf.set(r.code, [...refs]);
  }
  const dangling = [];
  const deprecated = [];
  const unverified = [];
  const cross = new Map();
  for (const r of items) {
    for (const to of refsOf.get(r.code)) {
      const base = to.replace(/\.v\d+$/, "");
      const hit = all.get(to) ?? all.get(base);
      if (!hit) {
        if (known?.has(to) || known?.has(base)) { /* esiste nell'altro DB */ } else if (to.startsWith("S.") && !hasS && !known) unverified.push({ from: r.code, to });
        else dangling.push({ from: r.code, to });
      } else if (hit.status === "deprecato") deprecated.push({ from: r.code, to });
      const toScope = to.split(".")[2];
      if (r.type !== "HND" && toScope && toScope !== r.scope && r.scope !== CROSS_SCOPE && toScope !== CROSS_SCOPE && to.split(".")[3] !== "HND") {
        const key = `${r.scope}>${toScope}`;
        if (!pairs.has(key)) {
          const cur = cross.get(key) ?? { from_scope: r.scope, to_scope: toScope, count: 0, examples: [] };
          cur.count++;
          if (cur.examples.length < 3) cur.examples.push({ from: r.code, to });
          cross.set(key, cur);
        }
      }
    }
  }
  const missing = [...cross.values()].sort((a, b) => b.count - a.count || `${a.from_scope}${a.to_scope}`.localeCompare(`${b.from_scope}${b.to_scope}`));
  return {
    ok: dangling.length === 0 && missing.length === 0,
    scanned: items.length, unreadable,
    dangling: dangling.slice(0, top), dangling_total: dangling.length,
    deprecated_refs: deprecated.slice(0, top), deprecated_total: deprecated.length,
    unverified: unverified.slice(0, top), unverified_total: unverified.length,
    missing_handoffs: missing,
  };
}
