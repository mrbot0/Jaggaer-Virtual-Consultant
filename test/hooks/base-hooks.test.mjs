import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { mkWs, seedSession, runHook, hookScript, cleanEnv } from "../helpers/hook-env.mjs";
import { verifyChain } from "../../hooks/scripts/audit-append.mjs";
import { handle as auditHandle, summarizeInput } from "../../hooks/scripts/audit-append.mjs";
import { redact } from "../../hooks/lib/redact.mjs";

const auditLines = (ws, customer = "ACME") => {
  const dir = customer ? join(ws, "customers", customer, "audit") : join(ws, ".jvc", "audit");
  if (!existsSync(dir)) return { file: null, events: [] };
  const f = readdirSync(dir).find((x) => x.endsWith(".jsonl"));
  if (!f) return { file: null, events: [] };
  const file = join(dir, f);
  return { file, events: readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
};
const ctxOf = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";

// ---------- session-context ----------

test("session-context: senza cliente scrive puntatore + current-session + CLAUDE_ENV_FILE e chiede use customer", () => {
  const ws = mkWs();
  const envFile = join(ws, "env.sh");
  writeFileSync(envFile, "");
  const r = runHook("session-context", { session_id: "abc-123", source: "startup", cwd: ws, hook_event_name: "SessionStart" }, { JVC_WORKSPACE: ws, CLAUDE_ENV_FILE: envFile });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(ctxOf(r), /use customer <ID>/);
  assert.match(ctxOf(r), /agent-manager/);
  assert.equal(readFileSync(join(ws, ".jvc/current-session"), "utf8").trim(), "abc-123");
  assert.equal(JSON.parse(readFileSync(join(ws, ".jvc/sessions/abc-123.json"), "utf8")).customer, null);
  assert.match(readFileSync(envFile, "utf8"), /^export JVC_SESSION_ID=abc-123$/m);
  assert.ok(r.ms < 2000, `SessionStart ${r.ms.toFixed(0)} ms ≥ 2 s`);
  console.log(`session-context (senza cliente): ${r.ms.toFixed(0)} ms`);
});

test("session-context: con cliente inietta lo stato compatto (cliente, ambiente, scope, modo, budget, pendenze, ultime 3 sorprese)", () => {
  const ws = mkWs();
  seedSession(ws, {
    sid: "s2", budget: { tokens: 200000, used: 61200, by_model: { haiku: 22000, sonnet: 31200, opus: 8000 } },
    pending: { compensations: ["CMP.0012"], approvals: [], questions: ["Q.0007"], expected_outcomes: ["L.ACME.ADM.DEC.0518"] },
    extra: { surprises: [1, 2, 3, 4].map((i) => ({ at: `2026-09-22T10:0${i}:00Z`, item: `S.STD.ADM.SEL.014${i}`, obs: `L.ACME.ADM.OBS.030${i}` })) },
  });
  const r = runHook("session-context", { session_id: "s2", source: "resume", cwd: ws }, { JVC_WORKSPACE: ws });
  const c = ctxOf(r);
  assert.match(c, /ACME/); assert.match(c, /CAT/); assert.match(c, /nrt/);
  assert.match(c, /61200\/200000/);
  assert.match(c, /CMP\.0012/); assert.match(c, /Q\.0007/); assert.match(c, /L\.ACME\.ADM\.DEC\.0518/);
  assert.match(c, /S\.STD\.ADM\.SEL\.0144/); assert.doesNotMatch(c, /S\.STD\.ADM\.SEL\.0141/, "solo le ultime tre sorprese");
  assert.match(c, /ambiente/i);
  assert.doesNotMatch(c, /use customer <ID>/);
  assert.equal(JSON.parse(readFileSync(join(ws, ".jvc/sessions/s2.json"), "utf8")).customer, "ACME", "il puntatore esistente è conservato");
});

test("session-context: source=compact reinietta compact-summary.md", () => {
  const ws = mkWs();
  seedSession(ws, { sid: "s3" });
  writeFileSync(join(ws, "customers/ACME/.sessions/s3/compact-summary.md"), "# Riassunto\ncompito in corso: MSG.s3.0004\n");
  const r = runHook("session-context", { session_id: "s3", source: "compact", cwd: ws }, { JVC_WORKSPACE: ws });
  assert.match(ctxOf(r), /compito in corso: MSG\.s3\.0004/);
  const r2 = runHook("session-context", { session_id: "s3", source: "startup", cwd: ws }, { JVC_WORKSPACE: ws });
  assert.doesNotMatch(ctxOf(r2), /MSG\.s3\.0004/);
});

test("session-context: fuori da un workspace JVC non scrive nulla e non dà contesto; eccezione → exit 0 con avviso (fail-open)", () => {
  const plain = realpathSync.native(mkdtempSync(join(tmpdir(), "plain-")));
  const r = runHook("session-context", { session_id: "x", source: "startup", cwd: plain }, { CLAUDE_PROJECT_DIR: plain });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
  assert.equal(existsSync(join(plain, ".jvc")), false);
  const ws = mkWs();
  const t = runHook("session-context", { session_id: "x", source: "startup", cwd: ws }, { JVC_WORKSPACE: ws, JVC_TEST_THROW: "1" });
  assert.equal(t.status, 0);
  assert.match(t.json.systemMessage, /avviso/);
  const bad = runHook("session-context", "{non json", { JVC_WORKSPACE: ws });
  assert.equal(bad.status, 0);
  assert.ok(bad.json.systemMessage);
});

// ---------- precompact-save ----------

test("precompact-save: compact-summary.md ≤ 20 righe con cliente, scope, modo, ultimi tre rapporti, pendenze, sorprese; tocca updated_at", () => {
  const ws = mkWs();
  const file = seedSession(ws, {
    sid: "s4", pending: { compensations: ["CMP.0001"], approvals: [], questions: [], expected_outcomes: [] },
    extra: { updated_at: "2020-01-01T00:00:00.000Z", surprises: [{ at: "2026-09-22T10:00:00Z", item: "S.STD.CAT.SEL.0001", obs: "L.ACME.CAT.OBS.0001" }] },
  });
  const bb = join(ws, "customers/ACME/.sessions/s4/blackboard");
  for (let i = 1; i <= 5; i++) writeFileSync(join(bb, `MSG.s4.000${i}.yaml`), `task_id: MSG.s4.000${i}\nstatus_effective: ok\nlesson: L.ACME.CAT.LSN.000${i}\n`);
  const transcript = join(ws, "t.jsonl");
  writeFileSync(transcript, [
    JSON.stringify({ type: "user", message: { role: "user", content: "prima richiesta" } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "genera i test negativi del catalogo" }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
  ].join("\n") + "\n");
  const r = runHook("precompact-save", { session_id: "s4", cwd: ws, transcript_path: transcript, hook_event_name: "PreCompact", trigger: "auto" }, { JVC_WORKSPACE: ws });
  assert.equal(r.status, 0, r.stderr);
  const sumFile = join(ws, "customers/ACME/.sessions/s4/compact-summary.md");
  const text = readFileSync(sumFile, "utf8");
  const lines = text.trim().split("\n");
  assert.ok(lines.length <= 20, `${lines.length} righe`);
  assert.match(text, /ACME/); assert.match(text, /CAT/); assert.match(text, /nrt/);
  assert.match(text, /CMP\.0001/); assert.match(text, /S\.STD\.CAT\.SEL\.0001/);
  assert.match(text, /genera i test negativi del catalogo/);
  const reportCodes = text.match(/MSG\.s4\.000\d/g) ?? [];
  assert.equal(new Set(reportCodes).size, 3, "ultimi tre rapporti del blackboard");
  const s = JSON.parse(readFileSync(file, "utf8"));
  assert.notEqual(s.updated_at, "2020-01-01T00:00:00.000Z");
  assert.equal(s.last_compact_summary, ".sessions/s4/compact-summary.md");
});

// ---------- stop-integrity ----------

test("stop-integrity: non blocca mai; audit + nota con compensazioni pendenti, compiti senza lezione, esiti attesi, browser sconosciuto", () => {
  const ws = mkWs();
  seedSession(ws, {
    sid: "s5", pending: { compensations: ["CMP.0012"], approvals: [], questions: [], expected_outcomes: ["L.ACME.ADM.DEC.0518"] },
    extra: { ledger: { invocations: [{ agent_id: "a1", task_id: "MSG.s5.0001", lesson: null, status_effective: "partial" }, { agent_id: "a2", task_id: "MSG.s5.0002", lesson: "L.ACME.CAT.LSN.0001", status_effective: "ok" }], trace_blocks: {} } },
  });
  const r = runHook("stop-integrity", { session_id: "s5", cwd: ws, hook_event_name: "Stop", stop_hook_active: false }, { JVC_WORKSPACE: ws });
  assert.equal(r.status, 0);
  assert.notEqual(r.json?.decision, "block");
  const msg = r.json.systemMessage;
  assert.match(msg, /CMP\.0012/); assert.match(msg, /MSG\.s5\.0001/); assert.doesNotMatch(msg, /MSG\.s5\.0002/);
  assert.match(msg, /L\.ACME\.ADM\.DEC\.0518/); assert.match(msg, /browser.*sconosciuto/i);
  const { events, file } = auditLines(ws);
  const ev = events.find((e) => e.actor === "hook:stop-integrity");
  assert.ok(ev);
  assert.equal(ev.payload.browser, "unknown");
  assert.equal(verifyChain(file).ok, true);
  const t = runHook("stop-integrity", { session_id: "s5", cwd: ws }, { JVC_WORKSPACE: ws, JVC_TEST_THROW: "1" });
  assert.equal(t.status, 0);
  assert.notEqual(t.json?.decision, "block");
});

// ---------- audit-append ----------

test("audit-append: evento §46.7 con hash concatenato; payload senza contenuto dei file, riassunto ≤ 500 caratteri", () => {
  const ws = mkWs();
  seedSession(ws, { sid: "s6" });
  const base = { session_id: "s6", cwd: ws, hook_event_name: "PostToolUse" };
  const big = "SEGRETO-DEL-FILE ".repeat(500);
  const calls = [
    { tool_name: "Write", tool_input: { file_path: join(ws, "customers/ACME/lessons/x.md"), content: big }, tool_response: { success: true } },
    { tool_name: "Read", tool_input: { file_path: join(ws, "customers/ACME/lessons/x.md") }, tool_response: { file: { content: big } } },
    { tool_name: "Bash", tool_input: { command: `node scripts/kb/kb.mjs find --scope CAT ${"x".repeat(900)}` } },
    { tool_name: "Edit", tool_input: { file_path: "a.md", old_string: big, new_string: big } },
  ];
  for (const c of calls) {
    const r = runHook("audit-append", { ...base, ...c }, { JVC_WORKSPACE: ws });
    assert.equal(r.status, 0, r.stderr);
  }
  const { file, events } = auditLines(ws);
  assert.equal(events.length, 4);
  assert.equal(events[0].prev_hash, "0".repeat(64));
  for (let i = 1; i < events.length; i++) assert.equal(events[i].prev_hash, events[i - 1].hash);
  for (const e of events) {
    assert.equal(e.kind, "tool"); assert.equal(e.customer, "ACME"); assert.equal(e.scope, "CAT"); assert.equal(e.session, "s6");
    assert.ok(e.payload.input_summary.length <= 500);
    assert.doesNotMatch(JSON.stringify(e), /SEGRETO-DEL-FILE/, "mai il contenuto dei file");
  }
  assert.equal(events[0].payload.tool, "Write");
  assert.equal(verifyChain(file).ok, true);
});

test("audit-append: verifyChain rileva manomissione, riga cancellata e riga inserita", () => {
  const ws = mkWs();
  seedSession(ws, { sid: "s7" });
  for (let i = 0; i < 4; i++) auditHandle({ session_id: "s7", cwd: ws, tool_name: "Read", tool_input: { file_path: `f${i}` } }, { JVC_WORKSPACE: ws });
  const { file } = auditLines(ws);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(verifyChain(file).ok, true);
  assert.match(lines[1], /f1/);
  const tampered = lines.map((l, i) => (i === 1 ? l.replace("f1", "fX") : l));
  writeFileSync(file, tampered.join("\n") + "\n");
  assert.deepEqual([verifyChain(file).ok, verifyChain(file).broken_at], [false, 2]);
  writeFileSync(file, [lines[0], lines[2], lines[3]].join("\n") + "\n");
  assert.equal(verifyChain(file).ok, false);
  writeFileSync(file, [lines[0], lines[1], lines[1], lines[2]].join("\n") + "\n");
  assert.equal(verifyChain(file).ok, false);
});

test("audit-append: senza cliente scrive in .jvc/audit/; redazione di segreti e variabili d'ambiente note", () => {
  const ws = mkWs();
  seedSession(ws, { sid: "s8", customer: null });
  const r = runHook("audit-append", {
    session_id: "s8", cwd: ws, tool_name: "Bash",
    tool_input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop123' https://user:pw12345@host/x?token=zzzzzz; echo supersegretissimo" },
  }, { JVC_WORKSPACE: ws, XRAY_CLIENT_SECRET: "supersegretissimo" });
  assert.equal(r.status, 0, r.stderr);
  const { events, file } = auditLines(ws, null);
  assert.equal(events.length, 1);
  const s = events[0].payload.input_summary;
  assert.doesNotMatch(s, /abcdefghijklmnop123|pw12345|zzzzzz|supersegretissimo/);
  assert.equal(events[0].customer, null);
  assert.equal(verifyChain(file).ok, true);
  assert.match(redact("password=hunter22 e mail mario.rossi@example.com"), /password=\*\*\*/);
  assert.doesNotMatch(redact("mail mario.rossi@example.com"), /mario\.rossi@example\.com/);
});

test("audit-append: summarizeInput per Agent riporta subagent_type, model e task_id, non il prompt", () => {
  const s = summarizeInput("Agent", { subagent_type: "scope-expert", model: "sonnet", description: "d", prompt: "```yaml\ntask_id: MSG.x.0001\n```\nTESTO LUNGHISSIMO DEL PROMPT" });
  assert.match(s, /scope-expert/); assert.match(s, /MSG\.x\.0001/); assert.doesNotMatch(s, /TESTO LUNGHISSIMO/);
});

test("audit-append: < 100 ms in-process per evento; processo completo misurato; eccezione → avviso, exit 0 (fail-open)", () => {
  const ws = mkWs();
  seedSession(ws, { sid: "s9" });
  const input = { session_id: "s9", cwd: ws, tool_name: "Read", tool_input: { file_path: "x" } };
  auditHandle(input, { JVC_WORKSPACE: ws }); // riscaldamento
  const times = [];
  for (let i = 0; i < 20; i++) { const t0 = performance.now(); auditHandle(input, { JVC_WORKSPACE: ws }); times.push(performance.now() - t0); }
  const max = Math.max(...times);
  console.log(`audit-append in-process: max ${max.toFixed(2)} ms, media ${(times.reduce((a, b) => a + b) / times.length).toFixed(2)} ms`);
  assert.ok(max < 100, `in-process ${max} ms`);
  const r = runHook("audit-append", input, { JVC_WORKSPACE: ws });
  console.log(`audit-append processo completo (avvio di node incluso): ${r.ms.toFixed(0)} ms`);
  const t = runHook("audit-append", input, { JVC_WORKSPACE: ws, JVC_TEST_THROW: "1" });
  assert.equal(t.status, 0);
  assert.match(t.json.systemMessage, /avviso/);
  assert.equal(verifyChain(auditLines(ws).file).ok, true);
});

test("audit-append: 12 processi in parallelo mantengono la catena valida (lock)", async () => {
  const ws = mkWs();
  seedSession(ws, { sid: "p1" });
  const one = (i) => new Promise((res) => {
    const c = spawn(process.execPath, [hookScript("audit-append")], { env: cleanEnv({ JVC_WORKSPACE: ws }) });
    c.on("exit", res);
    c.stdin.end(JSON.stringify({ session_id: "p1", cwd: ws, tool_name: "Read", tool_input: { file_path: `f${i}` } }));
  });
  await Promise.all(Array.from({ length: 12 }, (_, i) => one(i)));
  const { file, events } = auditLines(ws);
  assert.equal(events.length, 12);
  assert.equal(verifyChain(file).ok, true, JSON.stringify(verifyChain(file)));
});

test("audit-append: un evento perso per errore è registrato al riavvio (session-context)", () => {
  const ws = mkWs();
  seedSession(ws, { sid: "m1" });
  // Catena corrotta → l'append fallisce → evento in .jvc/audit-missed.jsonl
  const dir = join(ws, "customers/ACME/audit");
  mkdirSync(dir, { recursive: true });
  const ym = new Date().toISOString().slice(0, 7);
  writeFileSync(join(dir, `${ym}.jsonl`), "riga corrotta\n");
  const r = runHook("audit-append", { session_id: "m1", cwd: ws, tool_name: "Read", tool_input: { file_path: "y" } }, { JVC_WORKSPACE: ws });
  assert.equal(r.status, 0);
  assert.ok(existsSync(join(ws, ".jvc/audit-missed.jsonl")));
  writeFileSync(join(dir, `${ym}.jsonl`), ""); // ripristino del file (es. da backup)
  runHook("session-context", { session_id: "m1", source: "startup", cwd: ws }, { JVC_WORKSPACE: ws });
  const { events } = auditLines(ws);
  assert.ok(events.some((e) => e.payload.recovered === true && /Read/.test(JSON.stringify(e.payload))));
  assert.equal(existsSync(join(ws, ".jvc/audit-missed.jsonl")), false);
});
