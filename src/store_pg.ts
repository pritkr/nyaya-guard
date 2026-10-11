/**
 * v3 — Postgres + pgvector retrieval adapter (`STORE=pg`).
 *
 * The in-memory hybrid retriever in `retriever.ts` stays the default
 * (`STORE=memory`) so CI stays keyless and service-free: `npm test` and
 * `npm run eval` must never need a database. This module is the production
 * path, and it is deliberately a *mirror* of `retriever.ts` rather than a
 * different ranker, because the eval gate's numbers are the numbers we
 * promise. The fusion is reproduced term for term:
 *
 *   retriever.ts                      store_pg.ts (this file)
 *   ------------------------------------------------------------------
 *   BM25 over tokenize(text)          trigram similarity over the token bag
 *                                     (`search_text`, GIN gin_trgm_ops)
 *   cosine of L2-normalised hash vec  `<=>` on `vector(256)`, HNSW
 *   rrfRankFused([byBm25, byCos])     `fused` CTE, k = 60
 *   rrf / max(rrf)                    `rrf_raw / GREATEST(0.0001, max)`
 *   rerankBoost (query-term coverage) `(n_match / n_q)` over `tokens`
 *   aliasBoost (scheme aliases)       `alias` CTE, same table
 *   freshnessPenalty (0.3)            `CASE WHEN freshness='superseded'`
 *   0.6*rrf + 0.4*rerank + alias      `LEAST(1, GREATEST(0, ...))`
 *   isGrounded (>=2 terms or >=50%)   `gate` CTE; no rows => abstain
 *
 * Because both paths read the *same* normalised token bag (stored as
 * `tokens text[]` in Postgres), a top-1 doc is the same doc in either mode.
 * `tests/pg_parity.test.ts` asserts that, and skips with an explicit reason
 * when there is no database to compare against.
 *
 * TENANT ISOLATION. Application SQL never carries a `WHERE tenant_id = ...`.
 * Every transaction opens with `set_config('app.tenant_id', $1, true)` — the
 * parameterised form of `SET LOCAL app.tenant_id = '<id>'`, transaction-scoped
 * so a pooled connection can never leak one tenant's GUC into the next
 * request. The RLS policy in `db/schema.sql` then does the filtering, and it
 * fails CLOSED: with the GUC unset the predicate is NULL and no rows match.
 * `set_config` is used instead of a literal `SET LOCAL ... = 'value'` because
 * `SET` does not accept bind parameters, and string-concatenating a tenant id
 * into SQL is exactly the injection habit this project exists to not have.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_VERSION, tokenize, type Chunk } from "./corpus.js";
import { EMBED_DIM, embed, type ScoredChunk } from "./retriever.js";

// ---------------------------------------------------------------------------
// Minimal structural typing for node-postgres.
//
// `pg` is imported dynamically (variable specifier, so the module is only
// loaded when STORE=pg) and carries no bundled types, so the surface we
// actually use is declared here instead of pulling in @types/pg.
// ---------------------------------------------------------------------------

export interface PgQueryResult<T> {
  rows: T[];
  rowCount: number | null;
}
export interface PgClientLike {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgQueryResult<T>>;
  release(err?: Error | boolean): void;
}
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgQueryResult<T>>;
  end(): Promise<void>;
}
export type PgPoolCtor = new (config: Record<string, unknown>) => PgPoolLike;

const PG_MODULE: string = "pg";
let poolCtor: PgPoolCtor | null = null;

/** Load the `pg` driver on demand. Throws an actionable error if absent. */
export async function loadPgPoolCtor(): Promise<PgPoolCtor> {
  if (poolCtor) return poolCtor;
  let mod: { Pool?: PgPoolCtor; default?: { Pool?: PgPoolCtor } };
  try {
    mod = (await import(PG_MODULE)) as { Pool?: PgPoolCtor; default?: { Pool?: PgPoolCtor } };
  } catch (err) {
    throw new Error(
      `STORE=pg needs the "pg" driver, which is not installed (${(err as Error).message}). ` +
        `Run "npm install pg" or unset STORE to use the in-memory store.`,
    );
  }
  const ctor = mod.Pool ?? mod.default?.Pool;
  if (!ctor) throw new Error('STORE=pg: the "pg" module loaded but exported no Pool constructor.');
  poolCtor = ctor;
  return ctor;
}

// ---------------------------------------------------------------------------
// Store selection (the STORE feature flag)
// ---------------------------------------------------------------------------

export type StoreKind = "memory" | "pg";

