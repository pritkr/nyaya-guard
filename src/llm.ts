import type { RuleResult } from "./rules.js";
import type { ScoredChunk } from "./retriever.js";
import { citationOf } from "./retriever.js";

/**
 * LLM SHELL. Default = deterministic mock template that can ONLY quote
 * retrieved chunks + rule reasons. Optional OpenAI-compatible rephrase:
 * set OPENAI_BASE_URL + OPENAI_API_KEY (+OPENAI_MODEL). Even then, the
 * final answer is post-checked: any ₹ amount not present in retrieved
 * chunks is stripped before returning.
 */

export interface ComposeInput {
  query: string;
  hindi: boolean;
  rule: RuleResult;
  chunks: ScoredChunk[];
  confidence: number;
}

export function extractAmounts(text: string): string[] {
  const m = text.match(/Rs\.?\s*[\d,]+(?:\.\d+)?/gi) ?? [];
  return m.map((x) => x.replace(/\s+/g, " ").trim().toLowerCase());
}

export function mockCompose(input: ComposeInput): string {
  const { hindi, rule, chunks, confidence } = input;
  const cites = chunks.map(citationOf).join(" ");
  const quoted = chunks
    .slice(0, 2)
    .map((c) => `> ${c.chunk.text.split("\n")[0]?.slice(0, 220)} ${citationOf(c)}`)
    .join("\n");
  const head =
    rule.verdict === "eligible"
      ? hindi
        ? "नियमों के अनुसार आप योग्य लगते हैं।"
        : "According to the rules, you appear eligible."
      : rule.verdict === "ineligible"
        ? hindi
          ? "नियमों के अनुसार आप योग्य नहीं हैं।"
          : "According to the rules, you are not eligible."
        : hindi
          ? "फैसले के लिए कुछ जानकारी और चाहिए।"
          : "I need a bit more information to decide.";
  const lines = [
    head,
    `Rule: ${rule.rule_id} · Scheme: ${rule.scheme} · Verdict: ${rule.verdict} · Confidence: ${confidence}`,
    ...rule.reasons.map((r) => `- ${r}`),
    ...(rule.missing.length ? [`Missing: ${rule.missing.join(", ")}`] : []),
    "",
    "Sources:",
    quoted,
    "",
    `Citations: ${cites}`,
  ];
  return lines.join("\n");
}

async function openAIRephrase(draft: string, hindi: boolean): Promise<string | null> {
  const base = process.env.OPENAI_BASE_URL;
  const key = process.env.OPENAI_API_KEY;
  if (!base || !key) return null;
  try {
    const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Rephrase the draft for a citizen in simple language" +
              (hindi ? " (Hindi + short English gloss)" : " (simple English)") +
              ". STRICT: do not add/change any amounts, dates, eligibility criteria, or citations. Keep every [doc §para] citation verbatim.",
          },
          { role: "user", content: draft },
        ],
      }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Post-check: strip any ₹ amount the rephrased text invented. */
export function stripInventedAmounts(rephrased: string, allowed: Set<string>): string {
  return rephrased.replace(/Rs\.?\s*[\d,]+(?:\.\d+)?/gi, (m) => {
    const k = m.replace(/\s+/g, " ").trim().toLowerCase();
    return allowed.has(k) ? m : "[amount-withheld: not in sources]";
  });
}

export async function composeAnswer(input: ComposeInput): Promise<{ answer: string; llm: "mock" | "openai" }> {
  const draft = mockCompose(input);
  const allowed = new Set<string>();
  for (const c of input.chunks) for (const a of extractAmounts(c.chunk.text)) allowed.add(a);
  for (const r of input.rule.reasons) for (const a of extractAmounts(r)) allowed.add(a);
  const re = await openAIRephrase(draft, input.hindi);
  if (!re) return { answer: draft, llm: "mock" };
  return { answer: stripInventedAmounts(re, allowed), llm: "openai" };
}
