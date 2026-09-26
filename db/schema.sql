-- ============================================================================
-- nyaya-guard v3 — Postgres store (pgvector + pg_trgm + RLS tenant isolation)
-- ============================================================================
--
-- Apply (idempotent — safe to re-run on an already-migrated database):
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
--   or, from the app:
--     await new PgChunkStore({...}).applySchema()
--
-- Minimum versions: PostgreSQL 12+ (generated columns; gen_random_uuid() is
-- core from 13), pgvector 0.5+ (HNSW), pgvector 0.8+ (iterative index scans),
-- pg_trgm 1.4+ (`%` index operator + similarity()).
--
-- DESIGN NOTES
--   * The corpus is bilingual-ish (English markdown, Hindi queries) and lives
--     in `content`; the exact token bag the in-memory BM25 branch consumes is
--     mirrored into `tokens text[]` so a Postgres query can reproduce the
--     memory ranking. `search_text` is the space-joined projection of that bag
--     — the trigram index is built on it, NOT on raw prose, because trigrams
--     over raw text are dominated by punctuation/whitespace noise while the
--     token projection is what BM25 actually ranked.
--   * `embedding` is stored as pgvector `vector(256)` because `EMBED_DIM` in
--     src/retriever.ts is 256. Changing EMBED_DIM requires a new dim and a new
--     HNSW index (see README "Migration notes").
--   * `model` records WHICH embedding model produced `embedding`. It is not
--     decoration: it is what makes gradual re-embedding possible (see
--     `chunks_needing_reembed` below and README "Migration notes").
--
-- ---------------------------------------------------------------------------
-- ITERATIVE INDEX SCANS (pgvector >= 0.8) — read before tuning
-- ---------------------------------------------------------------------------
-- HNSW is an APPROXIMATE nearest-neighbour index. With a plain
-- `ORDER BY embedding <=> $1 LIMIT k` the index walk stops as soon as it has
-- `k` survivors, so a selective predicate on top of it (tenant_id via RLS,
-- `freshness = 'current'`, a `similarity()` threshold) can leave you with
-- FEWER than k rows — or zero — even when many qualifying rows exist. Two
-- settings fix that, and the store sets them per transaction:
--
--     SET LOCAL hnsw.iterative_scan = strict_order;   -- keeps exact distance
--                                                    -- order, scans deeper
--     SET LOCAL hnsw.max_scan_tuples = 20000;         -- default; raise for
--                                                    -- very selective filters
--                                                    -- (default in pgvector)
--
-- `strict_order` is the right default for nyaya-guard: our RRF fusion feeds
-- ranks into `1/(60+rank)`, so rank ORDER is part of the scoring contract and
-- `relaxed_order` (slightly cheaper, slightly out-of-order results) would make
-- the SQL ranking subtly disagree with src/retriever.ts. The trade-off is
-- latency, not correctness: iterative scans are slower but keep recall at
-- (near) 100%.
--
-- Two more build-time notes:
--   * Build the HNSW index AFTER bulk loading (or raise
--     `maintenance_work_mem` first). Empty-then-INSERT is much slower than a
--     CREATE INDEX over loaded data.
--   * `ef_search` (default 40) is the per-query breadth. The hybrid query
--     needs depth >= the fusion depth, so the store raises
--     `hnsw.ef_search` to at least 4x the requested top-k.
--
-- ---------------------------------------------------------------------------
-- RLS DESIGN
-- ---------------------------------------------------------------------------
-- The app never sends a tenant filter in application SQL. It sets
-- `app.tenant_id` for the transaction and Postgres filters rows. Two
-- properties make this fail CLOSED rather than open:
--
--   1. `current_setting('app.tenant_id', true)` returns NULL when the GUC is
--      unset (missing_ok = true), and `tenant_id = NULL` is NULL -> row
--      hidden. An unset tenant therefore sees nothing, not everything.
--   2. `nullif(..., '')` collapses the empty string to NULL for the same
--      reason, so a client that sends "" cannot match a blank tenant.
--
-- `FORCE ROW LEVEL SECURITY` is what makes this testable and safe for the
-- table OWNER: without FORCE, the owner silently bypasses every policy, which
-- is exactly the "it worked in the dev connection and leaked in prod" bug.
-- Caveat to keep in mind: SUPERUSERS and roles granted BYPASSRLS bypass RLS
-- unconditionally, so the application must connect as a NOSUPERUSER role
-- (see the role bootstrap at the bottom of this file).
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Extensions. Pinned to `public` so the unqualified calls in the retrieval
-- SQL (`similarity()`, `<=>`, `vector`) resolve regardless of the connecting
-- role's search_path.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector  WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- ---------------------------------------------------------------------------
-- chunks — one row per paragraph-chunk, scoped to a tenant.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chunks (
  -- Surrogate key. Natural key is (tenant_id, doc_id, version, ordinal):
  -- corpus.ts can emit a superseded version of an existing doc_id, so doc_id
  -- alone is NOT unique, and the natural key is what ON CONFLICT upserts on.
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- RLS discriminator. NOT NULL + non-empty: a blank tenant is a bug, and an
  -- empty string would otherwise be a shared "tenant" everybody could read.
  tenant_id   text        NOT NULL CHECK (tenant_id <> ''),

  doc_id      text        NOT NULL CHECK (doc_id <> ''),
  ordinal     integer     NOT NULL CHECK (ordinal >= 0),
  title       text        NOT NULL DEFAULT '',

  -- Raw paragraph text as written in the markdown (what citations quote).
  content     text        NOT NULL,

  -- Exact token bag from corpus.ts `tokenize()` (lowercased, stop-words
  -- dropped, Hindi welfare terms mapped to English, TITLE terms included).
  -- The in-memory BM25 branch ranks over this, not over `content`.
  tokens      text[]      NOT NULL DEFAULT '{}'::text[],

  -- Space-joined projection of `tokens`; the column the trigram index is
  -- built on. Generated so it can never drift from `tokens`.
  search_text text        GENERATED ALWAYS AS (array_to_string(tokens, ' ')) STORED,

  -- 256 dims = EMBED_DIM in src/retriever.ts. NULL is legal: a chunk can be
  -- stored (and lexically searched) before it has been embedded yet — the
  -- dense branch skips it via `embedding IS NOT NULL`.
  embedding   vector(256),

  -- WHICH model produced `embedding`. This is the hook for gradual
  -- re-embedding: rows written by an older model stay online and keep
  -- serving lexical hits while `chunks_needing_reembed` tells you exactly
  -- which rows to re-embed. Do NOT drop this column in v3 -> the migration
  -- path to a real embedding API depends on it.
  model       text        NOT NULL DEFAULT 'hash-256-v1' CHECK (model <> ''),

  -- v2 freshness model, carried into the store so the SQL ranking can apply
  -- the same penalty the in-memory retriever applies.
  version     text        NOT NULL DEFAULT 'current',
  freshness   text        NOT NULL DEFAULT 'current'
              CHECK (freshness IN ('current', 'superseded')),
  valid_from  date,
  valid_until date,
  superseded_by text,

  -- Chunk identity as understood by the app layer (corpus.ts `Chunk.id`):
  -- `${doc_id}#p${ordinal}` for the live version, `${doc_id}@${version}#pN`
  -- for a superseded one. Stored AND check-constrained so the two id schemes
  -- cannot drift apart across a migration.
  chunk_key   text        NOT NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chunks_natural_key UNIQUE (tenant_id, doc_id, version, ordinal),

  CONSTRAINT chunks_chunk_key_matches CHECK (
    chunk_key = CASE
      WHEN version = 'current'
        THEN doc_id || '#p' || ordinal::text
      ELSE doc_id || '@' || version || '#p' || ordinal::text
    END
  ),

  -- A superseded row must be self-describing: it needs the scheme it was
  -- replaced by and the date it stopped being valid. A "current" row must NOT
  -- claim to be superseded. This is the DB-side twin of
  -- corpus.ts `validateVersionFrontmatter`.
  CONSTRAINT chunks_freshness_shape CHECK (
    (freshness = 'current'
       AND superseded_by IS NULL
       AND valid_until IS NULL)
    OR
    (freshness = 'superseded'
       AND superseded_by IS NOT NULL
       AND valid_until IS NOT NULL)
  )
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- (1) HNSW, cosine distance — the dense branch of the hybrid query.
--     m = 16 / ef_construction = 64 are the pgvector defaults, stated
--     explicitly so the index is reproducible from this file alone.
--     cosine (<=>) rather than L2 because src/retriever.ts scores dot product
--     of L2-normalised vectors, which is exactly cosine.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- (2) GIN trigram — the lexical branch. `gin_trgm_ops` serves both
--     `search_text % query` (the index-usable threshold predicate that keeps
--     the CTE from becoming a sequential scan) and `similarity()`.
--     pg_trgm indexes need an explicit threshold for `%`; we set
--     `pg_trgm.similarity_threshold` low in the store so short citizen
--     queries ("widow pension", "RTE") still clear the bar.
CREATE INDEX IF NOT EXISTS chunks_search_text_trgm_idx
  ON chunks USING gin (search_text gin_trgm_ops);

-- (3) RLS + re-sort support. Postgres can serve `tenant_id = $x` from here,
--     and the deterministic tiebreak (doc_id, ordinal) in the final ORDER BY
--     becomes an index-only walk instead of a sort.
CREATE INDEX IF NOT EXISTS chunks_tenant_doc_idx
  ON chunks (tenant_id, doc_id, ordinal);

-- (4) Re-embedding sweep: `WHERE tenant_id = $1 AND model <> $2` (see
--     chunks_needing_reembed). Without this the sweep is a full scan of
--     every embedding in the tenant.
CREATE INDEX IF NOT EXISTS chunks_model_idx
  ON chunks (tenant_id, model);

-- (5) Staleness guard: find a superseded version of a scheme cheaply.
CREATE INDEX IF NOT EXISTS chunks_superseded_idx
  ON chunks (tenant_id, doc_id, ordinal)
  WHERE freshness = 'superseded';

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks FORCE  ROW LEVEL SECURITY;

-- DROP + CREATE (there is no CREATE POLICY IF NOT EXISTS) keeps the file
-- re-runnable while the policy itself stays a single source of truth.
DROP POLICY IF EXISTS chunks_tenant_isolation ON chunks;
CREATE POLICY chunks_tenant_isolation ON chunks
  FOR ALL
  TO PUBLIC
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));