export const STORE_FLAG = "STORE";

/**
 * `STORE` is `memory` (default) or `pg`. Anything else is a typo we refuse to
 * guess about: silently falling back to memory on `STORE=postgres` would let
 * a staging box quietly run the wrong backend. `undefined`/blank = memory.
 */
export function resolveStoreKind(env: NodeJS.ProcessEnv = process.env): StoreKind {
  const raw = (env[STORE_FLAG] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "memory" || raw === "in-memory" || raw === "inmemory") return "memory";
  if (raw === "pg" || raw === "postgres" || raw === "postgresql") return "pg";
  throw new Error(
    `STORE must be "memory" or "pg" (got ${JSON.stringify(raw)}). ` +
      `Unset/blank means "memory" — that is the default so CI needs no database.`,
  );
}

export const DATABASE_URL_ENV = "DATABASE_URL";
export const TENANT_ENV = "TENANT_ID";

/** Connection string, or null when unset (the reason every pg test skips). */
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env[DATABASE_URL_ENV] ?? "").trim();
  return raw === "" ? null : raw;
}

/** Tenant for this process. Required in pg mode — there is no default tenant. */
export function tenantFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return requireTenantId(env[TENANT_ENV]);
}

const MAX_TENANT_LEN = 200;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * A tenant id becomes a GUC value and a `text` column. It is always passed as
 * a bind parameter, so it cannot be SQL — but an empty / control-character /
 * oversized value is a configuration bug that would otherwise surface much
 * later as "this tenant mysteriously sees nothing", so it is rejected here.
 */
