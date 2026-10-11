/**
 * Production sampler (v2): grows the golden set from real traffic.
 *
 * Reads logs/audit*.jsonl, picks unanswered / low-confidence queries
 * (refusals, NO-RULE, confidence < threshold — injection blocks excluded),
 * clusters near-duplicates by token Jaccard, and writes one proposal per
 * cluster to eval/proposed.json. A human reviews each proposal before
 * promoting it into eval/queries.json (weekly loop, see README).
 *
 * Run: `npm run sample` (or `npx tsx eval/sample.ts`).
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tokenize } from "../src/corpus.js";

export interface AuditRow {
  query_redacted?: string;
  confidence?: number;
  verdict?: string;
  rule_id?: string;
  blocked?: boolean;
}

export interface Proposal {
  id: string;
  query: string;
  count: number;
  avg_confidence: number;
  verdicts: string[];
  reason: string;
  status: "proposed";
  suggested_action: string;
}

export const LOW_CONFIDENCE_CUTOFF = 0.6;

function norm(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Unanswered = refused/no-rule/low-confidence. Injection blocks are attacks, not candidates. */
export function isCandidate(r: AuditRow): boolean {
  if (r.blocked) return false;
  if (r.rule_id === "NO-RULE") return true;
  if ((r.verdict ?? "").includes("refused")) return true;
  if (typeof r.confidence === "number" && r.confidence < LOW_CONFIDENCE_CUTOFF) return true;
  return false;
}

/** Greedy Jaccard clustering over token sets (threshold 0.35). */
export function clusterQueries(queries: string[]): string[][] {
  const sets = queries.map((q) => new Set(tokenize(q)));
  const clusters: { members: string[]; rep: Set<string> }[] = [];
  queries.forEach((q, i) => {
    const s = sets[i]!;
    let best = -1;
    let bestJ = 0;
    clusters.forEach((c, ci) => {
      const inter = [...s].filter((t) => c.rep.has(t)).length;
      const union = new Set([...s, ...c.rep]).size || 1;
      const j = inter / union;
      if (j > bestJ) {
        bestJ = j;
        best = ci;
      }
    });
    if (best >= 0 && bestJ >= 0.35) clusters[best]!.members.push(q);
    else clusters.push({ members: [q], rep: s });
  });
  return clusters.map((c) => c.members);
}

export function proposeCases(rows: AuditRow[]): Proposal[] {
  const cands = rows.filter(isCandidate);
  // Dedupe exact (normalised), keep frequency + avg confidence.
  const freq = new Map<string, { query: string; n: number; confSum: number; confN: number; verdicts: Set<string> }>();
  for (const r of cands) {
    const q = (r.query_redacted ?? "").trim();
    if (q.length < 2) continue;
    const k = norm(q);
    const e = freq.get(k) ?? { query: q, n: 0, confSum: 0, confN: 0, verdicts: new Set<string>() };
    if (q.length > e.query.length) e.query = q;
    e.n++;
    if (typeof r.confidence === "number") {
      e.confSum += r.confidence;
      e.confN++;
    }
    if (r.verdict) e.verdicts.add(r.verdict);
    freq.set(k, e);
  }
  const uniq = [...freq.values()];
  const clusters = clusterQueries(uniq.map((u) => u.query));
  return clusters.map((members, i) => {
    const inCluster = uniq.filter((u) => members.includes(u.query));
    const total = inCluster.reduce((s, u) => s + u.n, 0);
    const confSum = inCluster.reduce((s, u) => s + u.confSum, 0);
    const confN = inCluster.reduce((s, u) => s + u.confN, 0);
    const verdicts = [...new Set(inCluster.flatMap((u) => [...u.verdicts]))].sort();
    const rep = [...inCluster].sort((a, b) => b.n - a.n || b.query.length - a.query.length)[0]!;
    return {
      id: `P${String(i + 1).padStart(2, "0")}`,
      query: rep.query,
      count: total,
      avg_confidence: confN ? Math.round((confSum / confN) * 100) / 100 : 0,
      verdicts,
      reason: `unanswered/low-confidence cluster (${total} hit${total === 1 ? "" : "s"}): ${verdicts.join(", ") || "refused"}`,
      status: "proposed" as const,
      suggested_action: "human review: assign expectedScheme + attributes, then promote to eval/queries.json",
    };
  });
}

export function loadAuditRows(logsDir: string): AuditRow[] {
  let files: string[] = [];
  try {
    files = readdirSync(logsDir).filter((f) => f.startsWith("audit") && f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const rows: AuditRow[] = [];
  for (const f of files) {
    const lines = readFileSync(join(logsDir, f), "utf-8").split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        rows.push(JSON.parse(t) as AuditRow);
      } catch {
        // skip corrupt lines — sampler must never crash the loop
      }
    }
  }
  return rows;
}

function main(): void {
  const logsDir = join(process.cwd(), "logs");
  const outPath = join(process.cwd(), "eval", "proposed.json");
  const rows = loadAuditRows(logsDir);
  const proposals = proposeCases(rows);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ generated_from: "logs/audit*.jsonl", count: proposals.length, proposals }, null, 2) + "\n", "utf-8");
  console.log(`sampled rows=${rows.length} candidates=${rows.filter(isCandidate).length} clusters=${proposals.length} -> eval/proposed.json`);
  for (const p of proposals) console.log(`- ${p.id} (x${p.count}, conf ${p.avg_confidence}): ${p.query.slice(0, 100)}`);
}

const invoked = (process.argv[1] ?? "").replace(/\\/g, "/");
if (invoked.endsWith("eval/sample.ts") || invoked.endsWith("eval/sample.js")) {
  main();
}
