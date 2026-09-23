// Parser deontico lessicale it/en (§19.10) — estrazione T0 delle regole di
// obbligatorietà e di vincolo, per le unità `regola` e per il testo di
// obbligatorietà delle righe-campo (scripts/ingest/field-table.mjs).
//
// Interfaccia (stabile, usata da scripts/kb/digest-fields.mjs e, in WP09a,
// dall'estrattore generale delle unità):
//
//   parseRule(text, { lang? }) → {
//     text, lang,                              lang rilevata se non data ("it" | "en")
//     modality,                                una di MODALITIES
//     mandatory?: { kind, when?, in_states?, by_role?, unless? },
//     validation?: { on_fail: "block" | "warn" },
//     reason?: { kind: "integration" },        vincolo esterno
//     scope_qualifiers: { companies[], roles[], states[], categories[] },
//     condition,                               protasi ("se …", "if …") o null
//     exception,                               ramo "salvo/eccetto/tranne …" o null
//     consequence,                             dove va la regola (tabella di §19.10, colonna "Diventa")
//     confidence,                              0..1
//     residue?: "ambiguous",                   modalità non determinata → revisione (§19.15)
//     signals[]                                segnali lessicali riconosciuti
//   }
//
// Regole fisse (Review Focus 5 e §19.10):
//   · una raccomandazione ("si consiglia", "consigliamo", "raccomandiamo", "andrebbe",
//     "dovrebbe", should, advised, encouraged, recommend…) non produce MAI un mandatory,
//     anche con parole di obbligo nella frase: il lessico si cerca nell'INTERA frase,
//     protasi, eccezione e concessive comprese;
//   · le concessive ("anche se", "even if") non sono condizioni; una condizione
//     indeterminata ("se non diversamente configurato", "unless otherwise…") → ambiguo;
//   · raccomandazione + eccezione ("dovrebbe essere obbligatorio salvo…"), doppia
//     negazione, obbligo possibile ("potrebbe essere obbligatorio") e obbligo +
//     facoltà in contrasto → `ambiguo`, nessun mandatory, residue `ambiguous`;
//   · nessun segnale deontico → `ambiguo` (una modalità non determinata non produce
//     mai un mandatory.kind);
//   · obbligo + condizione (protasi, "per la società X", "per il ruolo Y", "nello
//     stato Z", eccezione) → `obbligo-condizionale`, kind conditional; l'eccezione
//     di un obbligo è anche un `when` negato: NOT (<eccezione>);
//   · "non può essere lasciato vuoto" / "cannot be left empty" = obbligo.
// Ordine dei controlli sulla proposizione principale (protasi ed eccezione tolte):
// doppia negazione · obbligo possibile · raccomandazione · immutabilità ·
// comportamento del sistema · non bloccante · vincolo esterno · divieto ·
// obbligo negato (= facoltà) · obbligo · facoltà · nessun segnale.
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";

export const MODALITIES = ["obbligo", "obbligo-condizionale", "divieto", "facolta", "raccomandazione", "comportamento-sistema",
  "non-bloccante", "immutabilita", "vincolo-esterno", "ambiguo"];

const CONSEQUENCE = {
  "obbligo": "FLD.mandatory", "obbligo-condizionale": "FLD.mandatory", "facolta": "FLD.mandatory", "divieto": "INV",
  "raccomandazione": "FLD.notes", "comportamento-sistema": "FLD.validation", "non-bloccante": "FLD.validation",
  "immutabilita": "LCY.immutable_fields_after", "vincolo-esterno": "KEY.cross_system", "ambiguo": "residue",
};

// \b consapevole di Unicode: il \b di JS è ASCII e non vede "è", "à", "ù" come lettere.
const WB = "(?:(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])|(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_]))";
const rx = (src, flags = "") => new RegExp(src.replace(/\\b/g, WB), `u${flags}`);
const set = (list) => list.map((s) => rx(s));
const hit = (patterns, s) => patterns.find((p) => p.test(s));

