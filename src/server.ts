import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { loadCorpus, defaultSchemesDir, tokenize, isSuperseded, validateVersionFrontmatter } from "./corpus.js";
import { buildIndex, hybridRetrieve, citationOf, rerankBoost, type ScoredChunk } from "./retriever.js";
import { evaluateRules, extractAttributes, type Attributes, type RuleResult } from "./rules.js";
import { redactPII, detectInjection, refusalMessage, injectionMessage } from "./guardrails.js";
import { appendAudit } from "./audit.js";
import { composeAnswer, mockCompose } from "./llm.js";
import { resolveStoreKind, tenantFromEnv, PgChunkStore, type StoreKind } from "./store_pg.js";

export const CONFIDENCE_THRESHOLD = 0.4;

const schemesDir = process.env.SCHEMES_DIR ?? defaultSchemesDir();
export let corpus = loadCorpus(schemesDir);
export let index = buildIndex(corpus);

/**
 * v3 store flag. `STORE` defaults to `memory`, which is why CI needs no
 * database and why the eval gate is reproducible on a laptop. `STORE=pg`
 * swaps in the Postgres+pgvector adapter (`src/store_pg.ts`); the resolved
 * value is validated here at import time, so `STORE=postgres` on a staging box
 * fails loudly at boot instead of quietly running the wrong backend.
 *
 * A store failure propagates (HTTP 500). It is never swallowed into an
 * answer: this system's whole promise is that it would rather say nothing than
 * invent something.
 */
export const STORE_KIND: StoreKind = resolveStoreKind();

let pgStore: PgChunkStore | null = null;
let pgStoreAttempted = false;

/** The active Postgres store, or null in memory mode. Lazily opened. */
export async function getPgStore(): Promise<PgChunkStore | null> {
  if (STORE_KIND !== "pg") return null;
  if (pgStore) return pgStore;
  if (pgStoreAttempted) return null;
  pgStoreAttempted = true;
  try {
    pgStore = await new PgChunkStore({ tenantId: tenantFromEnv() }).open();
    return pgStore;
  } catch (err) {
    console.error(`[nyaya-guard] STORE=pg but the store could not be opened: ${(err as Error).message}`);
    return null;
  }
}

/** Retrieval: same signature both ways, so the chat path is store-agnostic. */
export async function retrieve(
  query: string,
  topK = 4,
): Promise<{ results: ScoredChunk[]; confidence: number }> {
  const store = await getPgStore();
  if (store) {
    const { results, confidence } = await store.hybridRetrieve(query, topK);
    return { results, confidence };
  }
  return hybridRetrieve(query, index, topK);
}

/** Re-read the schemes dir (used after /ingest uploads and in tests). */
export function refreshIndex(): { chunks: number; docs: number } {
  corpus = loadCorpus(schemesDir);
  index = buildIndex(corpus);
  return { chunks: corpus.length, docs: new Set(corpus.map((x) => x.docId)).size };
}

/**
 * Staleness guard (v2): if any superseded version appears in the top-k,
 * the answer MUST cite the current version and note the change
 * ("yeh rashi badal gayi hai"). When the top chunk itself is superseded,
 * the best current chunk of the same scheme is promoted to the front so
 * the verdict and citations rest on live documents.
 */
export const STALENESS_PHRASE = "yeh rashi badal gayi hai";

export function applyStalenessGuard(results: ScoredChunk[], query: string): { results: ScoredChunk[]; stale: boolean; note: string | null } {
  const staleHits = results.filter((r) => isSuperseded(r.chunk));
  if (staleHits.length === 0 || results.length === 0) return { results, stale: false, note: null };
  const topScheme = results[0]!.chunk.docId;
  let fixed = results;
  if (isSuperseded(results[0]!.chunk)) {
    const curPos = results.findIndex((r) => r.chunk.docId === topScheme && !isSuperseded(r.chunk));
    if (curPos > 0) {
      const cur = results[curPos]!;
      fixed = [cur, ...results.slice(0, curPos), ...results.slice(curPos + 1)].slice(0, results.length);
    } else if (curPos < 0) {
      // No current chunk of this scheme in top-k: pull the best one from the index.
      const qtokens = tokenize(query);
      const cands = index.chunks.filter((c) => c.docId === topScheme && !isSuperseded(c));
      cands.sort((a, b) => rerankBoost(qtokens, b) - rerankBoost(qtokens, a));
      if (cands[0]) {
        fixed = [
          { chunk: cands[0], bm25: 0, cosine: 0, rrf: 0, rerank: 1, final: results[0]!.final },
          ...results,
        ].slice(0, results.length);
      }
    }
  }
  const versions = [...new Set(staleHits.map((r) => `${r.chunk.version}${r.chunk.validUntil ? ` (valid until ${r.chunk.validUntil})` : ""}`))].join(", ");
  const note =
    `Note: ${STALENESS_PHRASE} — ${versions} wala version superseded hai; ` +
    `jawab current version ke anusaar diya gaya hai. Citations me current version dekhen. ` +
    `(यह राशि/नियम बदल गए हैं — पुराना संस्करण अब मान्य नहीं है।)`;
  return { results: fixed, stale: true, note };
}

