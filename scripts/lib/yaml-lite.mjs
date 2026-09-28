// Emettitore YAML minimo e deterministico (senza il modulo yaml, ~40 ms: gli hook lo evitano).
// Mappe in stile blocco; liste di scalari in stile flusso; liste di mappe come voci `- { … }`;
// stringhe fra virgolette doppie con l'escape di JSON (sottoinsieme valido di YAML 1.2).
const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const key = (k) => (KEY.test(k) ? k : JSON.stringify(k));
function scalar(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "boolean") return String(v);
  return JSON.stringify(String(v));
}
function flow(v) {
  if (Array.isArray(v)) return `[${v.map(flow).join(", ")}]`;
  if (v && typeof v === "object") return `{ ${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${key(k)}: ${flow(x)}`).join(", ")} }`.replace("{  }", "{}");
  return scalar(v);
}
function block(obj, ind) {
  const pad = " ".repeat(ind);
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (!v.length) lines.push(`${pad}${key(k)}: []`);
      else if (v.every((x) => x === null || typeof x !== "object")) lines.push(`${pad}${key(k)}: ${flow(v)}`);
      else { lines.push(`${pad}${key(k)}:`); for (const x of v) lines.push(`${pad}  - ${flow(x)}`); }
    } else if (v && typeof v === "object") {
      if (!Object.keys(v).length) lines.push(`${pad}${key(k)}: {}`);
      else { lines.push(`${pad}${key(k)}:`); lines.push(...block(v, ind + 2)); }
    } else lines.push(`${pad}${key(k)}: ${scalar(v)}`);
  }
  return lines;
}
export function toYaml(obj) { return `${block(obj, 0).join("\n")}\n`; }