const LEX = {
  doubleNeg: set([
    "\\bnon è vero che\\b.*\\bnon\\b", "\\bnon è escluso che\\b", "\\bnon è detto che\\b.*\\bnon\\b", "\\bnon si può escludere che\\b",
    "\\bnon (?:può|possono|deve|devono) non\\b", "\\bnon è non\\b", "\\bnon è da escludere\\b",
    "\\bit is not (?:true|the case) that\\b.*\\bnot\\b", "\\bnot untrue\\b", "\\bcannot not\\b", "\\bcan not not\\b", "\\bmust not not\\b",
    "\\bit is not excluded that\\b", "\\bnot non-", "\\bit cannot be ruled out that\\b",
  ]),
  possibleOblig: set([
    "\\b(?:può|possono|potrebbe|potrebbero|potrà) essere (?:obbligatori|richiest|necessari)",
    "\\b(?:may|might|could|can) be (?:mandatory|required|compulsory)\\b",
  ]),
  rec: set([
    "\\bsi consiglia\\b", "\\bè consigliat[oa]\\b", "\\bconsigliabile\\b", "\\bè preferibile\\b", "\\bdi norma\\b", "\\bdovrebbe\\b", "\\bdovrebbero\\b",
    "\\bsi raccomanda\\b", "\\bè raccomandat[oa]\\b", "\\bè opportuno\\b", "\\bsarebbe (?:meglio|opportuno|bene|preferibile)\\b",
    "\\bpreferibilmente\\b", "\\bsi suggerisce\\b", "\\bè suggerit[oa]\\b", "\\bè buona (?:norma|pratica)\\b",
    "\\bshould\\b", "\\brecommended\\b", "\\brecommend\\b", "\\badvisable\\b", "\\bpreferably\\b", "\\bideally\\b", "\\bas a rule\\b",
    "\\bbest practice\\b", "\\bit is preferable\\b", "\\bought to\\b", "\\bsuggested\\b",
    // giri di correzione 1-2: le forme VERBALI e AGGETTIVALI di consigliare/raccomandare/suggerire e di
    // advise/encourage/suggest/recommend — non i nomi: «raccomandata» (posta) e «raccomandate» sono
    // participi solo dopo copula, avverbio o parentesi («è raccomandata», «(raccomandata)»); «Consiglio»
    // (organo), «consigli», «suggerimenti», advisory/advisor, recommendation(s), suggestion(s) non contano.
    "\\bconsigli(?:a|amo|ano|ate|avo|ava|avano|ato|ata|ati|ate|abile|abili|ando|erei|eremmo|erebbe|erebbero|erà|eranno)\\b",
    "\\braccomand(?:o|iamo|ano|ava|avano|ato|ati|abile|abili|ando|erei|eremmo|erebbe|erebbero|erà|eranno)\\b",
    "\\b(?:è|sono|viene|vengono|risulta|risultano|resta|restano|fortemente|vivamente|caldamente|particolarmente|molto)\\s+raccomandat[ae]\\b",
    "\\(\\s*(?:raccomandat|consigliat)[oaie]\\s*\\)",
    "\\bsuggerisc(?:o|e|ono)\\b", "\\bsuggeri(?:amo|te|re|rei|remmo|rebbe|rebbero|to|ta|ti|te|va|vano)\\b",
    "\\bandrebber?o?\\b", "\\bsarebbe(?:ro)? da\\b", "\\bsarebbe (?:utile|consigliabile)\\b",
    "\\badvis(?:e|es|ed|ing|able)\\b", "\\bencourag(?:e|es|ed|ing)\\b", "\\bsuggest(?:s|ed|ing)?\\b", "\\brecommend(?:s|ed|ing)?\\b",
  ]),
  immut: set([
    "\\bpiù (?:essere )?modific", "\\bpiù possibile modific", "\\b(?:di )?sola lettura\\b", "\\bimmutabil", "\\bcongelat", "\\bnon più editabil",
    "\\bno longer (?:be )?(?:editable|edited|changed|modified|modifiable|changeable)\\b", "\\bno longer possible to (?:change|modify|edit)\\b",
    "\\bread-only\\b", "\\bimmutable\\b", "\\bfrozen\\b", "\\bcannot be (?:changed|modified|edited) (?:after|once)\\b", "\\bis locked after\\b",
  ]),
  system: set([
    "\\bil sistema (?:impedisce|blocca|non consente|non permette|rifiuta|non accetta)\\b", "\\bviene bloccat[oa]\\b", "\\bvengono bloccat[ie]\\b",
    "\\bnon è salvabile\\b", "\\bnon (?:è|sarà) possibile (?:salvare|inviare)\\b", "\\bnon si può salvare\\b",
    "\\bil salvataggio (?:viene|è) (?:bloccato|impedito|rifiutato)\\b", "\\bnon (?:può|possono) essere (?:salvat|inviat)",
    "\\bviene rifiutat[oa]\\b", "\\bviene impedit[oa]\\b", "\\bnon consente di (?:salvare|inviare|procedere)\\b",
    "\\bthe system (?:prevents|blocks|rejects|refuses|does not allow|doesn't allow|will not allow|won't allow|stops)\\b",
    "\\b(?:is|are) blocked\\b", "\\bcan(?:not|'t| not) be (?:saved|submitted|sent)\\b", "\\b(?:saving|submission|sending) is (?:blocked|prevented|rejected)\\b",
    "\\bis rejected\\b", "\\bwill not be saved\\b", "\\bprevents saving\\b",
  ]),
  warn: set([
    "\\bviene segnalat[oa]\\b", "\\bvengono segnalat[ie]\\b", "\\b(?:compare|appare) un (?:avviso|messaggio di avviso|warning)\\b",
    "\\bviene (?:mostrato|visualizzato) un (?:avviso|messaggio di avviso|warning)\\b", "\\bil sistema (?:avvisa|segnala)\\b", "\\bnon bloccante\\b",
    "\\bsenza bloccare\\b",
    "\\b(?:is|are) flagged\\b", "\\ba warning (?:is (?:shown|displayed|raised|issued)|appears)\\b", "\\bwarning message (?:is shown|appears|is displayed)\\b",
    "\\bthe system (?:warns|flags|displays a warning|shows a warning)\\b", "\\bnon-blocking\\b", "\\bwithout blocking\\b",
  ]),
  external: set([
    "\\bdev(?:e|ono) corrispondere a", "\\bdev(?:e|ono) esistere (?:in|nel|nella|nell'|negli|nei)", "\\bdev(?:e|ono) coincidere con\\b",
    "\\bcodice del gestionale\\b", "\\bcodice (?:dell'|dell )?erp\\b", "\\bdev(?:e|ono) essere (?:presente|presenti) (?:in|nel|nella|nell')",
    "\\bdeve essere un codice valido (?:del|di|in|nel|dell')", "\\bdev(?:e|ono) essere censit[oaie] (?:in|nel|nella|nell')",
    "\\bmust match\\b", "\\bmust exist in\\b", "\\bmust correspond to\\b", "\\bmust coincide with\\b",
    "\\bmust be (?:present|defined|registered) in (?:the )?(?:erp|sap|master|vendor master)", "\\berp code\\b", "\\bcode from the erp\\b",
    "\\bmust be a valid (?:erp|sap)\\b",
  ]),
  prohib: set([
    "\\bnon dev(?:e|ono)\\b", "\\bnon (?:può|possono)\\b", "\\bnon (?:è|sono) consentit[oaie]\\b", "\\b(?:è|sono) vietat[oaie]\\b",
    "\\bnon (?:è|sono) ammess[oaie]\\b", "\\bnon (?:è|sono) permess[oaie]\\b", "\\bnon si può\\b", "\\bnon va\\b", "\\bnon vanno\\b",
    "\\bmust not\\b", "\\bmustn't\\b", "\\bcannot\\b", "\\bcan not\\b", "\\bcan't\\b", "\\bmay not\\b", "\\bshall not\\b",
    "\\b(?:is|are) not (?:allowed|permitted)\\b", "\\b(?:is|are) (?:prohibited|forbidden)\\b",
  ]),
  empty: set(["\\bvuot[oaie]\\b", "\\bin bianco\\b", "\\bomess[oaie]\\b", "\\bempty\\b", "\\bblank\\b", "\\bomitted\\b"]),
  notRequired: set([
    "\\bnon (?:è|sono) (?:obbligatori[oaie]?|richiest[oaie]|necessari[oaie]?)\\b", "\\bnon occorre\\b", "\\bnon serve\\b",
    "\\b(?:is|are) not (?:mandatory|required|compulsory|necessary)\\b", "\\b(?:isn't|aren't) (?:mandatory|required)\\b", "\\bnot required\\b",
    "\\bno need to\\b", "\\b(?:does|do) not need to\\b", "\\b(?:doesn't|don't) need to\\b",
  ]),
  oblig: set([
    "\\bdev(?:e|ono)\\b", "\\bobbligatori[oaie]?\\b", "\\b(?:è|sono) richiest[oaie]\\b", "\\bva(?:nno)? (?:inserit|compilat|indicat|valorizzat|specificat|selezionat)",
    "\\boccorre\\b", "\\b(?:è|sono) necessari[oaie]?\\b", "\\bè indispensabile\\b", "\\bè tenut[oa] a\\b",
    "\\bmust\\b", "\\brequired\\b", "\\bmandatory\\b", "\\bshall\\b", "\\bha(?:s|ve) to\\b", "\\bneeds? to\\b", "\\bcompulsory\\b", "\\bis necessary\\b",
  ]),
  optionalStrong: set([
    "\\b(?:può|possono) essere (?:lasciat[oaie] vuot|omess)", "\\bfacoltativ", "\\bopzional",
    "\\b(?:may|can) be (?:left (?:empty|blank)|omitted|skipped)\\b", "\\boptional\\b",
  ]),
  faculty: set([
    "\\b(?:può|possono)\\b", "\\bè possibile\\b", "\\bfacoltativ[oaie]\\b", "\\bopzional[ei]\\b", "\\bè consentit[oa]\\b", "\\bè permess[oa]\\b",
    "\\bsi può\\b", "\\bè ammess[oa]\\b", "\\ba discrezione\\b",
    "\\bmay\\b", "\\boptional(?:ly)?\\b", "\\bcan\\b", "\\bis possible\\b", "\\bis (?:allowed|permitted)\\b", "\\bat the discretion\\b",
  ]),
};