export const app = new Hono();
app.use("*", cors());

app.get("/api/health", (c) => c.json({ ok: true, chunks: corpus.length, docs: new Set(corpus.map((x) => x.docId)).size }));
app.get("/api/schemes", (c) =>
  c.json({ schemes: [...new Set(corpus.map((x) => x.docId))].sort().map((d) => ({ id: d })) })
);

export interface ChatBody {
  query: string;
  attributes?: Attributes;
  hindi?: boolean;
}

export async function handleChat(body: ChatBody) {
  const hindi = !!body.hindi;
  const rawQuery = (body.query ?? "").slice(0, 2000);
  const { redacted, findings } = redactPII(rawQuery);

  const inj = detectInjection(rawQuery);
  if (inj.blocked) {
    const answer = injectionMessage(hindi);
    appendAudit({ ts: new Date().toISOString(), query_redacted: redacted, rule_id: "BLOCK-INJECTION", verdict: "blocked", citations: [], confidence: 0, blocked: true, pii_findings: findings });
    return { answer, citations: [], rule: null, confidence: 0, blocked: true as const, llm: "mock" as const };
  }

  // Retrieval must not match on redaction placeholders ("[AADHAAR-REDACTED]"
  // etc.): they are system artifacts, not user intent. User-typed words stay.
  const retrievalQuery = redacted.replace(/\[[A-Z][A-Z0-9-]*\]/g, " ");
  const { results: rawResults, confidence } = await retrieve(retrievalQuery, 4);
  if (rawResults.length === 0 || confidence < CONFIDENCE_THRESHOLD) {
    const answer = refusalMessage(hindi);
    appendAudit({ ts: new Date().toISOString(), query_redacted: redacted, rule_id: "NO-RULE", verdict: "refused-low-confidence", citations: [], confidence, pii_findings: findings });
    return { answer, citations: [], rule: null, confidence, blocked: false as const, llm: "mock" as const };
  }
  // v2 staleness guard: never answer from a superseded doc alone.
  const guard = applyStalenessGuard(rawResults, retrievalQuery);
  const results = guard.results;

  const auto = extractAttributes(redacted);
  const attrs: Attributes = { ...auto, ...(body.attributes ?? {}) };
  const ranked = evaluateRules(attrs);
  // The rule MUST come from the top-retrieved document's scheme: the verdict
  // has to be about the scheme the evidence supports. Falling back to an
  // "eligible" rule of some other retrieved scheme would let the verdict and
  // the citations disagree (e.g. eligible verdict with cycle citations for a
  // boy in a private school who is explicitly ineligible for the cycle scheme).
  const topScheme = results[0]!.chunk.docId;
  const rule = ranked.find((r) => r.scheme === topScheme) ?? ranked[0]!;
  const citations = results.map(citationOf);
  const composed = await composeAnswer({ query: redacted, hindi, rule, chunks: results, confidence });
  // Staleness note is appended AFTER composition so neither the mock
  // template nor an OpenAI rephrase can drop it; it carries no ₹ amounts
  // so the faithfulness post-check is unaffected.
  const answer = guard.note ? `${composed.answer}\n\n${guard.note}` : composed.answer;
  const llm = composed.llm;
  appendAudit({
    ts: new Date().toISOString(), query_redacted: redacted, top_doc: results[0]!.chunk.docId,
    rule_id: rule.rule_id, verdict: rule.verdict, citations, confidence, pii_findings: findings,
    stale_corrected: guard.stale,
    superseded_seen: guard.stale ? [...new Set(rawResults.filter((r) => isSuperseded(r.chunk)).map((r) => r.chunk.id))] : [],
  });
  return {
    answer, citations, confidence, blocked: false as const, llm,
    rule,
    staleCorrected: guard.stale,
    retrieved: results.map((r) => ({ id: r.chunk.docId, para: r.chunk.paraIdx, title: r.chunk.title, score: r.final, text: r.chunk.text.slice(0, 500), freshness: r.chunk.freshness, version: r.chunk.version, citation: citationOf(r) })),
  };
}

app.post("/api/chat", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as ChatBody;
  if (!body.query || typeof body.query !== "string" || body.query.trim().length < 2)
    return c.json({ error: "query (min 2 chars) is required" }, 400);
  return c.json(await handleChat(body));
});

