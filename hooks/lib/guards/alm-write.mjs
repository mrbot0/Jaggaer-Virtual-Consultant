// guard-alm-write (PreToolUse mcp__.*(alm|jira|atlassian).*__.*, FAIL-CLOSED) — F0.2, §32, §44.4, §46.5, ADR-21, ADR-27.
// Il server ALM del plugin non implementa cancellazioni (la prima difesa è l'assenza di codice); questo guard è la
// seconda, anche per i server Jira/Atlassian generici. Divieti:
//  1. delete/remove/archive (in qualunque punto del nome) e transizione o stato verso "cancellato" ⇒ deny sempre;
//  2. overwrite di contenuto umano: update/transition/import solo su bersagli creati dal plugin in QUESTA sessione
//     (session.alm.created[], scritto da alm-record); bersaglio non identificabile ⇒ deny; aggiunte (commenti, link)
//     consentite;
//  3. Incident: mai (solo Defect, ADR-27); creazione di una issue con tipo non determinabile o diverso da
//     Bug/Defect/Test Execution ⇒ deny;
//  4. issue di tipo Test solo con `allow_test_issue_creation: true` in customers/<C>/config/xray.yaml (ADR-21);
//  5. confine di dominio: un payload che cita PAT/PBK/BRF/RUL, INC-/TICKET-/PAT- o analysis/ ⇒ deny (§1.1).
// Letture: nessuna opinione. Operazioni non classificate ⇒ deny. Senza cliente attivo: solo letture.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { guardContext, denyAudited } from "./common.mjs";
import { skeleton } from "../paths.mjs";
import { classifyAlm, leaves, targetKeys, issueTypes, issueTypeIds, createdKeys, xrayPinRefusal } from "../alm.mjs";
import { BOUNDARY_RULES } from "../../../scripts/kb/validate-boundary.mjs";

const G = "guard-alm-write";
const DELETED = /\b(delet|remov|elimin|cancellat|trash|archiv|purg|destroy)/i;
const ALLOWED_TYPES = /^(bug|defect|difetto|test execution|test esecuzione|esecuzione di test)$/i;
const TEST_TYPE = /^(test|xray test|test case|caso di test)$/i;
// giro 1 (M3): senza distinzione di maiuscole (c.acme.p2p.pat.0003, Analysis/)
const KB_RULES = BOUNDARY_RULES.filter((r) => r.dir === "kb").map((r) => ({ ...r, re: new RegExp(r.re.source, r.re.flags.includes("i") ? r.re.flags : `${r.re.flags}i`) }));

