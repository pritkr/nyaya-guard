import { tokenize, isSuperseded, type Chunk } from "./corpus.js";

export interface ScoredChunk {
  chunk: Chunk;
  bm25: number;
  cosine: number;
  rrf: number;
  rerank: number;
  final: number;
}

export const EMBED_DIM = 256;

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % EMBED_DIM;
}

/** Deterministic hash embedding: no API key, no network. */
export function embed(tokens: string[], dim = EMBED_DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const t of tokens) v[hashToken(t)] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export interface RetrieverIndex {
  chunks: Chunk[];
  docFreq: Map<string, number>;
  avgLen: number;
  embeddings: number[][];
}

export function buildIndex(chunks: Chunk[]): RetrieverIndex {
  const docFreq = new Map<string, number>();
  let totalLen = 0;
  for (const c of chunks) {
    totalLen += c.tokens.length;
    for (const t of new Set(c.tokens)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  return { chunks, docFreq, avgLen: totalLen / Math.max(1, chunks.length), embeddings: chunks.map((c) => embed(c.tokens)) };
}

function bm25Score(queryTokens: string[], chunk: Chunk, idx: RetrieverIndex, k1 = 1.5, b = 0.75): number {
  const N = idx.chunks.length;
  const tf = new Map<string, number>();
  for (const t of chunk.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  let score = 0;
  for (const q of new Set(queryTokens)) {
    const f = tf.get(q) ?? 0;
    if (!f) continue;
    const df = idx.docFreq.get(q) ?? 1;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * chunk.tokens.length) / idx.avgLen)));
  }
  return score;
}

function rrfRankFused(rankedLists: string[][], k = 60): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of rankedLists) {
    list.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return fused;
}

/**
 * Rerank stub: small deterministic boost for query-term coverage
 * (placeholder where a cross-encoder would go; kept local + free).
 */
export function rerankBoost(queryTokens: string[], chunk: Chunk): number {
  const set = new Set(chunk.tokens);
  const q = new Set(queryTokens);
  if (q.size === 0) return 0;
  let hit = 0;
  for (const t of q) if (set.has(t)) hit++;
  return hit / q.size; // 0..1 coverage
}

/**
 * Scheme aliases: distinctive single tokens that name a scheme outright
 * ("cycle", "uniform", "widow", "RTE"...). A query that names a scheme is
 * near-certainly about that scheme, so its chunks get a fixed score boost.
 * Shared words ("yojana", "pension", "Bihar", "school") are deliberately
 * NOT aliases — they cannot discriminate between schemes.
 */
const SCHEME_ALIASES: { scheme: string; tokens: string[]; phrases: string[] }[] = [
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

const ALIAS_BOOST = 0.25;

/**
 * Freshness boost (v2): current-version chunks outrank superseded chunks
 * with otherwise equal lexical/semantic scores. Superseded chunks stay
 * retrievable (transparency) but carry the penalty below and are flagged
 * via `chunk.freshness === "superseded"` + versioned citations.
 */
export const FRESHNESS_PENALTY = 0.3;

export function freshnessPenalty(chunk: Chunk): number {
  return isSuperseded(chunk) ? FRESHNESS_PENALTY : 0;
}

function aliasBoost(query: string, qtokens: string[], docId: string): number {
  const q = query.toLowerCase();
  const set = new Set(qtokens);
  for (const s of SCHEME_ALIASES) {
    if (s.scheme !== docId) continue;
    if (s.tokens.some((t) => set.has(t))) return ALIAS_BOOST;
    if (s.phrases.some((p) => q.includes(p))) return ALIAS_BOOST;
  }
  return 0;
}

/**
 * Grounding gate: at least 2 distinct query terms must lexically match the
 * top chunk, unless the query is so short that ≥50% of its terms match
 * (e.g. "Pension?"). A single coincidental token (a year like "2011", a
 * stray word) in a long off-topic question is not evidence — abstain.
 */
function isGrounded(qtokens: string[], top: ScoredChunk): boolean {
  const set = new Set(top.chunk.tokens);
  const matched = new Set(qtokens.filter((t) => set.has(t)));
  return matched.size >= 2 || top.rerank >= 0.5;
}

export function hybridRetrieve(query: string, idx: RetrieverIndex, topK = 4): { results: ScoredChunk[]; confidence: number } {
  const qtokens = tokenize(query);
  if (qtokens.length === 0 || idx.chunks.length === 0) return { results: [], confidence: 0 };

  const qvec = embed(qtokens);
  const bm25 = idx.chunks.map((c) => ({ id: c.id, s: bm25Score(qtokens, c, idx) }));
  const cos = idx.chunks.map((c, i) => ({ id: c.id, s: cosine(qvec, idx.embeddings[i]!) }));
  const byBm25 = [...bm25].sort((a, b) => b.s - a.s).map((x) => x.id);
  const byCos = [...cos].sort((a, b) => b.s - a.s).map((x) => x.id);
  const fused = rrfRankFused([byBm25, byCos]);

  const maxFused = Math.max(0.0001, ...fused.values());
  const scored: ScoredChunk[] = idx.chunks.map((c, i) => {
    const b = bm25[i]!.s;
    const co = cos[i]!.s;
    const r = (fused.get(c.id) ?? 0) / maxFused; // normalised 0..1
    const rr = rerankBoost(qtokens, c);
    const ab = aliasBoost(query, qtokens, c.docId);
    return { chunk: c, bm25: b, cosine: co, rrf: r, rerank: rr, final: Math.min(1, Math.max(0, 0.6 * r + 0.4 * rr + ab - freshnessPenalty(c))) };
  });
  scored.sort((a, b) => b.final - a.final);
  const top = scored[0]!;
  if (!isGrounded(qtokens, top)) return { results: [], confidence: 0 };
  const results = scored.slice(0, topK);
  const confidence = results.length ? Math.min(1, Math.max(0, results[0]!.final)) : 0;
  return { results, confidence: round2(confidence) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function citationOf(s: ScoredChunk): string {
  if (isSuperseded(s.chunk)) return `[${s.chunk.docId} §p${s.chunk.paraIdx} @${s.chunk.version} superseded]`;
  return `[${s.chunk.docId} §p${s.chunk.paraIdx}]`;
}

/** True when a citation string points at a superseded version. */
export function isSupersededCitation(cite: string): boolean {
  return /superseded/i.test(cite);
}
