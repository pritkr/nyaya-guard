import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

export interface Chunk {
  id: string; // `${docId}#p${paraIdx}` (versioned: `${docId}@${version}#p${paraIdx}`)
  docId: string;
  title: string;
  paraIdx: number;
  text: string;
  tokens: string[];
  /** Corpus version label: "current" for live docs, e.g. "2021-v1" for superseded. */
  version: string;
  /** Freshness tag: "current" (default) or "superseded" (kept retrievable, penalised). */
  freshness: "current" | "superseded";
  /** For superseded chunks: scheme id of the replacing doc (= docId). */
  supersededBy?: string;
  /** ISO date until which the superseded version was valid. */
  validUntil?: string;
  /** ISO date from which a version is/was valid. */
  validFrom?: string;
  /** Source file relative to the schemes dir (debugging). */
  sourceFile?: string;
}

export const CURRENT_VERSION = "current";

/** True when the chunk comes from a superseded (stale) document version. */
export function isSuperseded(c: Pick<Chunk, "freshness">): boolean {
  return (c.freshness ?? "current") === "superseded";
}

const STOP = new Set(
  "the,a,an,and,or,of,to,in,on,for,is,are,was,were,be,been,by,with,from,as,at,it,its,this,that,these,those,what,who,how,much,many,do,does,did,can,could,should,would,will,my,i,me,we,you,your,he,she,they,them,his,her,their,our,us,ka,ki,ke,ko,mein,me,hai,kya,kaise,mujhe,meri,mera,ko,aur,ya,ke,pare,se,par,hain,nahi,nahin".split(",")
);

/**
 * Hindi normalization: map common Devanagari welfare terms to their English
 * counterparts so Hindi queries match the (English) scheme corpus. This is a
 * lightweight, deterministic stand-in for a proper Hindi stemmer/embeddings.
 */
const HINDI_NORM: Record<string, string> = {
  "साइकिल": "cycle", "साईकिल": "cycle", "साइकल": "cycle",
  "योजना": "yojana", "योजनाओं": "yojana",
  "बिहार": "bihar",
  "कक्षा": "class", "ककक्षा": "class",
  "लड़की": "girl", "लड़कि": "girl", "बेटी": "girl", "कन्या": "kanya",
  "लड़का": "boy", "बेटा": "boy",
  "सरकारी": "government", "सरकार": "government",
  "स्कूल": "school", "विद्यालय": "school",
  "पेंशन": "pension",
  "वृद्ध": "old", "बुढ़ापा": "old", "बुजुर्ग": "old",
  "विधवा": "widow",
  "दिव्यांग": "disability", "विकलांग": "disability",
  "राशन": "ration",
  "छात्रवृत्ति": "scholarship", "छात्र": "student",
  "वर्दी": "uniform", "पोशाक": "uniform",
  "आवास": "house", "मकान": "house", "घर": "house",
  "ऋण": "loan", "कर्ज": "loan",
  "आयु": "age", "उम्र": "age",
  "निजी": "private",
  "प्रवेश": "admission",
  "मुफ्त": "free",
  "पैसा": "money", "राशि": "amount",
  "आवेदन": "apply",
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[₹,]/g, " ")
    .split(/[^a-z0-9\u0900-\u097F]+/u)
    .map((t) => t.trim())
    .map((t) => HINDI_NORM[t] ?? t)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export interface VersionFrontmatter {
  version?: string;
  status?: string;
  valid_from?: string;
  valid_until?: string;
  superseded_by?: string;
  title?: string;
}

/**
 * Parse `---` YAML-ish frontmatter from a markdown doc.
 * Returns { frontmatter, body }. No dependency: handles flat `key: value`
 * pairs only (quoted or bare). Unknown keys are kept as-is.
 */
export function parseFrontmatter(raw: string): { frontmatter: VersionFrontmatter; body: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };
  const frontmatter: VersionFrontmatter = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:"([^"]*)"|'([^']*)'|(.+?))\s*$/);
    if (!kv) continue;
    const key = kv[1]!;
    const val = (kv[2] ?? kv[3] ?? kv[4] ?? "").trim();
    (frontmatter as Record<string, string>)[key] = val;
  }
  return { frontmatter, body: m[2] ?? "" };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface IngestValidation {
  ok: boolean;
  errors: string[];
  frontmatter: VersionFrontmatter;
}

/**
 * Validate version frontmatter for the `POST /ingest` upload endpoint.
 * Rejects: missing frontmatter, missing `valid_from` (or bad date),
 * `superseded_by` pointing at an unknown scheme, superseded versions
 * missing `valid_until` (or bad date).
 */
