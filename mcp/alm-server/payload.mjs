// Evidenze verso Jira/Xray (§27.5, ADR-18/19): nel dossier il payload cita i FILE delle evidenze (leggibile, non
// base64); prima dell'invio materialize() le legge e le codifica. Solo evidenze del run del cliente
// (customers/<C>/runs/**, realpath, niente collegamenti), con i metadati EVD accanto (<nn>.yaml) che dichiarano
// profile: strict e publishable: true (profilo strict imposto su Jira) e, se c'è, sha256 coincidente col file.
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { join, extname, basename, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { AlmError } from "./adapter.mjs";

const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".txt": "text/plain", ".json": "application/json", ".html": "text/html", ".pdf": "application/pdf" };
export const contentTypeOf = (f) => TYPES[extname(String(f)).toLowerCase()] ?? "application/octet-stream";
const MAX_BYTES = 10 * 1024 * 1024;

// Percorso del workspace ammesso per un'evidenza ⇒ assoluto (realpath), altrimenti AlmError refused.
export function evidencePath(ws, customer, file) {
  if (typeof file !== "string" || !file || isAbsolute(file) || file.includes("\0")) throw new AlmError("refused", `evidenza con percorso non ammesso: ${JSON.stringify(file)} (relativo al workspace, sotto customers/${customer}/runs/)`);
  const root = (() => { try { return realpathSync.native(join(ws, "customers", customer, "runs")); } catch { return null; } })();
  let abs;
  try { abs = realpathSync.native(join(ws, file)); } catch { throw new AlmError("input", `evidenza inesistente: ${file}`); }
  const rel = root ? relative(root, abs) : "..";
  if (!root || rel.startsWith("..") || isAbsolute(rel)) throw new AlmError("refused", `evidenza fuori da customers/${customer}/runs/ (o dietro un collegamento): ${file}`);
  return abs;
}

export async function loadEvd(abs) {
  const meta = abs.slice(0, abs.length - extname(abs).length) + ".yaml";
  if (!existsSync(meta)) return null;
  const YAML = (await import("yaml")).default;
  try { return YAML.parse(readFileSync(meta, "utf8")); } catch { return null; }
}

// Un'evidenza { file, filename?, contentType? } ⇒ { data, filename, contentType } (profilo strict verificato).
export async function materializeOne(ws, customer, ev) {
  const abs = evidencePath(ws, customer, ev.file);
  const evd = await loadEvd(abs);
  if (!evd || evd.type !== "EVD") throw new AlmError("refused", `evidenza senza metadati EVD: ${ev.file}`);
  if (evd.profile !== "strict" || evd.publishable !== true) throw new AlmError("refused", `evidenza ${evd.id ?? ev.file} non pubblicabile su Jira: profilo ${evd.profile}, publishable ${evd.publishable} (strict imposto, §27.5)`);
  const buf = readFileSync(abs);
  if (buf.length > MAX_BYTES) throw new AlmError("refused", `evidenza oltre 10 MB: ${ev.file}`);
  if (typeof evd.sha256 === "string" && /^[0-9a-f]{64}$/.test(evd.sha256) && createHash("sha256").update(buf).digest("hex") !== evd.sha256) throw new AlmError("refused", `evidenza ${evd.id ?? ev.file} alterata dopo la cattura (sha256 diverso dai metadati)`);
  return { data: buf.toString("base64"), filename: ev.filename ?? basename(abs), contentType: ev.contentType ?? contentTypeOf(abs) };
}

// Risultati nativi con evidenze per file ⇒ risultati con evidenze codificate. allowInline: false rifiuta `data` già
// presenti (il server MCP accetta solo evidenze del dossier, così il profilo strict è verificabile).
export async function materializeResults(ws, customer, results, { allowInline = false } = {}) {
  const one = async (e) => {
    if (e && typeof e.file === "string") return materializeOne(ws, customer, e);
    if (e && typeof e.data === "string") {
      if (!allowInline) throw new AlmError("refused", "evidenza inline (base64) non ammessa: citare il file dell'evidenza nel dossier (profilo strict verificabile)");
      return { data: e.data, filename: e.filename, contentType: e.contentType };
    }
    throw new AlmError("input", "evidenza senza file");
  };
  const tests = [];
  for (const t of results?.tests ?? []) {
    const steps = [];
    for (const s of t.steps ?? []) steps.push({ ...s, ...(s.evidence ? { evidence: await Promise.all(s.evidence.map(one)) } : {}) });
    tests.push({ ...t, ...(t.steps ? { steps } : {}), ...(t.evidence ? { evidence: await Promise.all(t.evidence.map(one)) } : {}) });
  }
  return { ...results, tests };
}

export async function materializeAttachments(ws, customer, files = [], { allowInline = false } = {}) {
  const out = [];
  for (const e of files ?? []) {
    if (e && typeof e.file === "string") out.push(await materializeOne(ws, customer, e));
    else if (allowInline && e && typeof e.data === "string") out.push(e);
    else throw new AlmError("refused", "allegato del Defect: solo evidenze del dossier (file sotto runs/, profilo strict)");
  }
  return out;
}