function allowTestIssues(ctx) {
  if (!ctx.customer) return false;
  let text;
  try { text = readFileSync(join(ctx.ws, "customers", ctx.customer, "config", "xray.yaml"), "utf8"); } catch { return false; }
  return /^allow_test_issue_creation:\s*true\s*(#.*)?$/m.test(text);
}

// WP08 giro 1 (I6): mappa id → nome del tipo di issue, dichiarata dal cliente in config/xray.yaml (issuetype_ids).
async function issueTypeMap(ctx) {
  let text;
  try { text = readFileSync(join(ctx.ws, "customers", ctx.customer, "config", "xray.yaml"), "utf8"); } catch { return {}; }
  const YAML = (await import("yaml")).default;
  const m = YAML.parse(text)?.issuetype_ids;
  return m && typeof m === "object" && !Array.isArray(m) ? Object.fromEntries(Object.entries(m).map(([k, v]) => [String(k).trim(), String(v)])) : {};
}

function boundaryViolation(ti) {
  const texts = leaves(ti).flatMap(([path, v]) => [String(v), ...path]);
  for (const t of texts) for (const s of [t, skeleton(t)]) for (const r of KB_RULES) { const m = r.re.exec(s); if (m) return `${r.rule} → "${m[0]}"`; }
  return null;
}

export async function decide(input, env = process.env) {
  const c = classifyAlm(input.tool_name);
  if (!c) return null;
  const ctx = guardContext(input, env);
  if (!ctx.jvc) return null;
  const no = (reason) => denyAudited(ctx, G, reason);
  const ti = ctx.ti;
  const at = `${c.op} (${c.server})`;
  if (c.category === "read") return null;
  if (c.category === "delete") return no(`${at}: l'ALM non si cancella mai (delete/remove/archive): la compensazione è chiudere o annullare, e solo su issue create dal plugin (§46.5)`);
  if (c.category === "unknown") return no(`${at}: operazione ALM non classificata (né lettura, né creazione, né aggiornamento riconosciuti): negata per default`);
  if (!ctx.customer) return no(`${at}: nessun cliente attivo: le scritture sull'ALM richiedono una sessione con cliente (use customer <ID>)`);
  // WP09c giro 1 (C1 b): config/xray.yaml (host, deroga ADR-21, mappa dei tipi) com'era a use customer
  const pin = xrayPinRefusal(ctx.ws, ctx.customer, ctx.session);
  if (pin) return no(`${at}: ${pin}`);
  const values = leaves(ti);
  // 1. transizione o stato verso "cancellato"
  if (c.category === "update" || c.category === "import") {
    const statusish = values.filter(([path]) => path.some((p) => /^(transition|status|state|resolution|to|to_status|target_status)$/i.test(p)) || (c.words.includes("transition") && path.length === 1));
    const bad = statusish.find(([, v]) => typeof v === "string" && DELETED.test(v));
    if (bad) return no(`${at}: transizione o stato verso "${bad[1]}": nell'ALM non si cancella mai, nemmeno le issue del plugin`);
  }
  // 5. confine di dominio (prima delle altre verifiche: il motivo è il più utile)
  const b = boundaryViolation(ti);
  if (b) return no(`${at}: confine di dominio — l'ALM (dominio dei test) non cita il dominio analitico (§1.1): ${b}`);
  if (c.category === "additive") return null;
  // 2. overwrite di contenuto umano
  if (c.category === "update" || c.category === "import") {
    const keys = targetKeys(ti);
    if (!keys.length) return no(`${at}: bersaglio dell'aggiornamento non identificabile: si aggiornano solo issue create dal plugin in questa sessione`);
    const mine = createdKeys(ctx.session);
    const human = keys.filter((k) => !mine.has(k));
    if (human.length) {
      return no(c.category === "import"
        ? `${at}: alm_import_results solo su esecuzioni create dal plugin in questa sessione (session.alm.created): ${human.join(", ")}`
        : `${at}: ${human.join(", ")} non creata dal plugin in questa sessione: il contenuto umano non si sovrascrive (§46.5)`);
    }
    return null;
  }
  // create
  const types = issueTypes(ti);
  // 3a. tipo per id: solo se la mappa del cliente lo risolve; id sconosciuto ⇒ deny (un Incident si nasconde così)
  const ids = issueTypeIds(ti);
  if (ids.length) {
    const map = await issueTypeMap(ctx);
    const unknown = ids.find((id) => !Object.hasOwn(map, id));
    if (unknown) return no(`${at}: tipo di issue per id "${unknown}" non risolvibile (issuetype_ids in customers/${ctx.customer}/config/xray.yaml): il plugin crea solo Defect (ADR-27)`);
    types.push(...ids.map((id) => map[id]));
  }
  // 3. Incident
  if (c.object === "incident" || types.some((t) => /incident/i.test(t))) return no(`${at}: creare un Incident è vietato: il plugin apre solo Defect (ADR-27)`);
  // 4. Test issue
  const isTest = c.object === "test" || types.some((t) => TEST_TYPE.test(t));
  if (isTest) return allowTestIssues(ctx) ? null : no(`${at}: creare issue di tipo Test richiede la deroga allow_test_issue_creation: true in customers/${ctx.customer}/config/xray.yaml (ADR-21)`);
  if (c.object === "defect" || c.object === "execution" || c.object === "page") {
    const other = types.find((t) => !ALLOWED_TYPES.test(t));
    if (other) return no(`${at}: tipo di issue "${other}" non ammesso: solo Defect (ADR-27) ed esecuzioni di test`);
    return null;
  }
  // issue generica: il tipo va dichiarato ed è Bug/Defect/Test Execution
  if (!types.length) return no(`${at}: tipo dell'issue non determinabile: il plugin crea solo Defect (ADR-27) ed esecuzioni di test, dichiarati esplicitamente`);
  const bad = types.find((t) => !ALLOWED_TYPES.test(t));
  if (bad) return no(`${at}: tipo di issue "${bad}" non ammesso: solo Defect (ADR-27) ed esecuzioni di test`);
  return null;
}