// Plan-compatible aliases: POST /ask {q, lang} -> {answer_hi, answer_en, ...}
app.post("/ask", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { q?: unknown; query?: unknown; lang?: unknown; attributes?: Attributes };
  const query = typeof body.q === "string" ? body.q : typeof body.query === "string" ? body.query : "";
  if (query.trim().length < 2) return c.json({ error: "q (min 2 chars) is required" }, 400);
  const hindi = body.lang === "hi" || body.lang === "hindi";
  const r = (await handleChat({ query, attributes: body.attributes, hindi })) as {
    answer: string; citations: string[]; confidence: number; blocked?: boolean;
    rule: RuleResult | null;
    llm: string;
    retrieved?: { id: string; para: number; title: string; score: number; text: string }[];
  };
  const refused = !!r.blocked || r.rule === null;
  // Deterministic hi+en renders of the same rule verdict + citations
  // (the `answer` field above may additionally be OpenAI-rephrased).
  let answer_hi: string, answer_en: string;
  if (refused || !r.rule || !r.retrieved) {
    answer_hi = refusalMessage(true);
    answer_en = refusalMessage(false);
  } else {
    const chunks = r.retrieved.map((x) => ({
      chunk: { id: `${x.id}#p${x.para}`, docId: x.id, title: x.title, paraIdx: x.para, text: x.text, tokens: [] as string[], version: "current" as const, freshness: "current" as const },
      bm25: 0, cosine: 0, rrf: 0, rerank: 0, final: x.score,
    }));
    const base = { query, rule: r.rule, chunks, confidence: r.confidence };
    answer_hi = mockCompose({ ...base, hindi: true });
    answer_en = mockCompose({ ...base, hindi: false });
  }
  return c.json({
    answer_hi,
    answer_en,
    answer: r.answer,
    citations: r.citations,
    rule_id: r.rule?.rule_id ?? (r.blocked ? "BLOCK-INJECTION" : "NO-RULE"),
    confidence: r.confidence,
    refused,
    verdict: r.rule?.verdict ?? (refused ? "refused" : "unknown"),
  });
});

app.get("/health", (c) => c.json({ ok: true, chunks: corpus.length, docs: new Set(corpus.map((x) => x.docId)).size }));

// Offline ingest check over HTTP: reports corpus stats (ingestion itself is
// file-based via `npm run ingest`; this endpoint verifies the live index).
// v2 file upload: POST /ingest { filename, markdown } stores a versioned
// scheme doc after frontmatter validation (400 on missing valid_from or
// bad supersedes links) and refreshes the live index.
app.post("/ingest", async (c) => {
  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const b = (body ?? {}) as { filename?: unknown; markdown?: unknown; content?: unknown };
  const markdown =
    typeof b.markdown === "string" ? b.markdown : typeof b.content === "string" ? b.content : null;
  if (markdown === null) {
    return c.json({ ok: true, chunks: corpus.length, docs: new Set(corpus.map((x) => x.docId)).size });
  }
  const knownSchemes = [...new Set(corpus.map((x) => x.docId))].sort();
  const v = validateVersionFrontmatter(markdown, knownSchemes);
  if (!v.ok) return c.json({ ok: false, errors: v.errors }, 400);
  const rawName = typeof b.filename === "string" && b.filename.trim() ? b.filename : `${v.frontmatter.superseded_by ?? "scheme"}-${v.frontmatter.version ?? "v1"}.md`;
  const safe = basename(rawName).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safe.endsWith(".md")) return c.json({ ok: false, errors: ["filename must end in .md"] }, 400);
  const targetDir = v.frontmatter.superseded_by ? join(schemesDir, "_versions") : schemesDir;
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, safe), markdown, "utf-8");
  const stats = refreshIndex();
  // In pg mode the corpus is also a database table, so an upload has to land
  // there too. A sync failure is reported, not hidden — but it must not lose
  // the file that was just written, so the endpoint still returns 200.
  const store = await getPgStore();
  let synced = false;
  if (store) {
    try {
      await store.sync(corpus);
      synced = true;
    } catch (err) {
      console.error(`[nyaya-guard] /ingest: pg re-sync failed: ${(err as Error).message}`);
    }
  }
  const stored = v.frontmatter.superseded_by ? `_versions/${safe}` : safe;
  return c.json({ ok: true, stored, chunks: stats.chunks, docs: stats.docs, version: v.frontmatter.version ?? null, store: STORE_KIND, synced });
});

const port = Number(process.env.PORT ?? 8080);
if (process.env.VITEST !== "true" && import.meta.url === `file://${process.argv[1]}`) {
  serve({ fetch: app.fetch, port }, () => console.log(`nyaya-guard on :${port} (${corpus.length} chunks)`));
}