// Protasi ed eccezioni: marcatori, dal più lungo al più corto.
const PROTASIS = ["nel caso in cui", "nel caso di", "in caso di", "qualora", "laddove", "quando", "una volta", "se",
  "in the event of", "in case of", "provided that", "whenever", "when", "where", "once", "if"];
const PROTASIS_TRAILING = PROTASIS.filter((m) => !["where", "una volta"].includes(m));
const EXCEPTION = ["salvo nel caso in cui", "salvo che per", "salvo che", "salvo se", "salvo per", "salvo quando", "salvo",
  "eccetto che per", "eccetto che", "eccetto per", "eccetto quando", "eccetto",
  "tranne che per", "tranne che", "tranne quando", "tranne per", "tranne se", "tranne",
  "ad eccezione dello", "ad eccezione della", "ad eccezione degli", "ad eccezione delle", "ad eccezione dei", "ad eccezione del", "ad eccezione di", "ad eccezione",
  "fatta eccezione per", "a meno che non", "a meno che",
  "with the exception of", "except for", "except when", "except where", "except if", "except in", "except", "unless", "other than",
  "excluding", "save for", "apart from"];
const alt = (list) => list.map((m) => m.replace(/ /g, "\\s+")).join("|");
const RX_EXC_LEAD = rx(`^(?:${alt(EXCEPTION)})\\b\\s*([^,]*?),\\s*(.+)$`, "i");
const RX_EXC_ANY = rx(`(?:,\\s*|\\s)(?:${alt(EXCEPTION)})\\b\\s*(.*)$`, "i");
const RX_PROT_CLAUSE = rx(`(^|,\\s*)(?:${alt(PROTASIS)})\\b\\s+([^,]+?),\\s*`, "i");
const RX_PROT_TRAIL = rx(`\\s(?:${alt(PROTASIS_TRAILING)})\\b\\s+(.+)$`, "i");
// Concessive ("anche se", "even if"): non sono condizioni, l'obbligo vale comunque. Il loro testo resta
// nella scansione delle raccomandazioni, che guarda l'intera frase.
const CONCESSIVE = "anche se|anche quando|anche qualora|pur se|sebbene|benché|nonostante|even if|even though|even when|although|though";
const RX_CONCESSIVE_LEAD = rx(`^(?:${CONCESSIVE})\\b[^,]*,\\s*`, "i");
const RX_CONCESSIVE_TRAIL = rx(`(?:,\\s*|\\s)(?:${CONCESSIVE})\\b.*$`, "i");
// Condizione indeterminata ("se non diversamente configurato", "salvo ove diversamente indicato",
// "unless otherwise…", "if not otherwise…"): il ramo non è verificabile, la regola va in residuo.
const RX_VAGUE_CONDITION = rx([
  "\\b(?:se|qualora|ove|dove|laddove|salvo(?: che| ove| dove| se)?|tranne(?: che| ove| dove)?|eccetto(?: che| ove| dove)?|a meno che)\\s+(?:non\\s+)?(?:(?:sia|venga|è)\\s+)?(?:(?:indicato|specificato|configurato|previsto|stabilito|disposto)\\s+)?(?:diversamente|altrimenti)\\b",
  "\\bsalvo divers[aoie]\\b",
  "\\b(?:unless|except|if not|where not|save|other than)\\s+(?:(?:as|where|when)\\s+)?(?:(?:stated|specified|configured|indicated|noted|agreed|provided)\\s+)?otherwise\\b",
  "\\bunless (?:specified|stated|configured|indicated) otherwise\\b",
].join("|"), "i");
const RX_ONLY_NEGATION = /^(?:non|not|no|ne)$/iu;

