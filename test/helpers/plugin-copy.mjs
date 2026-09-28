// Copia del plugin in una cartella temporanea (per i test di integrità: file alterato, manifesto, firma), con
// node_modules collegato (giunzione su Windows) invece di copiato.
import { cpSync, mkdtempSync, symlinkSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./hook-env.mjs";

const PARTS = ["hooks", "scripts", "schemas", "decision-tables", "strategies", "policy", "clusters", "templates", ".claude-plugin", ".mcp.json", "package.json"];

export function copyPlugin(prefix = "jvc-plugin-") {
  const dst = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  for (const p of PARTS) if (existsSync(join(ROOT, p))) cpSync(join(ROOT, p), join(dst, p), { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(dst, "node_modules"), "junction");
  return dst;
}
