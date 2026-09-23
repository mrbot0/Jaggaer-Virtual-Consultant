import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { matchGlob, intersects, subset, resolveTarget, resolvePattern, skeleton, PathPolicyError } from "../../hooks/lib/paths.mjs";
import { mkWs } from "../helpers/hook-env.mjs";

test("matchGlob: ** e * con semantica di segmento, case-insensitive", () => {
  assert.equal(matchGlob("customers/ACME/kb/scopes/CAT/flows/x.yaml", ["customers/ACME/kb/scopes/CAT/**"]), true);
  assert.equal(matchGlob("customers/ACME/kb/scopes/CAT", ["customers/ACME/kb/scopes/CAT/**"]), true, "dir/** include dir");
  assert.equal(matchGlob("customers/ACME/kb/scopes/CATALOGO/x", ["customers/ACME/kb/scopes/CAT/**"]), false);
  assert.equal(matchGlob("customers/acme/KB/scopes/cat/x", ["customers/ACME/kb/scopes/CAT/**"]), true);
  assert.equal(matchGlob("customers/ACME/tests/cases/CAT/t.yaml", ["customers/ACME/tests/**/CAT/**"]), true);
  assert.equal(matchGlob("customers/ACME/tests/CAT/t.yaml", ["customers/ACME/tests/**/CAT/**"]), true);
  assert.equal(matchGlob("customers/ACME/tests/cases/ADM/t.yaml", ["customers/ACME/tests/**/CAT/**"]), false);
  assert.equal(matchGlob("customers/ACME/kb/handoffs/C.ACME.XSC.HND.0004-CAT-ADM.yaml", ["customers/ACME/kb/handoffs/*CAT*"]), true);
  assert.equal(matchGlob("customers/ACME/kb/handoffs/sub/CAT.yaml", ["customers/ACME/kb/handoffs/*CAT*"]), false, "* non attraversa /");
  assert.equal(matchGlob("a/b.c", ["a/{b,x}.c"]), true);
});

test("intersects/subset fra pattern: ricerche che possono raggiungere un'area", () => {
  assert.equal(intersects("**/*.yaml", "customers/*/kb/scopes/**"), true);
  assert.equal(intersects("customers/ACME/lessons/**", "customers/*/kb/scopes/**"), false);
  assert.equal(intersects("customers/*/kb/**", "customers/*/kb/scopes/**"), true);
  assert.equal(intersects("customers/acme", "customers/*/kb/scopes/**"), false);
  assert.equal(subset("customers/ACME/kb/scopes/CAT/**/*.yaml", "customers/ACME/kb/scopes/CAT/**"), true);
  assert.equal(subset("customers/ACME/kb/scopes/*/x", "customers/ACME/kb/scopes/CAT/**"), false);
  assert.equal(subset("customers/ACME/tests/**/CAT/**", "customers/ACME/tests/**/CAT/**"), true);
  assert.equal(subset("customers/ACME/kb/**", "customers/ACME/kb/scopes/CAT/**"), false);
});

test("resolveTarget: .., separatori misti, URL-encoding, NUL, prefissi di dispositivo, punti finali", () => {
  const ws = mkWs();
  const T = (p) => [...resolveTarget(p, { cwd: ws, ws }).ws];
  assert.ok(T(join(ws, "customers/ACME/../BETA/kb")).includes("customers/beta/kb"));
  assert.ok(T("customers\\BETA\\kb\\x.yaml").includes("customers/beta/kb/x.yaml"));
  assert.ok(T("customers/ACME/..%2FBETA/kb").includes("customers/beta/kb"));
  assert.ok(T("customers/BETA./kb").includes("customers/beta/kb"));
  assert.ok(T("customers/BETA /kb").includes("customers/beta/kb"));
  assert.ok(T(`\\\\?\\${join(ws, "customers", "BETA", "kb")}`).includes("customers/beta/kb"));
  assert.throws(() => resolveTarget("customers/ACME/x\0/../../BETA", { cwd: ws, ws }), PathPolicyError);
  assert.equal(skeleton("customers/ΒETA"), "customers/BETA");
  assert.equal(skeleton("scopés"), "scopes");
});

test("resolvePattern: prefisso letterale risolto, '..' dopo un jolly rifiutato, radice antenata del workspace ⇒ **", () => {
  const ws = mkWs();
  assert.ok([...resolvePattern(join(ws, "customers/ACME"), "../BETA/**", { cwd: ws, ws }).ws].includes("customers/beta/**"));
  assert.throws(() => resolvePattern(ws, "customers/*/../BETA/**", { cwd: ws, ws }), PathPolicyError);
  assert.ok([...resolvePattern(join(ws, ".."), "**/*.yaml", { cwd: ws, ws }).ws].includes("**"));
  assert.ok([...resolvePattern(ws, "*.yaml", { cwd: ws, ws, unanchoredBasename: true }).ws].includes("**/*.yaml"));
});