const RX_ELSE = rx("(?:[,;]\\s*|\\s)(?:altrimenti|in caso contrario|diversamente|otherwise|else)\\b.*$", "i");

// Stati espressi a parole ("in approvazione", "during approval") → codice di stato.
const NATURAL_STATES = [
  [rx("\\bin (?:fase di )?bozza\\b|\\bin draft\\b"), "DRAFT"],
  [rx("\\bin (?:fase di )?approvazione\\b|\\b(?:during|in|for) approval\\b|\\bpending approval\\b"), "PENDING_APPROVAL"],
  [rx("\\ball'invio\\b|\\bal momento dell'invio\\b|\\b(?:on|at|upon) submission\\b"), "SUBMITTED"],
];
// Eccezione indeterminata: il ramo unless non è una condizione verificabile.
const VAGUE_EXCEPTION = rx("^(?:eccezioni|(?:i )?casi (?:particolari|eccezionali|specifici)|diversa (?:indicazione|configurazione|disposizione|impostazione)(?: .*)?|diversamente (?:indicato|specificato|configurato)|otherwise (?:specified|stated|configured|indicated|noted)|(?:in )?special cases|exceptions|exceptional cases|…|\\.*)$", "i");
export const isVagueException = (e) => e !== null && e !== undefined && VAGUE_EXCEPTION.test(String(e).trim());

