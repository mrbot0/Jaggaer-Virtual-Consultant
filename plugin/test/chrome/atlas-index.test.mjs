// N1 (27/10/2026): l'indice dei SEL per etichetta normalizzata e i nomi normalizzati una volta per elemento danno lo
// STESSO risultato del confronto lineare di prima (atlasMatch, findElement, novità ed elementi visti di compareExpect).
import { test } from "node:test";
import assert from "node:assert/strict";
import { atlasMatch, atlasByCode, roleCompatible } from "../../scripts/chrome/atlas.mjs";
import { compareExpect, findElement } from "../../scripts/chrome/expect-compare.mjs";
import { normLabel, FIELD_ROLES } from "../../scripts/chrome/snapshot-parse.mjs";

// riferimenti: le implementazioni lineari di prima della correzione
function naiveMatch(atlas, el, { page = null } = {}) {
  const n = normLabel(el.name);
  if (!n) return null;
  const hits = (atlas ?? []).filter((a) => a.label && normLabel(a.label) === n && roleCompatible(a.role, el.role));
  if (!hits.length) return null;
  if (page) return hits.find((a) => a.page === page) ?? hits.find((a) => !a.page) ?? null;
  return hits[0];
}
function naiveFind(page, t) {
  if (!t?.label) return null;
  const n = normLabel(t.label);
  const els = page?.elements ?? [];
  return els.find((e) => normLabel(e.name) === n && roleCompatible(t.role, e.role)) ?? els.find((e) => normLabel(e.name) === n) ?? null;
}

let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const ROLES = ["button", "link", "textbox", "combobox", "checkbox", "dialog", "menuitem", null];
const LABELS = ["Salva", "salva ", "SALVA:", "Invia", "Àpprova", "Approva", "Fornitore *", "fornitore", "", "Note", "Importo"];
const atlas = Array.from({ length: 60 }, (_, i) => ({ code: `C.ACME.P2P.SEL.${String(i + 1).padStart(4, "0")}`, role: ROLES[rnd(ROLES.length)], label: LABELS[rnd(LABELS.length)] || null, page: rnd(3) === 0 ? "p2p/req" : rnd(2) ? "p2p/ord" : null }));
const elements = Array.from({ length: 400 }, (_, i) => ({ role: ROLES[rnd(ROLES.length - 1)], name: LABELS[rnd(LABELS.length)], ref: `e${i}` }));
const page = { url: "https://x/p2p/req", elements, messages: [], headings: [], texts: [] };

test("N1: atlasMatch con l'indice per etichetta = confronto lineare (con e senza pagina, con il nome già normalizzato)", () => {
  for (const e of elements) {
    for (const p of [null, "p2p/req", "p2p/ord", "altro"]) {
      assert.equal(atlasMatch(atlas, e, { page: p })?.code ?? null, naiveMatch(atlas, e, { page: p })?.code ?? null, `${e.name}/${e.role}/${p}`);
      assert.equal(atlasMatch(atlas, e, { page: p, norm: normLabel(e.name) })?.code ?? null, naiveMatch(atlas, e, { page: p })?.code ?? null);
    }
  }
  assert.equal(atlasMatch(null, { name: "Salva" }), null);
  // l'elenco cresciuto dopo il primo uso: l'indice si ricostruisce
  const a2 = [{ code: "X1", role: "button", label: "Altro" }];
  assert.equal(atlasMatch(a2, { name: "Nuovo", role: "button" }), null);
  a2.push({ code: "X2", role: "button", label: "Nuovo" });
  assert.equal(atlasMatch(a2, { name: "Nuovo", role: "button" })?.code, "X2");
  assert.equal(atlasByCode(atlas, atlas[5].code), atlas.find((a) => a.code === atlas[5].code));
});

test("N1: findElement e compareExpect (novità, elementi visti) = confronto lineare", () => {
  for (const l of LABELS) for (const r of ROLES) assert.equal(findElement(page, { label: l, role: r }), naiveFind(page, { label: l, role: r }));
  const res = compareExpect({ expect: { elements: ["Salva", { label: "Invia", role: "button" }] }, target: "Note" }, page, { atlas });
  const expectedLabels = new Set(["salva", "invia", "note"]);
  const novelties = elements.filter((e) => FIELD_ROLES.has(e.role) && e.name && !expectedLabels.has(normLabel(e.name)) && !naiveMatch(atlas, e)).map((e) => ({ role: e.role, label: e.name }));
  assert.deepEqual(res.novelties, novelties);
  for (const o of res.elements_seen) {
    assert.equal(o.novelty === true, novelties.some((n) => normLabel(n.label) === normLabel(o.label)), o.label);
    assert.equal(o.atlas_match, naiveMatch(atlas, { name: o.label, role: o.role })?.code ?? null);
  }
});
