// Riassunto redatto e troncato dell'input di uno strumento, per l'audit:
// nomi, percorsi, lunghezze — mai il contenuto dei file né il testo dei prompt.
import { redact, truncate } from "./redact.mjs";

const len = (s) => (typeof s === "string" ? s.length : undefined);
const CONTENT_KEYS = /^(content|text|body|data|new_string|old_string|new_source|prompt|edits|input|file_text)$/i;

const PICK = {
  Write: (i) => ({ file_path: i.file_path, content_chars: len(i.content) }),
  Edit: (i) => ({ file_path: i.file_path, old_chars: len(i.old_string), new_chars: len(i.new_string), replace_all: i.replace_all }),
  MultiEdit: (i) => ({ file_path: i.file_path, edits: Array.isArray(i.edits) ? i.edits.length : undefined }),
  NotebookEdit: (i) => ({ notebook_path: i.notebook_path, edit_mode: i.edit_mode, cell_id: i.cell_id }),
  Read: (i) => ({ file_path: i.file_path, offset: i.offset, limit: i.limit }),
  Glob: (i) => ({ pattern: i.pattern, path: i.path }),
  Grep: (i) => ({ pattern: truncate(i.pattern, 120), path: i.path, glob: i.glob, output_mode: i.output_mode }),
  Bash: (i) => ({ command: truncate(i.command, 360), description: truncate(i.description, 80) }),
  PowerShell: (i) => ({ command: truncate(i.command, 360), description: truncate(i.description, 80) }),
  Agent: (i) => ({ subagent_type: i.subagent_type, model: i.model, description: truncate(i.description, 80), task_id: /(?:^|\n)\s*task_id:\s*["']?([^\s"'\n]+)/.exec(i.prompt ?? "")?.[1] }),
  WebFetch: (i) => ({ url: i.url }),
};
PICK.Task = PICK.Agent;

export function summarizeInput(tool, input = {}) {
  let obj;
  const i = input && typeof input === "object" ? input : {};
  if (PICK[tool]) obj = PICK[tool](i);
  else {
    obj = {};
    for (const [k, v] of Object.entries(i)) {
      if (CONTENT_KEYS.test(k)) { obj[`${k}_chars`] = typeof v === "string" ? v.length : undefined; continue; }
      if (v == null || typeof v === "boolean" || typeof v === "number") obj[k] = v;
      else if (typeof v === "string") obj[k] = truncate(v, 120);
    }
  }
  return truncate(redact(JSON.stringify(obj)), 500);
}
