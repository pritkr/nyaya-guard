import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { handleChat } from "../src/server.js";
import { extractAmounts } from "../src/llm.js";

process.env.VITEST = "true";
process.env.AUDIT_LOG = `${process.cwd()}/logs/audit-eval.jsonl`;

interface Q {
  id: string; query: string; expectedScheme: string | null;
  attributes: Record<string, unknown>; expectRefusal: boolean;
  refusalKind?: string; expectPIIRedacted?: boolean; expectVerdict?: string; hindi?: boolean;
  freshness?: { mustContain?: string[]; topMustBeCurrent?: boolean };
}

const spec = JSON.parse(readFileSync(`${process.cwd()}/eval/queries.json`, "utf-8")) as {
  thresholds: Record<string, number>; queries: Q[];
};

let correctTop1 = 0, citedOk = 0, faithful = 0, refusalsOk = 0, graded = 0, refusalTotal = 0, freshOk = 0, freshTotal = 0;
const rows: string[] = ["| id | expected | top_doc | verdict | conf | refusal_ok | cite_ok | faithful | fresh_ok |", "|---|---|---|---|---|---|---|---|---|"];

for (const q of spec.queries) {
  const r = (await handleChat({ query: q.query, attributes: q.attributes as never, hindi: q.hindi })) as {
    answer: string; citations: string[]; confidence: number; blocked?: boolean;
    rule: { rule_id: string; scheme: string; verdict: string } | null;
    retrieved?: { id: string; text: string; freshness?: string; citation?: string }[];
    staleCorrected?: boolean;
  };
  const refused = !!r.blocked || r.rule === null || /i don't know|मुझे नहीं पता/i.test(r.answer);
  const topDoc = r.retrieved?.[0]?.id ?? (r.rule?.scheme ?? "-");

  if (q.expectRefusal) {
    refusalTotal++;
    const ok = refused ? 1 : 0;
    refusalsOk += ok;
    rows.push(`| ${q.id} | refusal(${q.refusalKind}) | ${topDoc} | ${r.rule?.verdict ?? "refused"} | ${r.confidence} | ${ok} | - | - |`);
    continue;
  }
  graded++;
  const topOk = topDoc === q.expectedScheme || r.rule?.scheme === q.expectedScheme ? 1 : 0;
  correctTop1 += topOk;
  const citeOk = r.citations.some((c) => c.includes(q.expectedScheme!)) ? 1 : 0;
  citedOk += citeOk;
  // faithfulness: every ₹ amount in answer must appear in retrieved chunk texts
  const corpusText = (r.retrieved ?? []).map((x) => x.text).join("\n").toLowerCase();
  let f = 1;
  for (const a of extractAmounts(r.answer)) {
    const norm = a.replace(/\s+/g, "");
    if (!corpusText.replace(/\s+/g, "").includes(norm)) { f = 0; break; }
  }
  if (q.expectVerdict && r.rule?.verdict !== q.expectVerdict) f = 0;
  if (q.expectPIIRedacted && (/1234\s?5678|9876543210/.test(r.answer))) f = 0;
  // v2 freshness: current version must win + answer must carry current facts + change note
  let fresh = "-";
  if (q.freshness) {
    freshTotal++;
    let fok = 1;
    const ans = r.answer.toLowerCase();
    for (const need of q.freshness.mustContain ?? []) {
      if (!ans.includes(need.toLowerCase())) { fok = 0; break; }
    }
    if (q.freshness.topMustBeCurrent && r.retrieved?.[0]?.freshness === "superseded") fok = 0;
    // citations must include a CURRENT (non-superseded) cite of the expected scheme
    if (fok && q.freshness.topMustBeCurrent) {
      const hasCurrentCite = r.citations.some((c) => c.includes(q.expectedScheme!) && !/superseded/i.test(c));
      if (!hasCurrentCite) fok = 0;
    }
    freshOk += fok;
    fresh = String(fok);
    if (!fok) f = 0;
  }
  faithful += f;
  rows.push(`| ${q.id} | ${q.expectedScheme} | ${topDoc} | ${r.rule?.verdict} | ${r.confidence} | - | ${citeOk} | ${f} | ${fresh} |`);
}

const accuracy = correctTop1 / graded;
const citePrec = citedOk / graded;
const faith = faithful / graded;
const refRecall = refusalsOk / refusalTotal;
const freshRate = freshTotal ? freshOk / freshTotal : 1;
const table = rows.join("\n");
console.log(table);
console.log(`\naccuracy(top1)=${accuracy.toFixed(3)} citation_precision=${citePrec.toFixed(3)} faithfulness=${faith.toFixed(3)} refusal_recall=${refRecall.toFixed(3)} freshness=${freshRate.toFixed(3)} (${freshOk}/${freshTotal})`);
mkdirSync(`${process.cwd()}/eval/results`, { recursive: true });
writeFileSync(`${process.cwd()}/eval/results/last-run.md`, table + `\n\naccuracy=${accuracy.toFixed(3)} citation_precision=${citePrec.toFixed(3)} faithfulness=${faith.toFixed(3)} refusal_recall=${refRecall.toFixed(3)}\n`);

const t = spec.thresholds;
const pass = accuracy >= t.minAccuracy! && citePrec >= t.minCitationPrecision! && faith >= t.minFaithfulness! && refRecall >= t.minRefusalRecall!;
console.log(pass ? "EVAL GATE: PASS" : "EVAL GATE: FAIL");
process.exit(pass ? 0 : 1);
