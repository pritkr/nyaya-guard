import { describe, it, expect, afterAll } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  loadCorpus,
  parseFrontmatter,
  validateVersionFrontmatter,
  isSuperseded,
} from "../src/corpus.js";
import { buildIndex, hybridRetrieve, citationOf, FRESHNESS_PENALTY } from "../src/retriever.js";
import { app, handleChat, applyStalenessGuard, refreshIndex, STALENESS_PHRASE } from "../src/server.js";
import { loadAuditRows, isCandidate, clusterQueries, proposeCases } from "../eval/sample.js";

process.env.VITEST = "true";
process.env.AUDIT_LOG = `${process.cwd()}/logs/audit-test.jsonl`;

const corpus = loadCorpus(`${process.cwd()}/data/schemes`);
const idx = buildIndex(corpus);
const schemesDir = `${process.cwd()}/data/schemes`;

describe("v2 versioned corpus", () => {
  it("keeps 12 live scheme docs", () => {
    expect(new Set(corpus.map((c) => c.docId)).size).toBe(12);
  });
  it("loads 2 superseded version chunks sharing live scheme ids", () => {
    const stale = corpus.filter((c) => c.freshness === "superseded");
    expect(stale.length).toBe(2);
    for (const c of stale) {
      expect(isSuperseded(c)).toBe(true);
      expect(["mukhyamantri-cycle-yojana", "mukhyamantri-vridhjan-pension"]).toContain(c.docId);
      expect(c.validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.version).not.toBe("current");
    }
  });
  it("parseFrontmatter extracts version tags", () => {
    const { frontmatter, body } = parseFrontmatter(corpus.length ? "---\nversion: 2021-v1\nsuperseded_by: x\nvalid_until: 2023-03-31\n---\n# T\n\n" + "y".repeat(30) : "");
    expect(frontmatter.version).toBe("2021-v1");
    expect(frontmatter.superseded_by).toBe("x");
    expect(body).toContain("# T");
  });
});

describe("v2 frontmatter validation", () => {
  const known = [...new Set(corpus.map((c) => c.docId))];
  it("rejects missing valid_from", () => {
    const v = validateVersionFrontmatter("---\nversion: v2\n---\n# T\n\n" + "z".repeat(30), known);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/valid_from/);
  });
  it("rejects missing frontmatter entirely", () => {
    const v = validateVersionFrontmatter("# No frontmatter\n\n" + "z".repeat(30), known);
    expect(v.ok).toBe(false);
  });
  it("rejects bad supersedes links", () => {
    const v = validateVersionFrontmatter(
      "---\nversion: v9\nstatus: superseded\nvalid_from: 2024-01-01\nvalid_until: 2024-12-31\nsuperseded_by: no-such-scheme\n---\n# T\n\n" + "z".repeat(30),
      known,
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/unknown scheme/);
  });
  it("rejects superseded versions missing valid_until", () => {
    const v = validateVersionFrontmatter(
      "---\nversion: v9\nstatus: superseded\nvalid_from: 2024-01-01\nsuperseded_by: mukhyamantri-cycle-yojana\n---\n# T\n\n" + "z".repeat(30),
      known,
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/valid_until/);
  });
  it("accepts a well-formed superseded version", () => {
    const v = validateVersionFrontmatter(
      "---\nversion: 2024-v9\nstatus: superseded\nvalid_from: 2024-01-01\nvalid_until: 2024-12-31\nsuperseded_by: mukhyamantri-cycle-yojana\n---\n# T\n\n" + "z".repeat(30),
      known,
    );
    expect(v.ok).toBe(true);
  });
});

describe("v2 freshness boost", () => {
  it("ranks current above superseded for the same scheme", () => {
    const { results } = hybridRetrieve("cycle yojana class 9 girl Bihar government school bicycle amount", idx, 4);
    const cycle = results.filter((r) => r.chunk.docId === "mukhyamantri-cycle-yojana");
    expect(cycle.length).toBeGreaterThanOrEqual(2);
    expect(cycle[0]!.chunk.freshness).toBe("current");
    expect(FRESHNESS_PENALTY).toBeGreaterThan(0);
  });
  it("keeps superseded docs retrievable but flagged", () => {
    const { results } = hybridRetrieve("cycle yojana class 9 girl Bihar government school bicycle amount", idx, 4);
    const stale = results.filter((r) => isSuperseded(r.chunk));
    expect(stale.length).toBeGreaterThanOrEqual(1);
    expect(citationOf(stale[0]!)).toMatch(/superseded/i);
    expect(citationOf(results.find((r) => !isSuperseded(r.chunk))!)).not.toMatch(/superseded/i);
  });
});

