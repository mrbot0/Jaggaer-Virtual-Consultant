// Copia del plugin in una cartella temporanea (per i test di integrità: file alterato, manifesto, firma), con
// node_modules collegato (giunzione su Windows) invece di copiato.
import { cpSync, mkdtempSync, symlinkSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./hook-env.mjs";

const PARTS = ["hooks", "scripts", "schemas", "decision-tables", "strategies", "policy", "clusters", "templates", "agents", "skills", "mcp", ".claude-plugin", ".mcp.json", "NETWORK.md", "package.json"];

// modules: false ⇒ nessun node_modules (per il controllo deps di doctor), senza mai cancellare un collegamento.
export function copyPlugin(prefix = "jvc-plugin-", { modules = true } = {}) {
  const dst = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  for (const p of PARTS) if (existsSync(join(ROOT, p))) cpSync(join(ROOT, p), join(dst, p), { recursive: true });
  if (modules) symlinkSync(join(ROOT, "node_modules"), join(dst, "node_modules"), "junction");
  return dst;
}
