// Parser XML minimo e tollerante (WP09a): DOCX, XLSX, PPTX, export di configurazione JAGGAER, XSD/WSDL.
// Nessuna dipendenza. Non valida: costruisce l'albero e sopravvive ai tag non chiusi.
//
//   parseXml(text) → nodo radice { name, attrs, children: [nodo | stringa] }
//   local(name)             nome senza prefisso di namespace ("w:p" → "p")
//   kids(node, name?)       figli elemento (per nome locale, se dato)
//   kid(node, name)         primo figlio elemento con quel nome locale
//   find(node, name)        tutti i discendenti con quel nome locale (ordine di documento)
//   textOf(node)            testo concatenato dei discendenti
//   XmlError                testo senza alcun elemento
const BOM = String.fromCharCode(0xfeff);
export class XmlError extends Error { constructor(m) { super(m); this.name = "XmlError"; } }

const ENT = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: String.fromCharCode(160) };
export function decodeEntities(s) {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return ENT[e] ?? m;
  });
}

const ATTR = /([^\s=/>]+)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
function parseAttrs(s) {
  const attrs = {};
  if (!s) return attrs;
  ATTR.lastIndex = 0;
  let m;
  while ((m = ATTR.exec(s))) attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? "");
  return attrs;
}

export function parseXml(input) {
  const s = String(input ?? "").replace(BOM, "");
  const root = { name: "#document", attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  const pushText = (t) => { if (t) top().children.push(t); };
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) { pushText(decodeEntities(s.slice(i))); break; }
    if (lt > i) pushText(decodeEntities(s.slice(i, lt)));
    if (s.startsWith("<!--", lt)) { const e = s.indexOf("-->", lt + 4); i = e < 0 ? s.length : e + 3; continue; }
    if (s.startsWith("<![CDATA[", lt)) { const e = s.indexOf("]]>", lt + 9); const end = e < 0 ? s.length : e; pushText(s.slice(lt + 9, end)); i = e < 0 ? s.length : e + 3; continue; }
    if (s.startsWith("<?", lt)) { const e = s.indexOf("?>", lt + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (s.startsWith("<!", lt)) {
      // DOCTYPE, con eventuale sottoinsieme interno fra quadre
      let j = lt + 2, depth = 0;
      while (j < s.length) { const c = s[j]; if (c === "[") depth++; else if (c === "]") depth--; else if (c === ">" && depth <= 0) break; j++; }
      i = j + 1; continue;
    }
    // tag: cerca la ">" fuori dalle virgolette
    let j = lt + 1, q = null;
    while (j < s.length) { const c = s[j]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === ">") break; j++; }
    const raw = s.slice(lt + 1, j);
    i = j + 1;
    if (raw[0] === "/") {
      const name = raw.slice(1).trim();
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      continue;
    }
    const selfClose = raw.endsWith("/");
    const body = selfClose ? raw.slice(0, -1) : raw;
    const sp = body.search(/\s/);
    const name = sp < 0 ? body : body.slice(0, sp);
    if (!name) continue;
    const node = { name, attrs: parseAttrs(sp < 0 ? "" : body.slice(sp)), children: [] };
    top().children.push(node);
    if (!selfClose) stack.push(node);
  }
  const first = root.children.find((c) => typeof c === "object");
  if (!first) throw new XmlError("nessun elemento XML");
  return first;
}

export const local = (name) => { const k = String(name).indexOf(":"); return k < 0 ? name : name.slice(k + 1); };
export const kids = (node, name) => (node?.children ?? []).filter((c) => typeof c === "object" && (name === undefined || local(c.name) === name));
export const kid = (node, name) => (node?.children ?? []).find((c) => typeof c === "object" && local(c.name) === name) ?? null;
export function find(node, name, out = []) {
  for (const c of node?.children ?? []) {
    if (typeof c !== "object") continue;
    if (local(c.name) === name) out.push(c);
    find(c, name, out);
  }
  return out;
}
export function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  let out = "";
  for (const c of node.children) out += typeof c === "string" ? c : textOf(c);
  return out;
}
export const attr = (node, name) => {
  if (!node) return undefined;
  if (node.attrs[name] !== undefined) return node.attrs[name];
  const k = Object.keys(node.attrs).find((a) => local(a) === name);
  return k === undefined ? undefined : node.attrs[k];
};