export function validateVersionFrontmatter(markdown: string, knownSchemes: string[]): IngestValidation {
  const errors: string[] = [];
  const hasFm = /^---\s*\n/.test(markdown);
  if (!hasFm) {
    return { ok: false, errors: ["missing frontmatter block (--- ... ---) with valid_from"], frontmatter: {} };
  }
  const { frontmatter } = parseFrontmatter(markdown);
  if (!frontmatter.valid_from) {
    errors.push("missing valid_from (required, YYYY-MM-DD)");
  } else if (!DATE_RE.test(frontmatter.valid_from)) {
    errors.push(`bad valid_from date "${frontmatter.valid_from}" (want YYYY-MM-DD)`);
  }
  const isSupersededFm =
    (frontmatter.status ?? "").toLowerCase() === "superseded" || !!frontmatter.superseded_by;
  if (frontmatter.superseded_by) {
    if (!knownSchemes.includes(frontmatter.superseded_by)) {
      errors.push(`bad supersedes link: unknown scheme "${frontmatter.superseded_by}"`);
    }
  }
  if (isSupersededFm) {
    if (!frontmatter.valid_until) {
      errors.push("superseded version requires valid_until (YYYY-MM-DD)");
    } else if (!DATE_RE.test(frontmatter.valid_until)) {
      errors.push(`bad valid_until date "${frontmatter.valid_until}" (want YYYY-MM-DD)`);
    }
    if (!frontmatter.superseded_by) {
      errors.push("superseded version requires superseded_by (current scheme id)");
    }
  }
  if (frontmatter.valid_until && !DATE_RE.test(frontmatter.valid_until)) {
    if (!errors.some((e) => e.includes("valid_until"))) {
      errors.push(`bad valid_until date "${frontmatter.valid_until}" (want YYYY-MM-DD)`);
    }
  }
  return { ok: errors.length === 0, errors, frontmatter };
}

function chunkDoc(
  docId: string,
  title: string,
  body: string,
  meta: { version: string; freshness: "current" | "superseded"; supersededBy?: string; validUntil?: string; validFrom?: string; sourceFile?: string },
): Chunk[] {
  const paras = body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^#\s+.*$/m, "").trim())
    .map((p) => p.replace(/^-\s+/gm, "").trim())
    .filter((p) => p.length > 20);
  return paras.map((text, paraIdx) => ({
    // Index title terms with every chunk: scheme names ("Cycle", "RTE",
    // "Kanya Utthan"...) live in the Markdown title, which is stripped
    // from chunk text. Without this, a query naming the scheme has zero
    // lexical overlap with its own document.
    id: meta.version === CURRENT_VERSION ? `${docId}#p${paraIdx}` : `${docId}@${meta.version}#p${paraIdx}`,
    docId,
    title,
    paraIdx,
    text,
    tokens: tokenize(`${title}\n${text}`),
    version: meta.version,
    freshness: meta.freshness,
    ...(meta.supersededBy ? { supersededBy: meta.supersededBy } : {}),
    ...(meta.validUntil ? { validUntil: meta.validUntil } : {}),
    ...(meta.validFrom ? { validFrom: meta.validFrom } : {}),
    ...(meta.sourceFile ? { sourceFile: meta.sourceFile } : {}),
  }));
}

export function loadCorpus(schemesDir: string): Chunk[] {
  const files = readdirSync(schemesDir).filter((f) => f.endsWith(".md")).sort();
  const chunks: Chunk[] = [];
  for (const file of files) {
    const raw = readFileSync(join(schemesDir, file), "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const docId = basename(file, ".md");
    const title = (body.match(/^#\s+(.+)$/m)?.[1] ?? frontmatter.title ?? docId).trim();
    chunks.push(
      ...chunkDoc(docId, title, body, {
        version: frontmatter.version ?? CURRENT_VERSION,
        freshness: "current",
        ...(frontmatter.valid_from ? { validFrom: frontmatter.valid_from } : {}),
        sourceFile: file,
      }),
    );
  }
  // Versioned history: data/schemes/_versions/*.md. Superseded docs share
  // the CURRENT scheme id (via `superseded_by`) so the scheme list stays
  // 12 docs; chunks carry version/freshness tags instead of new doc ids.
  let versionFiles: string[] = [];
  try {
    versionFiles = readdirSync(join(schemesDir, "_versions")).filter((f) => f.endsWith(".md")).sort();
  } catch {
    versionFiles = [];
  }
  for (const file of versionFiles) {
    const raw = readFileSync(join(schemesDir, "_versions", file), "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const docId = frontmatter.superseded_by ?? basename(file, ".md");
    const title = (body.match(/^#\s+(.+)$/m)?.[1] ?? frontmatter.title ?? docId).trim();
    chunks.push(
      ...chunkDoc(docId, title, body, {
        version: frontmatter.version ?? basename(file, ".md"),
        freshness: "superseded",
        supersededBy: frontmatter.superseded_by ?? docId,
        ...(frontmatter.valid_until ? { validUntil: frontmatter.valid_until } : {}),
        ...(frontmatter.valid_from ? { validFrom: frontmatter.valid_from } : {}),
        sourceFile: `_versions/${file}`,
      }),
    );
  }
  return chunks;
}

export function defaultSchemesDir(): string {
  return join(process.cwd(), "data", "schemes");
}