describe("v2 staleness guard", () => {
  it("promotes the current chunk when the top evidence is superseded", () => {
    const { results } = hybridRetrieve("cycle yojana class 9 girl Bihar government school bicycle amount", idx, 4);
    const cur = results.find((r) => !isSuperseded(r.chunk))!;
    const stale = results.find((r) => isSuperseded(r.chunk))!;
    const g = applyStalenessGuard([stale, cur], "cycle yojana amount");
    expect(g.stale).toBe(true);
    expect(g.results[0]!.chunk.freshness).toBe("current");
    expect(g.note).toContain(STALENESS_PHRASE);
  });
  it("old-amount question is answered from the current doc with a change note", async () => {
    const r = (await handleChat({
      query: "Someone told me cycle yojana gives Rs 2,500. What is the current amount for class 9 Bihar govt school girl?",
      attributes: { domicile: "bihar", gender: "female", studentClass: 9, schoolType: "govt" },
    })) as { answer: string; citations: string[]; retrieved: { freshness: string }[]; staleCorrected: boolean };
    expect(r.answer).toContain("Rs 3,000");
    expect(r.answer).toContain(STALENESS_PHRASE);
    expect(r.retrieved[0]!.freshness).toBe("current");
    expect(r.citations.some((c) => c.includes("mukhyamantri-cycle-yojana") && !/superseded/i.test(c))).toBe(true);
  });
  it("expired-date question cites the live pension doc, not the expired order", async () => {
    const r = (await handleChat({
      query: "Someone said the last date for old age pension was 31 March 2022 — can I still apply? Age 65 Bihar.",
      attributes: { domicile: "bihar", age: 65 },
    })) as { answer: string; retrieved: { freshness: string; id: string }[] };
    expect(r.retrieved[0]!.id).toBe("mukhyamantri-vridhjan-pension");
    expect(r.retrieved[0]!.freshness).toBe("current");
    expect(r.answer).toContain(STALENESS_PHRASE);
  });
});

describe("v2 /ingest upload", () => {
  it("stats path still works with an empty body", async () => {
    const res = await app.request("/ingest", { method: "POST" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean };
    expect(j.ok).toBe(true);
  });
  it("rejects markdown missing valid_from", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "x.md", markdown: "# No frontmatter\n\n" + "z".repeat(30) }),
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { errors: string[] };
    expect(j.errors.join(" ")).toMatch(/valid_from|frontmatter/);
  });
  it("rejects bad supersedes links", async () => {
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "bad.md",
        markdown: "---\nversion: v1\nstatus: superseded\nvalid_from: 2024-01-01\nvalid_until: 2024-06-01\nsuperseded_by: ghost-scheme\n---\n# T\n\n" + "z".repeat(30),
      }),
    });
    expect(res.status).toBe(400);
  });
  it("accepts, stores, then cleans up a valid versioned upload", async () => {
    const name = "__test-upload-2024-v9.md";
    const target = join(schemesDir, "_versions", name);
    if (existsSync(target)) unlinkSync(target);
    const res = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: name,
        markdown:
          "---\nversion: 2024-v9\nstatus: superseded\nvalid_from: 2024-01-01\nvalid_until: 2024-12-31\nsuperseded_by: mukhyamantri-cycle-yojana\n---\n# Test upload (superseded cycle wording)\n\n" +
          "Girl student class 9 Bihar government school cycle yojana test upload paragraph with plenty of words. ".repeat(3),
      }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; stored: string };
    expect(j.ok).toBe(true);
    expect(existsSync(target)).toBe(true);
    unlinkSync(target);
    refreshIndex();
    expect(existsSync(target)).toBe(false);
  });
  afterAll(() => {
    const target = join(schemesDir, "_versions", "__test-upload-2024-v9.md");
    if (existsSync(target)) {
      unlinkSync(target);
      refreshIndex();
    }
  });
});

describe("v2 production sampler", () => {
  it("flags refusals/low-confidence but skips injection blocks", () => {
    expect(isCandidate({ rule_id: "NO-RULE", confidence: 0 })).toBe(true);
    expect(isCandidate({ verdict: "refused-low-confidence", confidence: 0 })).toBe(true);
    expect(isCandidate({ confidence: 0.2 })).toBe(true);
    expect(isCandidate({ blocked: true, confidence: 0 })).toBe(false);
    expect(isCandidate({ rule_id: "R-CYCLE-01", verdict: "eligible", confidence: 1 })).toBe(false);
  });
  it("clusters near-duplicate queries", () => {
    const clusters = clusterQueries([
      "what is the capital of australia",
      "what is the capital of australia?",
      "spacex starship launch dates ticket price",
    ]);
    expect(clusters.length).toBe(2);
  });
  it("proposes cases from audit rows", () => {
    const out = proposeCases([
      { query_redacted: "what is the capital of australia", confidence: 0, rule_id: "NO-RULE", verdict: "refused-low-confidence" },
      { query_redacted: "what is the capital of australia?", confidence: 0, rule_id: "NO-RULE", verdict: "refused-low-confidence" },
      { query_redacted: "cycle yojana class 9", confidence: 1, rule_id: "R-CYCLE-01", verdict: "eligible" },
    ]);
    expect(out.length).toBe(1);
    expect(out[0]!.count).toBe(2);
    expect(out[0]!.status).toBe("proposed");
  });
  it("finds real candidates in the existing logs", () => {
    const rows = loadAuditRows(`${process.cwd()}/logs`);
    expect(rows.length).toBeGreaterThan(0);
    const proposals = proposeCases(rows);
    expect(proposals.length).toBeGreaterThan(0);
  });
});