export function requireTenantId(tenantId: unknown): string {
  if (typeof tenantId !== "string") {
    throw new Error(
      `${TENANT_ENV} must be a string (got ${tenantId === undefined ? "undefined" : typeof tenantId}). ` +
        `pg mode is multi-tenant: there is no implicit default tenant.`,
    );
  }
  const trimmed = tenantId.trim();
  if (trimmed === "") {
    throw new Error(`${TENANT_ENV} must not be empty: an unset tenant must read zero rows, not all rows.`);
  }
  if (trimmed.length > MAX_TENANT_LEN) {
    throw new Error(`${TENANT_ENV} must be at most ${MAX_TENANT_LEN} characters (got ${trimmed.length}).`);
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new Error(`${TENANT_ENV} must not contain control characters.`);
  }
  return trimmed;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * `SET LOCAL ROLE` takes no bind parameter, so the identifier is validated
 * against a bare-identifier grammar and then double-quoted. Anything else is
 * rejected rather than escaped-and-hoped-for.
 */
export function assertSafeIdent(name: string, what = "role"): string {
  if (typeof name !== "string" || !IDENT_RE.test(name)) {
    throw new Error(
      `${what} must be a bare SQL identifier ([A-Za-z_][A-Za-z0-9_$]*), got ${JSON.stringify(name)}`,
    );
  }
  return `"${name}"`;
}

// ---------------------------------------------------------------------------
// Embedding serialisation
// ---------------------------------------------------------------------------

/** `number[]` -> pgvector text input, e.g. `[0.0625,-0.125]`. */
export function vectorLiteral(vec: readonly number[], dim = EMBED_DIM): string {
  if (!Array.isArray(vec)) throw new TypeError("vectorLiteral expects an array of numbers");
  if (vec.length !== dim) throw new RangeError(`expected a ${dim}-d vector (EMBED_DIM), got ${vec.length}-d`);
  const out = new Array<string>(dim);
  for (let i = 0; i < dim; i++) {
    const v = vec[i]!;
    if (!Number.isFinite(v)) throw new RangeError(`vector component ${i} is not finite (${v})`);
    out[i] = Object.is(v, -0) ? "0" : String(v);
  }
  return `[${out.join(",")}]`;
}

// ---------------------------------------------------------------------------
// Fusion constants — mirrors of retriever.ts, asserted equal by tests
// ---------------------------------------------------------------------------

export const RRF_K = 60;
export const ALIAS_BOOST = 0.25;
export const FRESHNESS_PENALTY = 0.3;
export const RRF_WEIGHT = 0.6;
export const RERANK_WEIGHT = 0.4;
export const GROUNDING_MIN_TERMS = 2;
export const GROUNDING_MIN_COVERAGE = 0.5;
export const DEFAULT_MODEL = "hash-256-v1";

export interface AliasSpec {
  scheme: string;
  tokens: string[];
  phrases: string[];
}

/**
 * Scheme aliases, copied from `retriever.ts` `SCHEME_ALIASES`.
 * `tests/store_pg.test.ts` parses retriever.ts and fails if the two ever
 * drift — silent divergence here would quietly change top-1 doc in pg mode.
 */
export const SCHEME_ALIASES: readonly AliasSpec[] = [
  { scheme: "mukhyamantri-cycle-yojana", tokens: ["cycle", "bicycle", "saikil"], phrases: [] },
  { scheme: "mukhyamantri-ration-nfsa", tokens: ["ration", "rashan", "aay", "phh", "nfsa", "pds"], phrases: [] },
  { scheme: "mukhyamantri-vridhjan-pension", tokens: ["vridhjan", "vriddha", "senior", "budhapa", "budha"], phrases: ["old age"] },
  { scheme: "lakshmibai-widow-pension", tokens: ["widow", "vidhwa", "lakshmibai"], phrases: [] },
  { scheme: "mukhyamantri-divyangjan-pension", tokens: ["disability", "divyang", "divyangjan", "udid", "viklang", "handicap"], phrases: [] },
  { scheme: "bihar-student-credit-card", tokens: ["bscc", "btech", "loan"], phrases: ["credit card"] },
  { scheme: "rte-admission-ews", tokens: ["rte", "ews"], phrases: [] },
  { scheme: "pmay-gramin-bihar", tokens: ["pmay", "awas", "houseless", "kutcha", "ghar"], phrases: [] },
  { scheme: "pre-matric-scholarship", tokens: [], phrases: ["pre matric", "pre-matric"] },
  { scheme: "post-matric-scholarship", tokens: ["post", "college"], phrases: ["post matric", "post-matric"] },
  { scheme: "mukhyamantri-kanya-utthan", tokens: ["kanya", "utthan"], phrases: [] },
  { scheme: "mukhyamantri-poshak-yojana", tokens: ["poshak", "uniform", "vardi"], phrases: [] },
];

// ---------------------------------------------------------------------------
// SQL builders (pure, so the statements are unit-testable with no database)
// ---------------------------------------------------------------------------

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
function sqlTextArray(values: readonly string[]): string {
  return values.length === 0 ? "ARRAY[]::text[]" : `ARRAY[${values.map(sqlLiteral).join(", ")}]::text[]`;
}

export interface HybridParams {
  query: string;
  qtokens: string[];
  qvec: readonly number[];
  topK: number;
  qlower: string;
  fusionDepth: number;
}

/** $1 query · $2 query tokens · $3 query vector · $4 top-k · $5 lowercased query · $6 fusion depth */
export const HYBRID_PARAM_COUNT = 6;

const ALIAS_CTE = `alias AS (
  SELECT * FROM (VALUES
${SCHEME_ALIASES.map(
  (a) => `    (${sqlLiteral(a.scheme)}, ${sqlTextArray(a.tokens)}, ${sqlTextArray(a.phrases)})`,
).join(",\n")}
  ) AS t(scheme, tokens, phrases)
)`;

/**
 * The hybrid retrieval statement. One round trip: dense CTE + lexical CTE ->
 * RRF fusion -> rerank / alias / freshness -> grounding gate -> top-k.
 *
 * Depth note: `retriever.ts` ranks *every* chunk in both branches before
 * fusing. Here each branch ranks its own top `fusionDepth`. Setting
 * `fusionDepth` to at least the tenant's chunk count makes the two
 * mathematically the same candidate pool; the default (0 => derived) is a
 * heuristic that keeps this affordable on a large corpus.
 */
export function hybridSql(): string {
  return `
WITH params AS (
  SELECT $1::text   AS qtext,
         $2::text[] AS qtokens,
         $3::vector AS qvec,
         $4::int    AS k,
         $5::text   AS qlower,
         $6::int    AS depth
),
-- Branch A: dense. row_number() is assigned in the same order as the outer
-- ORDER BY, so LIMIT keeps ranks 1..depth. RLS has already narrowed this
-- scan to one tenant; see db/schema.sql on hnsw.iterative_scan for why a
-- tenant filter on top of an ANN index needs iterative scans.
dense AS (
  SELECT c.id,
         row_number() OVER (ORDER BY c.embedding <=> p.qvec) AS rank
  FROM chunks c, params p
  WHERE c.embedding IS NOT NULL
  ORDER BY c.embedding <=> p.qvec
  LIMIT (SELECT GREATEST(depth, k) FROM params)
),
-- Branch B: lexical. \`%\` is the pg_trgm index operator and the only way the
-- GIN trigram index can be used; the threshold is deliberately low (see
-- PgChunkStoreOptions.trigramSimilarityThreshold) because a 60-char citizen
-- query against a 300-char paragraph scores far below the pg_trgm default of
-- 0.3. Scored over the normalised token bag, not raw prose.
lexical AS (
  SELECT c.id,
         row_number() OVER (
           ORDER BY similarity(c.search_text, p.qtext) DESC, c.doc_id, c.ordinal
         ) AS rank
  FROM chunks c, params p
  WHERE c.search_text % p.qtext
  ORDER BY similarity(c.search_text, p.qtext) DESC, c.doc_id, c.ordinal
  LIMIT (SELECT GREATEST(depth, k) FROM params)
),
-- Reciprocal rank fusion, k = ${RRF_K}. COALESCE-to-0 is what "absent from a
-- branch" means, exactly as rrfRankFused() skips ranks a list does not have.
fused AS (
  SELECT c.id,
         COALESCE(1.0 / (${RRF_K} + d.rank), 0) + COALESCE(1.0 / (${RRF_K} + l.rank), 0) AS rrf_raw
  FROM chunks c
  LEFT JOIN dense d ON d.id = c.id
  LEFT JOIN lexical l ON l.id = c.id
),
${ALIAS_CTE},
scored AS (
  SELECT c.id,
         c.tenant_id,
         c.doc_id,
         c.ordinal,
         c.title,
         c.content,
         c.tokens,
         c.version,
         c.freshness,
         c.valid_from,
         c.valid_until,
         c.superseded_by,
         c.model,
         c.chunk_key,
         COALESCE(1 - (c.embedding <=> p.qvec), 0)::real AS cosine,
         similarity(c.search_text, p.qtext)::real AS lexical_sim,
         (f.rrf_raw / GREATEST(0.0001, (SELECT MAX(rrf_raw) FROM fused)))::real AS rrf,
         cov.n_q,
         cov.n_match,
         CASE WHEN EXISTS (
           SELECT 1 FROM alias a
           WHERE a.scheme = c.doc_id
             AND ((a.tokens && p.qtokens)
                  OR EXISTS (SELECT 1 FROM unnest(a.phrases) AS ph(word) WHERE strpos(p.qlower, ph.word) > 0))
         ) THEN ${ALIAS_BOOST} ELSE 0 END::real AS alias_boost
  FROM chunks c
  JOIN fused f ON f.id = c.id
  CROSS JOIN params p
  CROSS JOIN LATERAL (
    SELECT count(DISTINCT qtok)::real AS n_q,
           count(DISTINCT qtok) FILTER (WHERE c.tokens @> ARRAY[qtok])::real AS n_match
    FROM unnest(p.qtokens) AS u(qtok)
  ) cov
),
-- The final score, spelled exactly as retriever.ts spells it.
scored_final AS (
  SELECT s.*,
         LEAST(1, GREATEST(0,
           ${RRF_WEIGHT} * s.rrf
           + ${RERANK_WEIGHT} * (s.n_match / GREATEST(1, s.n_q))
           + s.alias_boost
           - (CASE WHEN s.freshness = 'superseded' THEN ${FRESHNESS_PENALTY} ELSE 0 END)
         ))::real AS score
  FROM scored s
),
ranked AS (
  SELECT f.*, row_number() OVER (ORDER BY f.score DESC, f.doc_id, f.ordinal) AS rn
  FROM scored_final f
),
-- Grounding gate. A citizen question is answered only when its top chunk
-- actually shares evidence with it: >= ${GROUNDING_MIN_TERMS} distinct query
-- terms, or >= ${GROUNDING_MIN_COVERAGE * 100}% coverage for a very short query
-- ("Pension?"). No gate pass => zero rows => abstain, never fabricate.
gate AS (
  SELECT 1 AS ok
  FROM ranked
  WHERE rn = 1
    AND (n_match >= ${GROUNDING_MIN_TERMS}
         OR (n_match / GREATEST(1, n_q)) >= ${GROUNDING_MIN_COVERAGE})
)
SELECT r.id,
       r.tenant_id,
       r.doc_id,
       r.ordinal,
       r.title,
       r.content,
       r.tokens,
       r.version,
       r.freshness,
       r.valid_from,
       r.valid_until,
       r.superseded_by,
       r.model,
       r.chunk_key,
       r.cosine,
       r.lexical_sim,
       r.rrf,
       (r.n_match / GREATEST(1, r.n_q))::real AS rerank,
       r.alias_boost,
       r.score
FROM ranked r
WHERE EXISTS (SELECT 1 FROM gate)
ORDER BY r.rn
LIMIT (SELECT k FROM params)`.trim();
}

export function hybridParams(input: { query: string; topK?: number; fusionDepth?: number }): HybridParams {
  const topK = input.topK ?? 4;
  if (!Number.isInteger(topK) || topK < 1) throw new RangeError(`topK must be a positive integer, got ${topK}`);
  const fusionDepth = input.fusionDepth ?? 0;
  if (!Number.isInteger(fusionDepth) || fusionDepth < 0) {
    throw new RangeError(`fusionDepth must be a non-negative integer, got ${fusionDepth}`);
  }
  const qtokens = tokenize(input.query);
  return {
    query: input.query,
    qtokens,
    qvec: embed(qtokens),
    topK,
    qlower: input.query.toLowerCase(),
    fusionDepth,
  };
}

/**
 * Positional bind values matching `hybridSql()`. `fusionDepth: 0` becomes a
 * derived default: 32x top-k, minimum 200, so a 58-chunk corpus is always
 * fully ranked and a large corpus still costs a bounded candidate set.
 */
export function hybridBindValues(p: HybridParams, dim = EMBED_DIM): unknown[] {
  const depth = p.fusionDepth > 0 ? p.fusionDepth : Math.max(200, p.topK * 32);
  return [p.query, p.qtokens, vectorLiteral(p.qvec, dim), p.topK, p.qlower, depth];
}

/** Highest `$n` index in `sql`. Tests use it to catch placeholder/value drift. */
export function placeholderCount(sql: string): number {
  let max = 0;
  for (const m of sql.matchAll(/\$(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

export const UPSERT_COLUMN_COUNT = 14;

/** Column order of a single row in `upsertSql()`. */
export const UPSERT_COLUMNS = [
  "tenant_id", "doc_id", "ordinal", "title", "content", "tokens", "embedding",
  "model", "version", "freshness", "superseded_by", "valid_from", "valid_until", "chunk_key",
] as const;

const UPSERT_UPDATED = [
  "content", "title", "tokens", "embedding", "model", "freshness",
  "superseded_by", "valid_from", "valid_until", "chunk_key",
] as const;

/**
 * Idempotent chunk write, `rows` rows per statement. ON CONFLICT on the named
 * natural-key constraint makes re-syncing the corpus free: a re-run only
 * touches rows whose content actually moved, and `updated_at` records when.
 */
export function upsertSql(rows: number): string {
  if (!Number.isInteger(rows) || rows < 1) throw new RangeError(`rows must be >= 1, got ${rows}`);
  // Placeholders are numbered across the whole VALUES list, not per row: in
  // one multi-VALUES INSERT, "$1..$14" repeated 64 times would bind every
  // tuple to the first row's values.
  const tuples: string[] = [];
  for (let r = 0; r < rows; r++) {
    const base = r * UPSERT_COLUMN_COUNT;
    tuples.push(`(${Array.from({ length: UPSERT_COLUMN_COUNT }, (_, i) => `$${base + i + 1}`).join(", ")})`);
  }
  const sets = [...UPSERT_UPDATED].map((c) => `${c} = EXCLUDED.${c}`);
  sets.push("updated_at = now()");
  return (
    `INSERT INTO chunks (${UPSERT_COLUMNS.join(", ")})\n` +
    `VALUES ${tuples.join(",\n       ")}\n` +
    `ON CONFLICT ON CONSTRAINT chunks_natural_key DO UPDATE SET ${sets.join(", ")}`
  );
}

/**
 * The gradual re-embedding worklist: how many chunks sit on which embedding
 * model, per tenant. `sync()` never silently re-embeds — it records the model
 * it wrote, and this query tells the operator what is still outstanding.
 */
export function reembedPendingSql(): string {
  return `SELECT tenant_id,
       model,
       count(*)::int AS chunks,
       count(*) FILTER (WHERE embedding IS NULL)::int AS unembedded
FROM chunks
GROUP BY tenant_id, model
ORDER BY tenant_id, model`;
}

/** Current-version chunks of one scheme — the v2 staleness-guard fallback. */
export function currentSchemeChunksSql(): string {
  return `SELECT id,
       doc_id,
       ordinal,
       title,
       content,
       tokens,
       version,
       freshness,
       chunk_key
FROM chunks
WHERE doc_id = $1 AND freshness = 'current'
ORDER BY ordinal`;
}

/** Per-tenant chunk census, ignoring RLS. Operator/maintenance only. */
export function tenantStatsSql(): string {
  return `SELECT count(*)::int AS chunks,
       count(DISTINCT doc_id)::int AS docs,
       count(*) FILTER (WHERE freshness = 'superseded')::int AS superseded
FROM chunks`;
}

// ---------------------------------------------------------------------------
// Transaction-scoped session setup
// ---------------------------------------------------------------------------

export interface SessionSetup {
  role?: string;
  trigramSimilarityThreshold: number;
  hnswEfSearch: number;
  iterativeScan: "off" | "strict_order" | "relaxed_order";
}

export interface SetupStatement {
  sql: string;
  values: unknown[];
  /** GUC that may not exist on older extension versions; failure is tolerated. */
  optional?: boolean;
}

/**
 * Statements run immediately after BEGIN, in order. The tenant GUC comes
 * first and is mandatory: it is the only thing standing between one tenant's
 * query and another tenant's rows.
 */
export function setupStatements(tenantId: string, s: SessionSetup): SetupStatement[] {
  const stmts: SetupStatement[] = [
    // set_config(..., true) IS "SET LOCAL": the third argument scopes the value
    // to the current transaction only, and unlike SET it takes a bind
    // parameter, so the tenant id can never be interpolated into SQL.
    { sql: "SELECT set_config('app.tenant_id', $1, true)", values: [tenantId] },
  ];
  if (s.role) stmts.push({ sql: `SET LOCAL ROLE ${assertSafeIdent(s.role)}`, values: [] });
  const thr = s.trigramSimilarityThreshold;
  if (!Number.isFinite(thr) || thr < 0 || thr > 1) {
    throw new RangeError(`trigramSimilarityThreshold must be within [0,1], got ${thr}`);
  }
  stmts.push({ sql: `SET LOCAL pg_trgm.similarity_threshold = ${thr}`, values: [] });
  const ef = s.hnswEfSearch;
  if (!Number.isInteger(ef) || ef < 1) throw new RangeError(`hnswEfSearch must be a positive integer, got ${ef}`);
  stmts.push({ sql: `SET LOCAL hnsw.ef_search = ${ef}`, values: [] });
  if (s.iterativeScan !== "off") {
    // pgvector >= 0.8 only. A tolerated failure: on 0.5-0.7 the ANN scan just
    // returns fewer rows under selective filters, which the RRF normalisation
    // absorbs. See db/schema.sql, "ITERATIVE INDEX SCANS".
    stmts.push({ sql: `SET LOCAL hnsw.iterative_scan = ${s.iterativeScan}`, values: [], optional: true });
  }
  return stmts;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

export interface ChunkRow {
  id: string;
  tenant_id: string;
  doc_id: string;
  ordinal: number;
  title: string;
  content: string;
  tokens: string[];
  version: string;
  freshness: string;
  valid_from: string | Date | null;
  valid_until: string | Date | null;
  superseded_by: string | null;
  model: string;
  chunk_key: string;
  cosine: number;
  lexical_sim: number;
  rrf: number;
  rerank: number;
  alias_boost: number;
  score: number;
}

/** Postgres `date` columns arrive as Date in UTC; the app model wants YYYY-MM-DD. */
export function isoDate(value: string | Date | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/** `chunk_key` as corpus.ts builds it — also enforced by a CHECK in schema.sql. */
export function chunkKeyOf(docId: string, version: string, ordinal: number): string {
  return version === CURRENT_VERSION ? `${docId}#p${ordinal}` : `${docId}@${version}#p${ordinal}`;
}

export function rowToScored(row: ChunkRow): ScoredChunk {
  const validUntil = isoDate(row.valid_until);
  const validFrom = isoDate(row.valid_from);
  return {
    chunk: {
      id: row.chunk_key,
      docId: row.doc_id,
      title: row.title,
      paraIdx: row.ordinal,
      text: row.content,
      tokens: row.tokens ?? [],
      version: row.version,
      freshness: row.freshness === "superseded" ? "superseded" : "current",
      ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
      ...(validUntil ? { validUntil } : {}),
      ...(validFrom ? { validFrom } : {}),
    },
    // `bm25` keeps its name from the ScoredChunk contract but carries the
    // trigram similarity of the lexical branch. Nothing downstream reads it
    // (llm.ts quotes chunk text, server.ts ranks on `final`), and adding a
    // second field would break the shared type for no gain.
    bm25: row.lexical_sim,
    cosine: row.cosine,
    rrf: row.rrf,
    rerank: row.rerank,
    final: row.score,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface RetrieveOutcome {
  results: ScoredChunk[];
  confidence: number;
  ids: string[];
  tenantId: string;
}

/** Confidence rule, identical to retriever.ts: empty => abstain at 0. */
export function confidenceOf(results: ScoredChunk[]): number {
  if (results.length === 0) return 0;
  return round2(Math.min(1, Math.max(0, results[0]!.final)));
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface PgChunkStoreOptions {
  connectionString?: string;
  tenantId: string;
  /** Rows per multi-VALUES upsert. 14 params/row, so 64 rows = 896 params. */
  batchSize?: number;
  /** Least-privilege role to drop to (SET LOCAL ROLE) — must be NOSUPERUSER. */
  role?: string;
  trigramSimilarityThreshold?: number;
  hnswEfSearch?: number;
  iterativeScan?: "off" | "strict_order" | "relaxed_order";
  /** Max pool size; retrieval is short and transaction-scoped. */
  poolSize?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
}

export const DEFAULT_TRIGRAM_THRESHOLD = 0.01;
export const DEFAULT_HNSW_EF_SEARCH = 160;
export const DEFAULT_BATCH_SIZE = 64;

export class PgChunkStore {
  readonly tenantId: string;
  private readonly opts: PgChunkStoreOptions;
  private readonly setup: SessionSetup;
  private readonly hybrid: string;
  private readonly maxBatch: number;
  private pool: PgPoolLike | null = null;
  /** GUCs we already know this server lacks; never retried. */
  private readonly unsupportedGuc = new Set<string>();

  constructor(options: PgChunkStoreOptions) {
    this.tenantId = requireTenantId(options.tenantId);
    this.opts = options;
    this.setup = {
      ...(options.role ? { role: options.role } : {}),
      trigramSimilarityThreshold: options.trigramSimilarityThreshold ?? DEFAULT_TRIGRAM_THRESHOLD,
      hnswEfSearch: options.hnswEfSearch ?? DEFAULT_HNSW_EF_SEARCH,
      iterativeScan: options.iterativeScan ?? "strict_order",
    };
    this.hybrid = hybridSql();
    this.maxBatch = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  private connectionString(): string {
    const url = this.opts.connectionString ?? databaseUrl();
    if (!url) {
      throw new Error(
        `${DATABASE_URL_ENV} is not set but the store kind is "pg". ` +
          `Set ${DATABASE_URL_ENV} (e.g. postgres://nyaya:nyaya@localhost:5433/nyaya) or unset STORE.`,
      );
    }
    return url;
  }

  async open(): Promise<this> {
    if (this.pool) return this;
    const Pool = await loadPgPoolCtor();
    this.pool = new Pool({
      connectionString: this.connectionString(),
      max: this.opts.poolSize ?? 8,
      connectionTimeoutMillis: this.opts.connectionTimeoutMs ?? 5_000,
      // A retrieval that has not answered in 10s is a problem, not a wait.
      statement_timeout: this.opts.statementTimeoutMs ?? 10_000,
      application_name: "nyaya-guard",
    });
    return this;
  }

  private requirePool(): PgPoolLike {
    if (!this.pool) throw new Error("PgChunkStore used before open() — call await store.open() first");
    return this.pool;
  }

  /**
   * Run `fn` inside a transaction pinned to this store's tenant. Everything
   * the callback can see is tenant-scoped; the GUC is dropped by
   * COMMIT/ROLLBACK, so a pooled connection is never left tagged.
   */
  withTenant<T>(fn: (client: PgClientLike) => Promise<T>): Promise<T> {
    return this.withSession(fn, { dropRole: true });
  }

  /**
   * Same transaction discipline, but the session keeps the connected role.
   * For DDL (see `applySchema`): the least-privilege app role deliberately
   * cannot CREATE INDEX, so migrations must not be run through `withTenant`.
   */
  withAdmin<T>(fn: (client: PgClientLike) => Promise<T>): Promise<T> {
    return this.withSession(fn, { dropRole: false });
  }

  private async withSession<T>(fn: (client: PgClientLike) => Promise<T>, opts: { dropRole: boolean }): Promise<T> {
    const client = await this.requirePool().connect();
    let released = false;
    const release = (err?: Error) => {
      if (released) return;
      released = true;
      client.release(err);
    };
    const statements = setupStatements(this.tenantId, this.setup).filter(
      (s) => opts.dropRole || !s.sql.startsWith("SET LOCAL ROLE"),
    );
    try {
      await client.query("BEGIN");
      for (const stmt of statements) {
        if (stmt.optional && this.unsupportedGuc.has(stmt.sql)) continue;
        try {
          await client.query(stmt.sql, stmt.values);
        } catch (err) {
          if (!stmt.optional) throw err;
          this.unsupportedGuc.add(stmt.sql);
        }
      }
      let out: T;
      try {
        out = await fn(client);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        release(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
      await client.query("COMMIT");
      release();
      return out;
    } catch (err) {
      release(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /** Hybrid retrieval, tenant-pinned, one round trip. Same shape as retriever.ts. */
  async hybridRetrieve(query: string, topK = 4, fusionDepth?: number): Promise<RetrieveOutcome> {
    if (typeof query !== "string" || query.trim() === "") {
      return { results: [], confidence: 0, ids: [], tenantId: this.tenantId };
    }
    const p = hybridParams({ query, topK, ...(fusionDepth === undefined ? {} : { fusionDepth }) });
    const values = hybridBindValues(p);
    if (placeholderCount(this.hybrid) !== HYBRID_PARAM_COUNT || values.length !== HYBRID_PARAM_COUNT) {
      throw new Error(
        `hybridSql()/hybridBindValues() drifted apart: ${placeholderCount(this.hybrid)} ` +
          `placeholders vs ${values.length} values.`,
      );
    }
    const { rows } = await this.withTenant((client) => client.query<ChunkRow>(this.hybrid, values));
    const results = rows.map(rowToScored);
    return { results, confidence: confidenceOf(results), ids: results.map((r) => r.chunk.id), tenantId: this.tenantId };
  }

  /**
   * Write the corpus into Postgres, tenant-scoped and idempotent. Records the
   * `model` that produced each embedding, so the re-embedding worklist
   * (`reembedPendingSql()`) is exact rather than guessed.
   */
  async sync(chunks: Chunk[], model = DEFAULT_MODEL): Promise<{ written: number; batches: number }> {
    if (chunks.length === 0) return { written: 0, batches: 0 };
    let written = 0;
    let batches = 0;
    for (let i = 0; i < chunks.length; i += this.maxBatch) {
      const batch = chunks.slice(i, i + this.maxBatch);
      const values: unknown[] = [];
      for (const c of batch) {
        const superseded = c.freshness === "superseded";
        values.push(
          this.tenantId,
          c.docId,
          c.paraIdx,
          c.title,
          c.text,
          c.tokens,
          vectorLiteral(embed(c.tokens)),
          model,
          c.version,
          superseded ? "superseded" : "current",
          superseded ? (c.supersededBy ?? c.docId) : null,
          c.validFrom ?? null,
          c.validUntil ?? null,
          chunkKeyOf(c.docId, c.version, c.paraIdx),
        );
      }
      await this.withTenant((client) => client.query(upsertSql(batch.length), values));
      written += batch.length;
      batches += 1;
    }
    return { written, batches };
  }

  /** Current-version chunks of one scheme (v2 staleness-guard fallback). */
  async currentSchemeChunks(docId: string): Promise<ChunkRow[]> {
    const { rows } = await this.withTenant((client) => client.query<ChunkRow>(currentSchemeChunksSql(), [docId]));
    return rows;
  }

  /** How many chunks are still on which embedding model, per tenant. */
  async reembedPending(): Promise<{ tenant_id: string; model: string; chunks: number; unembedded: number }[]> {
    const { rows } = await this.withTenant((client) =>
      client.query<{ tenant_id: string; model: string; chunks: number; unembedded: number }>(reembedPendingSql()),
    );
    return rows;
  }

  /**
   * Apply db/schema.sql. Idempotent; safe to run on every deploy. Runs as the
   * connected role (not the RLS-restricted app role) because migrations need
   * DDL rights the app role deliberately does not have.
   */
  async applySchema(schemaPath?: string): Promise<void> {
    const sql = readSchemaSql(schemaPath);
    await this.withAdmin((client) => client.query(sql));
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    if (pool) await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Schema access
// ---------------------------------------------------------------------------

export function schemaPath(): string {
  return join(process.cwd(), "db", "schema.sql");
}

export function readSchemaSql(path = schemaPath()): string {
  const sql = readFileSync(path, "utf-8");
  if (!/CREATE TABLE IF NOT EXISTS chunks/i.test(sql)) {
    throw new Error(
      `${path} does not look like the nyaya-guard store schema (no "CREATE TABLE IF NOT EXISTS chunks").`,
    );
  }
  return sql;
}
