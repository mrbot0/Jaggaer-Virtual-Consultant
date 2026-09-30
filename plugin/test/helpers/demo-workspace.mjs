// Workspace dimostrativo "pronto" per doctor e per il gate di uscita F0: cliente ACME con environments.yaml (esempio di
// §51.1), knowledge.db (WAL, migrazioni applicate), audit con catena valida, xray.yaml con coda offline, retention,
// .claude/settings.json dal template, sessione con ambiente sandbox dichiarato e verificato, credenziali per prefisso.
import { mkdirSync, writeFileSync, copyFileSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, seedSession } from "./hook-env.mjs";
import { ENV_FIXTURE, envEntry } from "./env-fixture.mjs";
import { openDb } from "../../scripts/kb/db.mjs";
import { appendAudit } from "../../hooks/lib/audit.mjs";

export const DEMO_ENV = { NRT_SBX_USER: "demo", NRT_SBX_PASSWORD: "x", NRT_PRE_USER: "demo", NRT_PRE_PASSWORD: "x", NRT_PRD_USER: "demo", NRT_PRD_PASSWORD: "x", XRAY_CLIENT_ID: "id", XRAY_CLIENT_SECRET: "s", JIRA_USER: "u", JIRA_TOKEN: "t" };

export function demoWorkspace() {
  const ws = realpathSync.native(mkdtempSync(join(tmpdir(), "jvc-demo-")));
  for (const d of ["product/kb", ".jvc/sessions", "customers/ACME/config", "customers/ACME/kb/scopes/P2P", "customers/ACME/lessons", ".claude"]) mkdirSync(join(ws, d), { recursive: true });
  copyFileSync(ENV_FIXTURE, join(ws, "customers/ACME/config/environments.yaml"));
  writeFileSync(join(ws, "customers/ACME/config/xray.yaml"), "deployment: cloud\nbase_url: https://acme.atlassian.net\noffline_queue: true\nallow_test_issue_creation: false\n");
  writeFileSync(join(ws, "customers/ACME/config/retention.yaml"), "observations_days: 90\nruns_months: 12\naudit_months: 24\nagreed_with: referente ACME\n");
  copyFileSync(join(ROOT, "templates/settings.template.json"), join(ws, ".claude/settings.json"));
  openDb(join(ws, "customers/ACME/knowledge.db")).close();
  seedSession(ws, { scope: "P2P", extra: { env: envEntry("sandbox") } });
  appendAudit(ws, { session: "sess-1", customer: "ACME", scope: "P2P", kind: "session", actor: "cli", payload: { action: "demo" } });
  appendAudit(ws, { session: "sess-1", customer: "ACME", scope: "P2P", kind: "tool", actor: "manager", payload: { tool: "Read" } });
  return ws;
}
