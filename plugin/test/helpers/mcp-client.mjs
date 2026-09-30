// Client MCP stdio minimo per i test: avvia `node mcp/alm-server/server.mjs` come processo, invia righe JSON-RPC e
// attende le risposte per id (JSON delimitato da a capo, come Claude Code).
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ROOT, cleanEnv } from "./hook-env.mjs";

export const ALM_SERVER = join(ROOT, "mcp", "alm-server", "server.mjs");

export function startMcp(env = {}, { script = ALM_SERVER } = {}) {
  const child = spawn(process.execPath, [script], { env: cleanEnv(env), stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  const lines = [];
  let buf = "";
  let stderr = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      lines.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  child.stderr.on("data", (d) => { stderr += d; });
  const raw = (line) => child.stdin.write(`${line}\n`);
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { waiting.delete(id); reject(new Error(`timeout ${method}; stderr: ${stderr}`)); }, 15000);
      waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      raw(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }));
    });
  };
  const notify = (method, params) => raw(JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }));
  const call = async (name, args = {}) => {
    const r = await request("tools/call", { name, arguments: args });
    const text = r.result?.content?.[0]?.text ?? null;
    let data = null;
    try { data = text && !r.result.isError ? JSON.parse(text) : null; } catch { data = null; }
    return { ...r, text, data, isError: r.result?.isError === true };
  };
  const close = () => new Promise((resolve) => { child.once("exit", (code) => resolve(code)); child.stdin.end(); setTimeout(() => child.kill(), 5000).unref(); });
  return { child, request, notify, call, raw, close, lines, stderr: () => stderr };
}

// Handshake standard: initialize + notifications/initialized.
export async function initialized(c) {
  const r = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "jvc-test", version: "1" } });
  c.notify("notifications/initialized");
  return r;
}