COMMENT ON POLICY chunks_tenant_isolation ON chunks IS
  'Tenant isolation. The app sets app.tenant_id per transaction (SET LOCAL, '
  'or the parameterised set_config(''app.tenant_id'', $1, true)); when it is '
  'unset or empty the predicate is NULL and ZERO rows are visible.';

COMMENT ON TABLE chunks IS
  'nyaya-guard chunks. Cross-tenant reads are impossible by construction: '
  'the application never writes a tenant predicate into its SQL, it sets a GUC.';

-- ---------------------------------------------------------------------------
-- Migration bookkeeping. Tiny on purpose: one row per applied schema version
-- plus a note, so a gradual re-embedding run (below) can be attributed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS store_migrations (
  version    text        PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  notes      text        NOT NULL DEFAULT ''
);

INSERT INTO store_migrations (version, notes)
VALUES ('v3.pgvector.rls', 'chunks + HNSW(cosine) + GIN(trgm) + FORCE RLS')
ON CONFLICT (version) DO UPDATE SET notes = EXCLUDED.notes;

-- ---------------------------------------------------------------------------
-- Gradual re-embedding, step 1 of 2: what is still on an old model?
-- The store exposes this as `reembedPendingSql()`; it is a view here so an
-- operator can also just look at it in psql:
--     SELECT * FROM chunks_needing_reembed WHERE model = 'hash-256-v1';
-- Step 2 is the re-embed job writing new rows with the new `model` value
-- (ON CONFLICT on the natural key) — see README "Migration notes".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW chunks_needing_reembed AS
SELECT tenant_id,
       model,
       count(*)::int AS chunks,
       min(created_at) AS oldest,
       max(updated_at) AS newest
FROM chunks
GROUP BY tenant_id, model;

COMMENT ON VIEW chunks_needing_reembed IS
  'Per-tenant embedding-model census. Rows whose model <> the current model '
  'are the re-embedding worklist; they keep serving lexical hits meanwhile.';

-- ---------------------------------------------------------------------------
-- Least-privilege role bootstrap. NOT executed by this file (creating roles
-- needs CREATEROLE and the migration may run as a non-superuser); run it once
-- as a superuser, then connect as this role:
--
--     CREATE ROLE nyaya_app LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS;
--     GRANT CONNECT ON DATABASE <db> TO nyaya_app;
--     GRANT USAGE ON SCHEMA public TO nyaya_app;
--     GRANT SELECT, INSERT, UPDATE, DELETE ON chunks TO nyaya_app;
--     GRANT SELECT ON chunks_needing_reembed TO nyaya_app;
--
-- The role must be NOSUPERUSER and must NOT have BYPASSRLS, otherwise
-- PostgreSQL skips row-level security entirely for it. `FORCE ROW LEVEL
-- SECURITY` above already covers the table owner; superuser is the one case
-- FORCE cannot cover.
-- ---------------------------------------------------------------------------

COMMIT;