const clean = (s) => String(s ?? "").replace(/[\s,;:.]+$/u, "").replace(/^[\s,;:]+/u, "").trim();

function normalize(text) {
  return String(text ?? "").replace(/[’`´]/g, "'").replace(/\s+/g, " ").replace(/\b([EeÈè])'(?=\s)/g, "è").trim();
}

export function detectLang(text) {
  const t = ` ${String(text).toLowerCase()} `;
  const it = [" il ", " la ", " lo ", " le ", " gli ", " di ", " è ", " deve ", " non ", " che ", " per ", " campo ", " della ", " del ", " sono "]
    .filter((w) => t.includes(w)).length;
  const en = [" the ", " is ", " are ", " must ", " be ", " of ", " field ", " to ", " not ", " for ", " should ", " may ", " can "]
    .filter((w) => t.includes(w)).length;
  return en > it ? "en" : "it";
}

// Clausola d'eccezione: "…, salvo X" / "Salvo X, …". Restituisce { main, exception|null }.
function splitException(s) {
  let m = RX_EXC_LEAD.exec(s);
  if (m) return { main: m[2], exception: clean(m[1]) };
  m = RX_EXC_ANY.exec(s);
  if (m) return { main: s.slice(0, m.index), exception: clean(m[1]) };
  return { main: s, exception: null };
}

// Protasi: "Se X, …" / "…, se X, …" / "… se X". Restituisce { main, condition|null }.
function splitProtasis(s) {
  let m = RX_PROT_CLAUSE.exec(s);
  if (m) return { main: `${s.slice(0, m.index)}${m[1] ? ", " : ""}${s.slice(m.index + m[0].length)}`, condition: clean(m[2]) };
  m = RX_PROT_TRAIL.exec(s);
  if (m) return { main: s.slice(0, m.index), condition: clean(m[1]) };
  return { main: s, condition: null };
}

// Elenco di codici dopo un marcatore: "IT01", "IT01 e IT02", "BUYER, APPROVER and REQUESTER".
const TOKEN = /^[A-Z0-9][A-Z0-9_-]*[A-Z0-9_]$/u;
function readCodes(orig, from) {
  const rest = orig.slice(from);
  const parts = rest.split(/(\s*,\s*|\s+(?:e|ed|o|and|or)\s+|\s+)/u);
  const out = [];
  let expectToken = true;
  for (const p of parts) {
    if (p === undefined || p === "") continue;
    if (expectToken) {
      const tok = p.replace(/[.;:)]+$/u, "");
      if (!TOKEN.test(tok) || !/[A-Z]|\d/.test(tok)) break;
      out.push(tok);
      if (tok !== p) break;   // punteggiatura finale: l'elenco finisce qui
      expectToken = false;
    } else {
      if (/^(\s*,\s*|\s+(?:e|ed|o|and|or)\s+)$/u.test(p)) expectToken = true;
      else break;
    }
  }
  return out;
}

function qualifiers(orig) {
  const low = orig.toLowerCase();
  const q = { companies: [], roles: [], states: [], categories: [] };
  const grab = (key, markers) => {
    for (const src of markers) {
      const r = rx(src, "g");
      let m;
      while ((m = r.exec(low))) for (const c of readCodes(orig, m.index + m[0].length)) if (!q[key].includes(c)) q[key].push(c);
    }
  };
  grab("companies", ["\\bper (?:la |le )?societ[àa]\\s+", "\\bfor (?:the )?compan(?:y|ies)\\s+"]);
  grab("categories", ["\\bper (?:la |le )?categori[ae]\\s+", "\\bfor (?:the )?categor(?:y|ies)\\s+"]);
  grab("roles", ["\\bper (?:il |i )?ruol[oi]\\s+", "\\bfor (?:the )?roles?\\s+"]);
  grab("states", ["\\b(?:nello|negli|nell'|in)\\s*stat[oi]\\s+", "\\bin (?:the )?states?\\s+"]);
  // "for the BUYER role", "in the APPROVED state": il codice precede il nome
  const inv = (re, key) => { let m; const r = new RegExp(re, "gu"); while ((m = r.exec(orig))) for (const c of m[1].split(/\s*,\s*|\s+(?:and|or)\s+/u)) if (!q[key].includes(c)) q[key].push(c); };
  inv("\\b[Ff]or the ([A-Z][A-Z0-9_]+(?:(?:\\s*,\\s*|\\s+(?:and|or)\\s+)[A-Z][A-Z0-9_]+)*) roles?\\b", "roles");
  // stati in linguaggio naturale (vocabolario degli stati del documento JAGGAER)
  for (const [re, st] of NATURAL_STATES) if (re.test(low) && !q.states.includes(st)) q.states.push(st);
  inv("\\b[Ii]n the ([A-Z][A-Z0-9_]+(?:(?:\\s*,\\s*|\\s+(?:and|or)\\s+)[A-Z][A-Z0-9_]+)*) states?\\b", "states");
  return q;
}

function buildWhen({ condition, q, exception }) {
  const parts = [];
  if (condition) parts.push(condition);
  if (q.companies.length) parts.push(`document.company IN (${q.companies.join(", ")})`);
  if (q.categories.length) parts.push(`document.category IN (${q.categories.join(", ")})`);
  if (exception !== null && exception !== undefined && exception !== "") parts.push(`NOT (${exception})`);
  return parts.length ? parts.join(" AND ") : null;
}

function ruleFor(kind, { condition, q, exception }) {
  const m = { kind };
  const when = buildWhen({ condition, q, exception: kind === "never" ? null : exception });
  if (when) m.when = when;
  if (q.states.length) m.in_states = [...q.states];
  if (q.roles.length) m.by_role = [...q.roles];
  if (exception && kind !== "never") m.unless = exception;
  return m;
}

export function parseRule(text, { lang } = {}) {
  const source = normalize(text);
  const outLang = lang ?? detectLang(source);
  const signals = [];
  const base = { text: String(text ?? ""), lang: outLang };
  const fullLow = source.toLowerCase();
  // l'eccezione dell'intera frase (concessive comprese) decide «raccomandazione + eccezione → ambiguo»
  const { exception: anyException } = splitException(source.replace(RX_ELSE, ""));
  const noElse = source.replace(RX_CONCESSIVE_LEAD, "").replace(RX_CONCESSIVE_TRAIL, "").replace(RX_ELSE, "");
  const { main: m1, exception } = splitException(noElse);
  const { main, condition } = splitProtasis(m1);
  const low = main.toLowerCase();
  const q = qualifiers(main);
  const conditional = !!condition || q.companies.length + q.categories.length + q.roles.length + q.states.length > 0 || !!exception;
  const result = (modality, extra = {}, confidence = 0.9) => {
    const r = { ...base, modality, ...extra, scope_qualifiers: q, condition, exception, consequence: CONSEQUENCE[modality], confidence, signals };
    if (modality === "ambiguo") r.residue = "ambiguous";
    return r;
  };
  const ambiguous = (why) => { signals.push(why); return result("ambiguo", {}, 0.3); };
  const found = (name, list) => { const p = hit(list, low); if (p) signals.push(name); return !!p; };
  const foundAnywhere = (name, list) => { const p = hit(list, fullLow); if (p) signals.push(name); return !!p; };

  if (!source) return ambiguous("testo vuoto");
  if (found("doppia-negazione", LEX.doubleNeg)) return ambiguous("doppia negazione");
  if (found("obbligo-possibile", LEX.possibleOblig)) return ambiguous("obbligo solo possibile");
  if (RX_VAGUE_CONDITION.test(fullLow)) return ambiguous("condizione indeterminata");
  // Le raccomandazioni si cercano nell'intera frase: protasi, eccezione e concessive comprese.
  if (foundAnywhere("raccomandazione", LEX.rec)) {
    // Review Focus 5: raccomandazione + eccezione non si risolve lessicalmente.
    if (exception !== null || anyException !== null) return ambiguous("raccomandazione con eccezione");
    return result("raccomandazione", {}, 0.85);
  }
  if (found("immutabilita", LEX.immut)) return result("immutabilita", {}, 0.85);
  if (found("comportamento-sistema", LEX.system)) return result("comportamento-sistema", { validation: { on_fail: "block" } }, 0.85);
  if (found("non-bloccante", LEX.warn)) return result("non-bloccante", { validation: { on_fail: "warn" } }, 0.85);
  if (found("vincolo-esterno", LEX.external)) return result("vincolo-esterno", { reason: { kind: "integration" } }, 0.85);
  const obligation = () => {
    if (isVagueException(exception)) return ambiguous("eccezione indeterminata");
    if (condition !== null && RX_ONLY_NEGATION.test(condition.trim())) return ambiguous("condizione indeterminata");
    if (!conditional) return result("obbligo", { mandatory: { kind: "always" } }, 0.9);
    return result("obbligo-condizionale", { mandatory: ruleFor("conditional", { condition, q, exception }) }, exception ? 0.75 : 0.8);
  };
  if (found("divieto", LEX.prohib)) {
    if (found("vuoto", LEX.empty)) return obligation();   // "non può essere lasciato vuoto" = obbligo
    return result("divieto", { validation: { on_fail: "block" } }, exception ? 0.75 : 0.85);
  }
  if (found("obbligo-negato", LEX.notRequired)) {
    if (exception !== null) return ambiguous("facoltà con eccezione");
    return result("facolta", { mandatory: ruleFor("never", { condition, q, exception: null }) }, 0.85);
  }
  if (found("obbligo", LEX.oblig)) {
    if (found("facolta-in-contrasto", LEX.optionalStrong)) return ambiguous("obbligo e facoltà in contrasto");
    return obligation();
  }
  if (found("facolta", LEX.faculty)) {
    if (exception !== null) return ambiguous("facoltà con eccezione");
    return result("facolta", { mandatory: ruleFor("never", { condition, q, exception: null }) }, 0.85);
  }
  return ambiguous("nessun segnale deontico");
}

// Testo della colonna "obbligatorio" di una tabella di campi: le celle brevi (Sì/No/X,
// Yes/No/Y/N, ✓, -) sono la regola; tutto il resto passa da parseRule. Cella vuota:
// modalità non determinata → residuo, mai un kind.
const CELL_YES = /^(?:s[iì]|x|yes|y|true|✓|✔|obbl\.?|m)$/iu;
const CELL_NO = /^(?:no|n|false|-|–|—|facolt\.?|opz\.?|o)$/iu;
export function parseMandatoryText(text, { lang } = {}) {
  const t = normalize(text);
  const base = { text: String(text ?? ""), lang: lang ?? detectLang(t), scope_qualifiers: { companies: [], roles: [], states: [], categories: [] },
    condition: null, exception: null, signals: ["cella-tabella"] };
  if (CELL_YES.test(t)) return { ...base, modality: "obbligo", mandatory: { kind: "always" }, consequence: CONSEQUENCE.obbligo, confidence: 0.85 };
  if (CELL_NO.test(t)) return { ...base, modality: "facolta", mandatory: { kind: "never" }, consequence: CONSEQUENCE.facolta, confidence: 0.85 };
  return parseRule(text, { lang });
}

const HELP = `uso: node scripts/ingest/deontic.mjs --text "<frase>" [--lang it|en] [--json] [--help]

Parser lessicale della modalità deontica (§19.10): obbligo, obbligo condizionale, divieto,
facoltà, raccomandazione, comportamento del sistema, non bloccante, immutabilità, vincolo
esterno, ambiguo. Qualificatori di ambito (società, ruolo, stato, categoria) ed eccezioni
(salvo/eccetto/tranne, except/unless). Le frasi ambigue vanno in residuo, senza mandatory.

Exit code: 0 ok · 1 errore utente (testo mancante, lingua non valida) · 2 errore di sistema.`;

function main(argv) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (typeof opts.text !== "string" || !opts.text.trim()) return fail(asJson, 1, "richiesto --text \"<frase>\"");
  if (opts.lang !== undefined && !["it", "en"].includes(opts.lang)) return fail(asJson, 1, "--lang: it oppure en");
  try {
    const r = parseRule(opts.text, { lang: opts.lang });
    console.log(JSON.stringify(asJson ? { ok: true, result: r } : r));
    return 0;
  } catch (e) { return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`); }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
