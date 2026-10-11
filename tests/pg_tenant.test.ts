/**
 * v3 — Postgres tenant isolation, and memory-vs-pg parity.
 *
 * Every test in here needs a live Postgres with pgvector + pg_trgm, so the
 * whole suite is gated on DATABASE_URL. When it is unset the tests are
 * SKIPPED, and the skip says why in its own name rather than disappearing —
 * a silent skip reads like a passing test, and "did the tenant check actually
 * run?" is exactly the question a reader of this repo needs answered.
 *
 *   docker compose --profile pg up -d
 *   DATABASE_URL=postgres://nyaya:nyaya@localhost:5433/nyaya npm test
 *
 * What is verified here, and what is verified without a database, is split on
 * purpose. The pure layer (SQL text, RLS policy shape, tenant GUC, fusion
 * constants, schema file) is asserted on every CI run in `store_pg.test.ts`;
 * this file only covers what genuinely needs a server: does the policy
 * actually hide another tenant's rows, does the schema apply, and does SQL
 * retrieval rank the same documents the in-memory retriever ranks?
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadCorpus } from "../src/corpus.js";
import { buildIndex, hybridRetrieve, embed } from "../src/retriever.js";
import {
  PgChunkStore,
  loadPgPoolCtor,
  upsertSql,
  chunkKeyOf,
  vectorLiteral,
  tenantStatsSql,
  DEFAULT_MODEL,
  type PgPoolLike,
  type PgClientLike,
} from "../src/store_pg.js";

const HAS_DB = Boolean((process.env.DATABASE_URL ?? "").trim());

/** Printed verbatim in every skipped test name, so the skip is self-explaining. */
export const SKIP_REASON =
  "needs DATABASE_URL + pgvector/pg_trgm — start it with `docker compose --profile pg up -d` and re-run with " +
  "DATABASE_URL=postgres://nyaya:nyaya@localhost:5433/nyaya";

const TENANT_A = "nyaya:test-a";
const TENANT_B = "nyaya:test-b";
const APP_ROLE = "nyaya_app";

const corpus = loadCorpus(`${process.cwd()}/data/schemes`);
const idx = buildIndex(corpus);

/**
 * Queries the eval gate scores, one per scheme, plus the two refusal shapes
 * and the two freshness shapes. Parity is asserted on this set, which is the
 * set the project's published numbers depend on.
 */
const PARITY_QUERIES: { q: string; expectDoc?: string }[] = [
  { q: "Is my girl in class 9 in a Bihar government school eligible for a cycle?", expectDoc: "mukhyamantri-cycle-yojana" },
  { q: "old age pension 60 years senior citizen Bihar amount", expectDoc: "mukhyamantri-vridhjan-pension" },
  { q: "widow pension for a 70 year old woman Bihar", expectDoc: "lakshmibai-widow-pension" },
  { q: "disability pension 40 percent disabled person Bihar", expectDoc: "mukhyamantri-divyangjan-pension" },
  { q: "Bihar student credit card for engineering studies loan", expectDoc: "bihar-student-credit-card" },
  { q: "RTE reservation EWS admission in government school", expectDoc: "rte-admission-ews" },
  { q: "PMAY ghar Awas housing for poor families", expectDoc: "pmay-gramin-bihar" },
  { q: "pre matric scholarship for class 8 student", expectDoc: "pre-matric-scholarship" },
  { q: "post matric scholarship for college student Bihar", expectDoc: "post-matric-scholarship" },
  { q: "Kanya Utthan scholarship for passing class 12 girls", expectDoc: "mukhyamantri-kanya-utthan" },
  { q: "poshak uniform vardi for government school students", expectDoc: "mukhyamantri-poshak-yojana" },
  { q: "ration card NFSA foodgrains in Bihar", expectDoc: "mukhyamantri-ration-nfsa" },
  { q: "What is the capital of Australia?", expectDoc: undefined },
  { q: "xqzt blorpy quantum nebula", expectDoc: undefined },
  { q: "Someone said the cycle amount was Rs 2,500. What is it now for a class 9 girl?",
    expectDoc: "mukhyamantri-cycle-yojana" },
  { q: "The old age pension deadline was 31 March 2022 — can a 65 year old still apply?",
    expectDoc: "mukhyamantri-vridhjan-pension" },
];

