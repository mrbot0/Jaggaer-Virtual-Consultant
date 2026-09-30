import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { validateItem } from "../../scripts/kb/validate-schema.mjs";

const load = (f) => YAML.parse(readFileSync(new URL(`../fixtures/items/${f}`, import.meta.url), "utf8"));

test("un item con tutte le faccette valida", () => {
  assert.equal(validateItem(load("valid.flw.yaml")).ok, true);
});

test("una faccetta mancante rende l'item invalido (F10)", () => {
  const r = validateItem(load("missing-facet.flw.yaml"));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("F10")));
});

test("classification: campi a vocabolario chiuso, opzionali", () => {
  const it = load("valid.flw.yaml");
  assert.equal(validateItem({ ...it, classification: { cfg_area: "005", functional_section: "contabilita" } }).ok, true);
  const bad = validateItem({ ...it, classification: { cfg_area: "021" } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("classification")));
  assert.equal(validateItem({ ...it, classification: { area_cfg: "005" } }).ok, false);   // campo non dichiarato
});

test("un summary oltre 60 parole è rifiutato", () => {
  const it = load("valid.flw.yaml");
  it.summary = Array(61).fill("parola").join(" ");
  assert.equal(validateItem(it).ok, false);
});
