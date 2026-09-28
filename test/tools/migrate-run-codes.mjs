// Migrazione una tantum dei nomi di run dei test alla forma completa RUN.<C>.<AAAAMMDD>.<HHMM>.<S> (WP09b carry 3).
import { readFileSync, writeFileSync } from "node:fs";
const MAP = { K6: "1100", K6B: "1101", K6F: "1102", OTHER: "1103", "3A": "1104", M7: "1105", Y: "1106", B: "1107", J: "1108", G: "1109", F: "1110", Z: "1111", X: "1112", S: "1113", ONE: "1114", 1: "1115", "0001": "1116", FAKE: "1119" };
const DEMO = { "0001": "1117", "0002": "1118" };
let total = 0;
for (const f of process.argv.slice(2)) {
  const s = readFileSync(f, "utf8");
  let n = 0;
  let t = s.replace(/RUN\.DEMO\.(000[12])(?![A-Za-z0-9])/g, (m, k) => { n++; return `RUN.ACME.20260922.${DEMO[k]}.ADM`; });
  t = t.replace(/RUN\.(?:ACME\.)?(K6B|K6F|K6|OTHER|3A|M7|Y|B|J|G|F|Z|X|S|ONE|1|0001|FAKE)(?![A-Za-z0-9])(?!\.\d{4}\.)/g, (m, k) => { n++; return `RUN.ACME.20260922.${MAP[k]}.ADM`; });
  if (n) { writeFileSync(f, t); total += n; console.log(f, n); }
}
console.log("totale", total);