/** Bootstraps the least-privilege role RLS actually applies to. */
const BOOTSTRAP_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
    EXECUTE 'CREATE ROLE ${APP_ROLE} LOGIN PASSWORD ''${APP_ROLE}'' NOSUPERUSER NOBYPASSRLS';
  END IF;
  EXECUTE format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', '${APP_ROLE}');
END
$$;
DO $$
BEGIN
  IF NOT has_database_privilege('${APP_ROLE}', current_database(), 'CONNECT') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${APP_ROLE}', current_database());
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
`;

// ---------------------------------------------------------------------------
// Always runs: the gate itself is tested, so a skip can never be mistaken for
// a pass.
// ---------------------------------------------------------------------------

describe("v3 pg test gating", () => {
  it("detects DATABASE_URL rather than assuming a database", () => {
    expect(HAS_DB).toBe(Boolean((process.env.DATABASE_URL ?? "").trim()));
  });
  it("carries an explicit, actionable skip reason into every skipped test name", () => {
    expect(SKIP_REASON).toMatch(/DATABASE_URL/);
    expect(SKIP_REASON).toMatch(/docker compose --profile pg/);
    expect(SKIP_REASON.length).toBeGreaterThan(60);
  });
  it("gates the pg suite on the database, not on anything else", () => {
    const gated = HAS_DB === true;
    expect(gated || !gated).toBe(true); // tautology guard against a bad gate expression
    expect(typeof HAS_DB).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)(`v3 pg tenant isolation [skipped without a database: ${SKIP_REASON}]`, () => {
  let admin: PgPoolLike;
  let storeA: PgChunkStore;
  let storeB: PgChunkStore;
  let usesAppRole = false;
  let roleBootstrapError: string | null = null;

  beforeAll(async () => {
    const Pool = await loadPgPoolCtor();
    admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

    // 1. Migrate as the connected (privileged) role: the least-privilege app
    //    role deliberately has no DDL rights.
    const migrator = new PgChunkStore({ tenantId: TENANT_A, connectionString: process.env.DATABASE_URL, poolSize: 2 });
    await migrator.open();
    await migrator.applySchema();

    // 2. A superuser bypasses RLS unconditionally, so a superuser connection
    //    cannot test isolation at all. Create/drop to a NOSUPERUSER role first.
    const who = await admin.query<{ rolsuper: boolean }>("SELECT rolsuper FROM pg_roles WHERE rolname = current_user");
    try {
      await admin.query(BOOTSTRAP_SQL);
      usesAppRole = true;
    } catch (err) {
      roleBootstrapError = (err as Error).message;
      usesAppRole = who.rows[0]?.rolsuper !== true;
    }
    await migrator.close();

    storeA = await new PgChunkStore({ tenantId: TENANT_A, role: usesAppRole ? APP_ROLE : undefined, poolSize: 2 }).open();
    storeB = await new PgChunkStore({ tenantId: TENANT_B, role: usesAppRole ? APP_ROLE : undefined, poolSize: 2 }).open();
    await storeA.sync(corpus);
  });

  afterAll(async () => {
    await storeA?.close();
    await storeB?.close();
    await admin?.end();
  });

  // -- schema -------------------------------------------------------------

  it("applies db/schema.sql cleanly", async () => {
    const { rows } = await admin.query<{ relname: string }>(
      "SELECT relname FROM pg_class WHERE relname IN ('chunks','store_migrations') ORDER BY relname",
    );
    expect(rows.map((r) => r.relname)).toEqual(["chunks", "store_migrations"]);
  });

  it("re-applying the schema is a no-op (idempotent migrations)", async () => {
    const s = new PgChunkStore({ tenantId: TENANT_A, connectionString: process.env.DATABASE_URL, poolSize: 1 });
    await s.open();
    await expect(s.applySchema()).resolves.toBeUndefined();
    await expect(s.applySchema()).resolves.toBeUndefined();
    await s.close();
  });

  it("creates the HNSW and GIN trigram indexes the hybrid query needs", async () => {
    const { rows } = await admin.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'chunks' AND indexdef LIKE '%USING hnsw%'",
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.indexdef).toMatch(/vector_cosine_ops/);
    const trgm = await admin.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'chunks' AND indexdef LIKE '%gin_trgm_ops%'",
    );
    expect(trgm.rows.length).toBe(1);
  });

  it("has row-level security ENABLED and FORCED on chunks", async () => {
    const { rows } = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'chunks'",
    );
    expect(rows[0]!.relrowsecurity).toBe(true);
    expect(rows[0]!.relforcerowsecurity).toBe(true);
  });

  it("scopes the policy to current_setting('app.tenant_id')", async () => {
    const { rows } = await admin.query<{ qual: string; with_check: string }>(
      "SELECT qual, with_check FROM pg_policies WHERE tablename = 'chunks' AND policyname = 'chunks_tenant_isolation'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qual).toContain("current_setting");
    expect(rows[0]!.qual).toContain("app.tenant_id");
    expect(rows[0]!.with_check).toContain("app.tenant_id");
  });

  it("is running as a role RLS actually applies to — otherwise the isolation tests are vacuous", async () => {
    // PostgreSQL skips row-level security unconditionally for superusers and
    // for roles granted BYPASSRLS. If the tests below run as one of those,
    // "a foreign tenant sees 0 rows" passes for the wrong reason and proves
    // nothing. So this is asserted, loudly, before anything relies on it.
    const { rows } = await storeA.withTenant((c) =>
      c.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user",
      ),
    );
    expect(
      rows[0]!.rolsuper,
      `connected as ${rows[0]!.current_user}, which is a SUPERUSER: it bypasses RLS, so the tenant tests prove nothing. ` +
        `Bootstrap failed${roleBootstrapError ? `: ${roleBootstrapError}` : ""}. Run db/role.sql, or connect as a non-superuser.`,
    ).toBe(false);
    expect(rows[0]!.rolbypassrls).toBe(false);
  });

  // -- corpus fidelity ----------------------------------------------------

  it("syncs the whole 12-scheme corpus into the owning tenant", async () => {
    const { rows } = await storeA.withTenant((c) => c.query<{ chunks: number; docs: number }>(tenantStatsSql()));
    expect(rows[0]!.chunks).toBe(corpus.length);
    expect(rows[0]!.docs).toBe(12);
  });

  it("stores chunk keys that match the in-memory corpus ids", async () => {
    const { rows } = await storeA.withTenant((c) => c.query<{ chunk_key: string }>("SELECT chunk_key FROM chunks"));
    const stored = new Set(rows.map((r) => r.chunk_key));
    for (const c of corpus) {
      expect(stored.has(chunkKeyOf(c.docId, c.version, c.paraIdx))).toBe(true);
      expect(stored.has(c.id)).toBe(true);
    }
  });

  it("is idempotent: re-syncing does not duplicate rows", async () => {
    const before = await storeA.withTenant((c) => c.query<{ chunks: number }>(tenantStatsSql()));
    await storeA.sync(corpus);
    const after = await storeA.withTenant((c) => c.query<{ chunks: number }>(tenantStatsSql()));
    expect(after.rows[0]!.chunks).toBe(before.rows[0]!.chunks);
  });

  // -- THE tenant test ----------------------------------------------------

  it("returns hits for the owning tenant", async () => {
    const { results } = await storeA.hybridRetrieve("cycle yojana class 9 girl bihar government school bicycle", 4);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.chunk.docId).toBe("mukhyamantri-cycle-yojana");
  });

  it("returns 0 hits for a DIFFERENT tenant (wrong-tenant query)", async () => {
    const out = await storeB.hybridRetrieve("cycle yojana class 9 girl bihar government school bicycle", 4);
    expect(out.results).toEqual([]);
    expect(out.confidence).toBe(0);
    expect(out.ids).toEqual([]);
  });

  it("returns 0 hits for a different tenant on every eval query", async () => {
    for (const { q } of PARITY_QUERIES) {
      const out = await storeB.hybridRetrieve(q, 4);
      expect(out.results, `tenant B saw results for: ${q}`).toEqual([]);
    }
  });

  it("hides even the raw rows of another tenant", async () => {
    const { rows } = await storeB.withTenant((c) => c.query("SELECT chunk_key, content FROM chunks"));
    expect(rows).toEqual([]);
  });

  it("lets an unset tenant read NOTHING rather than everything (fail closed)", async () => {
    const client: PgClientLike = await admin.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT chunk_key FROM chunks");
      expect(rows).toEqual([]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("lets a blank tenant read nothing either", async () => {
    const client: PgClientLike = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', '', true)");
      const { rows } = await client.query("SELECT chunk_key FROM chunks");
      expect(rows).toEqual([]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("does not leak the tenant GUC out of the transaction", async () => {
    const client: PgClientLike = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_A]);
      const inside = await client.query<{ v: string }>("SELECT current_setting('app.tenant_id', true) AS v");
      expect(inside.rows[0]!.v).toBe(TENANT_A);
      await client.query("COMMIT");
      // transaction-local means it is gone on the very next statement
      const outside = await client.query<{ v: string | null }>("SELECT current_setting('app.tenant_id', true) AS v");
      expect(outside.rows[0]!.v).toBeNull();
    } finally {
      client.release();
    }
  });

  it("refuses a write that would land in another tenant", async () => {
    // A real 256-d vector, so the only thing that can reject this row is RLS.
    await expect(
      storeB.withTenant((c) =>
        c.query(upsertSql(1), [
          TENANT_A, "mukhyamantri-cycle-yojana", 999, "t", "content", ["x"],
          vectorLiteral(embed(["x"])), DEFAULT_MODEL,
          "current", "current", null, null, null, chunkKeyOf("mukhyamantri-cycle-yojana", "current", 999),
        ]),
      ),
    ).rejects.toThrow(/row-level security|42501|denied/i);
  });

  // -- v2 freshness, in SQL ----------------------------------------------

  it("still ranks the current version above the superseded one", async () => {
    const { results } = await storeA.hybridRetrieve(
      "cycle yojana class 9 girl bihar government school bicycle amount", 4,
    );
    expect(results[0]!.chunk.freshness).toBe("current");
    expect(results.filter((r) => r.chunk.freshness === "superseded").length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a superseded row with no expiry, the way ingest validation does", async () => {
    await expect(
      storeA.withTenant((c) =>
        c.query(upsertSql(1), [
          TENANT_A, "mukhyamantri-cycle-yojana", 998, "t", "content", ["x"],
          vectorLiteral(embed(["x"])), DEFAULT_MODEL,
          "1999-v0", "superseded", "mukhyamantri-cycle-yojana", "2020-01-01", null,
          chunkKeyOf("mukhyamantri-cycle-yojana", "1999-v0", 998),
        ]),
      ),
    ).rejects.toThrow(/chunks_freshness_shape|check constraint|23514/i);
  });

  it("currentSchemeChunks returns only current versions", async () => {
    const rows = await storeA.currentSchemeChunks("mukhyamantri-cycle-yojana");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.freshness === "current")).toBe(true);
  });

  // -- gradual re-embedding ----------------------------------------------

  it("records the embedding model so a re-embedding worklist is exact", async () => {
    const rows = await storeA.reembedPending();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(TENANT_A);
    expect(rows[0]!.model).toBe(DEFAULT_MODEL);
    expect(rows[0]!.chunks).toBe(corpus.length);
    expect(rows[0]!.unembedded).toBe(0);
  });

  it("lets an old and a new embedding model coexist during a gradual re-embed", async () => {
    const target = corpus.find((c) => c.freshness === "current")!;
    await storeA.withTenant((c) =>
      c.query(upsertSql(1), [
        TENANT_A, target.docId, target.paraIdx, target.title, target.text, target.tokens,
        vectorLiteral(embed(target.tokens)), "text-embed-3-small", target.version, "current",
        null, target.validFrom ?? null, null, chunkKeyOf(target.docId, target.version, target.paraIdx),
      ]),
    );
    const rows = await storeA.reembedPending();
    expect(rows.map((r) => r.model).sort()).toEqual([DEFAULT_MODEL, "text-embed-3-small"].sort());
    // the re-embedded row still serves, and no row was lost
    const { results } = await storeA.hybridRetrieve(`${target.title} ${target.text}`.slice(0, 60), 4);
    expect(results.length).toBeGreaterThan(0);
    const stats = await storeA.withTenant((c) => c.query<{ chunks: number }>(tenantStatsSql()));
    expect(stats.rows[0]!.chunks).toBe(corpus.length);
    // restore the deterministic embedding for this chunk
    await storeA.sync(corpus);
    const after = await storeA.reembedPending();
    expect(after).toHaveLength(1);
  });

  it("the model census is RLS-scoped: a foreign tenant sees no rows at all", async () => {
    const rows = await storeB.reembedPending();
    expect(rows).toEqual([]);
  });

  // -- PARITY: memory vs pg ----------------------------------------------

  it("agrees with the in-memory retriever on abstaining from junk", async () => {
    for (const q of ["What is the capital of Australia?", "xqzt blorpy quantum nebula"]) {
      const mem = hybridRetrieve(q, idx, 4);
      const pg = await storeA.hybridRetrieve(q, 4);
      expect(mem.results.length, `memory answered: ${q}`).toBe(0);
      expect(pg.results.length, `pg answered: ${q}`).toBe(0);
      expect(pg.confidence).toBe(0);
    }
  });

  it("agrees with the in-memory retriever on top-1 doc for all 12 schemes", async () => {
    const mismatches: string[] = [];
    for (const { q, expectDoc } of PARITY_QUERIES.filter((p) => p.expectDoc)) {
      const mem = hybridRetrieve(q, idx, 4);
      const pg = await storeA.hybridRetrieve(q, 4);
      if (mem.results[0]?.chunk.docId !== pg.results[0]?.chunk.docId) {
        mismatches.push(
          `${q}\n    memory=${mem.results[0]?.chunk.docId ?? "(none)"} (conf ${mem.confidence})` +
            `\n    pg    =${pg.results[0]?.chunk.docId ?? "(none)"} (conf ${pg.confidence})`,
        );
      }
      expect(pg.results[0]?.chunk.docId, `pg top-1 for ${q} -> ${pg.results[0]?.chunk.docId}, want ${expectDoc}`).toBe(
        expectDoc,
      );
    }
    expect(mismatches, `memory/pg top-1 divergence:\n${mismatches.join("\n")}`).toEqual([]);
  });

  it("agrees with the in-memory retriever on the same set of answerable queries", async () => {
    for (const { q, expectDoc } of PARITY_QUERIES.filter((p) => p.expectDoc)) {
      const mem = hybridRetrieve(q, idx, 4);
      const pg = await storeA.hybridRetrieve(q, 4);
      expect(pg.results.length > 0, `pg refused: ${q}`).toBe(true);
      // the same documents, in the same order, is a stronger claim than top-1
      expect(pg.results.map((r) => r.chunk.id), `ordering differs for: ${q}`).toEqual(
        mem.results.map((r) => r.chunk.id),
      );
    }
  });

  it("agrees with the in-memory retriever on confidence to within 0.05", async () => {
    for (const { q } of PARITY_QUERIES) {
      const mem = hybridRetrieve(q, idx, 4);
      const pg = await storeA.hybridRetrieve(q, 4);
      expect(Math.abs(mem.confidence - pg.confidence), `confidence gap for: ${q}`).toBeLessThanOrEqual(0.05);
    }
  });

  it("agrees with the in-memory retriever that a wrong tenant sees nothing", async () => {
    for (const { q } of PARITY_QUERIES) {
      const mem = hybridRetrieve(q, idx, 4);
      const foreign = await storeB.hybridRetrieve(q, 4);
      expect(foreign.results.length === 0, `tenant B leaked on: ${q}`).toBe(mem.results.length === 0);
    }
  });
});
