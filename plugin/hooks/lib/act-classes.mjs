// Il catalogo delle azioni (§29.4) come lo usano i guard, senza YAML sul percorso
// caldo: effetto, rischio e ammissione per colonna d'ambiente di ogni classe.
// La fonte è product/kb/actions/S.STD.XSC.ACT.00nn.yaml: un test verifica che
// questa tabella coincida con gli item (test/hooks/guard-production.test.mjs).
const row = (effect, risk, sandbox, preprod, prod) => ({ effect, risk, sandbox, preprod, prod });
export const ACT = Object.freeze({
  "ACT-OBS": row("read", "R0", "allowed", "allowed", "allowed"),
  "ACT-READ": row("read", "R0", "allowed", "allowed", "allowed"),
  "ACT-QRY": row("read", "R0", "allowed", "allowed", "allowed"),
  "ACT-CREATE": row("write", "R1", "allowed", "allowed", "never"),
  "ACT-UPDATE": row("write", "R1", "allowed", "allowed", "never"),
  "ACT-UPLOAD": row("write", "R1/R2", "allowed", "allowed", "never"),
  "ACT-SUBMIT": row("write", "R2", "allowed", "allowed", "never"),
  "ACT-APPROVE": row("write", "R2", "allowed", "referent", "never"),
  "ACT-TRANSMIT": row("write", "R2", "allowed", "referent", "never"),
  "ACT-CLOSE": row("write", "R1/R2", "allowed", "allowed", "never"),
  "ACT-PUBLISH": row("write", "R2", "allowed", "referent", "never"),
  "ACT-CFG-READ": row("read", "R0", "allowed", "allowed", "allowed"),
  "ACT-CFG-CHANGE": row("config", "R2/R3", "approval", "approval", "3A"),
  "ACT-BULK": row("write", "R3", "approval", "never", "never"),
  "ACT-DELETE": row("write", null, "never", "never", "never"),
});
export const envColumn = (type) => (type === "prod" ? "prod" : type === "preprod" ? "preprod" : "sandbox");

// DT-007: outcome_annotations R0/R1 verde · R2 giallo · R3 rosso (decision-tables/DT-007.yaml).
export const RISK_LEVEL = Object.freeze({ R0: "verde", R1: "verde", R2: "giallo", R3: "rosso" });
const LEVEL_RANK = { verde: 0, giallo: 1, rosso: 2 };
// Livello di perimetro di un passo: il più restrittivo fra config.level e il
// livello del rischio del passo; nessuno dei due ⇒ rosso (fail-closed).
export function stepLevel(step) {
  const cands = [step?.config?.level, RISK_LEVEL[step?.risk]].filter((l) => l in LEVEL_RANK);
  if (!cands.length) return "rosso";
  return cands.reduce((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a));
}
// Rischio effettivo di un passo: il suo `risk`, altrimenti il massimo della classe.
export function stepRisk(step, cls = ACT[step?.action_class]) {
  if (/^R[0-3]$/.test(step?.risk ?? "")) return step.risk;
  return String(cls?.risk ?? "R3").split("/").pop();
}
