import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { judgeAdmission } from "../../../scripts/kb/cluster.mjs";

const CLUSTERS = fileURLToPath(new URL("../../../clusters", import.meta.url));
const { cases } = YAML.parse(readFileSync(new URL("./cases.yaml", import.meta.url), "utf8"));
const cluster = (code) => {
  const family = code.replace(/-\d{3}$/, "");
  return YAML.parse(readFileSync(join(CLUSTERS, family, `${code}.yaml`), "utf8"));
};

test("golden eval del validatore: 10 item con verdetto e regola attesi → 10/10, deterministico", () => {
  assert.equal(cases.length, 10);
  let hits = 0;
  const first = [];
  for (const k of cases) {
    const r = judgeAdmission(cluster(k.cluster), k.item);
    first.push(JSON.stringify([r.verdict, r.rule, r.dt.score]));
    assert.equal(r.verdict, k.verdict, `${k.name}: verdetto`);
    assert.equal(r.rule, k.rule, `${k.name}: regola`);
    hits++;
  }
  assert.equal(hits, 10);
  // stessa esecuzione, stesso risultato
  for (let run = 0; run < 10; run++) {
    cases.forEach((k, i) => {
      const r = judgeAdmission(cluster(k.cluster), structuredClone(k.item));
      assert.equal(JSON.stringify([r.verdict, r.rule, r.dt.score]), first[i]);
    });
  }
});
