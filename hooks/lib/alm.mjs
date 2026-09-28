// Classificazione degli strumenti MCP dell'ALM (server del plugin `alm`, Jira, Atlassian) per guard-alm-write e
// alm-record (F0.2, §46.5, §53.3). Solo moduli built-in: è sul percorso caldo.
//
// classifyAlm(tool) → { server, op, category, object } | null (non un server ALM)
//   category: read · delete · create · update · import · additive · unknown
//   object:   execution · defect · test · incident · issue · page · comment · link · other
// Il nome dello strumento si spezza in parole (camelCase, _ e -); la prima parola d'azione riconosciuta decide la
// categoria, ma una parola di cancellazione ovunque nel nome vince sempre (fail-closed).
export const ALM_MATCHER = "mcp__.*([Aa][Ll][Mm]|[Jj][Ii][Rr][Aa]|[Aa][Tt][Ll][Aa][Ss][Ss][Ii][Aa][Nn]).*__.*";
const SERVER_RE = /(^|[_-])alm($|[_-])|jira|atlassian/i;

const DELETE = new Set(["delete", "remove", "destroy", "purge", "trash", "erase", "drop", "archive", "unlink", "wipe", "discard"]);
const READ = new Set(["get", "find", "search", "list", "query", "fetch", "lookup", "read", "view", "status", "download", "export", "info", "whoami", "check", "count", "describe", "preview", "render", "resolve", "user"]);
const CREATE = new Set(["create", "new", "add", "post", "log", "upload", "attach", "clone", "copy"]);
const UPDATE = new Set(["update", "edit", "set", "modify", "patch", "put", "assign", "unassign", "move", "rank", "transition", "close", "reopen", "change", "replace", "overwrite", "rename", "link"]);
const OBJECTS = [
  ["comment", /^(comment|comments|worklog|worklogs)$/], ["link", /^(link|links|remote|weblink)$/], ["execution", /^(execution|executions|exec|run|runs)$/],
  ["defect", /^(defect|defects|bug|bugs)$/], ["incident", /^(incident|incidents)$/], ["test", /^(test|tests)$/], ["page", /^(page|pages|blog|blogpost)$/],
  ["issue", /^(issue|issues)$/],
];

export const words = (name) => String(name).replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_-]+/).map((w) => w.toLowerCase()).filter(Boolean);

export function classifyAlm(tool) {
  const m = /^mcp__(.+?)__([^_].*)$/.exec(String(tool ?? ""));
  if (!m || !SERVER_RE.test(m[1])) return null;
  const [, server, op] = m;
  const w = words(op);
  let category = "unknown";
  if (w.some((x) => DELETE.has(x))) category = "delete";
  else if (w.includes("import") && w.some((x) => /^results?$/.test(x))) category = "import";
  else {
    for (const x of w) {
      if (READ.has(x)) { category = "read"; break; }
      if (CREATE.has(x)) { category = "create"; break; }
      if (UPDATE.has(x)) { category = "update"; break; }
    }
  }
  const objs = OBJECTS.filter(([, re]) => w.some((x) => re.test(x))).map(([o]) => o);
  // "execution" o "plan" accanto a "test" (Test Execution, Test Plan) non è un issue di tipo Test
  let object = objs[0] ?? "other";
  if (object === "test" && w.some((x) => /^(execution|executions|exec|plan|plans|set|sets|run|runs|results?|step|steps|status)$/.test(x))) object = objs.find((o) => o !== "test") ?? "other";
  // aggiunte che non sovrascrivono nulla: commenti, link, worklog (anche "createIssueLink", "addCommentToJiraIssue", alm_link)
  if ((category === "create" || category === "update") && (object === "comment" || object === "link")) category = "additive";
  if (w.includes("incident")) object = "incident";
  return { server, op, category, object, words: w };
}

// Coppie [percorso, valore] di tutti i valori scalari dell'input (profondità ≤ 12, ≤ 5000 nodi).
export function leaves(v, path = [], out = [], budget = { n: 0 }) {
  if (++budget.n > 5000) throw new Error("input dello strumento ALM troppo grande per l'analisi del guard");
  if (path.length > 12) return out;
  if (v == null) return out;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") { out.push([path, v]); return out; }
  if (Array.isArray(v)) { v.forEach((x, i) => leaves(x, [...path, String(i)], out, budget)); return out; }
  if (typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, [...path, k], out, budget);
  return out;
}

export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,30}-\d{1,9}$/;
const TARGET_KEY = /^(issue_?id_?or_?key|issue_?key|issue_?id|issue|key|id|page_?id|execution_?key|execution_?id|execution|test_?exec(ution)?_?key|test_?key|parent_?key)$/i;
// Bersagli di un update/import: i valori delle chiavi che nominano issue, pagine, esecuzioni (a ogni profondità,
// escluse le sotto-strutture di contenuto come fields/body).
export function targetKeys(ti) {
  const out = new Set();
  for (const [path, val] of leaves(ti)) {
    const k = path.at(-1);
    if (k == null || path.some((p) => /^(fields|body|content|description|comment|update|results|properties|transition|status|resolution|assignee|reporter|project|issuetype|priority|components|labels|parent|version|versions)$/i.test(p) && p !== k)) continue;
    if (TARGET_KEY.test(k) && (typeof val === "string" || typeof val === "number") && String(val).trim()) out.add(String(val).trim().toUpperCase());
  }
  return [...out];
}

// Tipo dell'issue dichiarato nell'input: valori sotto chiavi issuetype / issue_type / issueTypeName / type (anche
// { issuetype: { name } }).
export function issueTypes(ti) {
  const out = [];
  for (const [path, val] of leaves(ti)) {
    if (typeof val !== "string") continue;
    const typed = path.some((p) => /^(issue_?type(_?name)?|issuetype|type)$/i.test(p));
    const last = path.at(-1);
    if (typed && (/^(name|value|issue_?type(_?name)?|issuetype|type)$/i.test(last) || path.length === 1)) out.push(val.trim());
  }
  return out;
}

export function createdKeys(session) {
  const list = Array.isArray(session?.alm?.created) ? session.alm.created : [];
  return new Set(list.map((c) => String(typeof c === "string" ? c : c?.key ?? "").toUpperCase()).filter(Boolean));
}
