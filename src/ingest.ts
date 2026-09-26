import { loadCorpus, defaultSchemesDir } from "./corpus.js";
import { buildIndex } from "./retriever.js";

/** Offline ingest check: loads corpus, builds index, prints stats. */
const dir = process.env.SCHEMES_DIR ?? defaultSchemesDir();
const corpus = loadCorpus(dir);
const idx = buildIndex(corpus);
console.log(`docs=${new Set(corpus.map((c) => c.docId)).size} chunks=${corpus.length} avgLen=${idx.avgLen.toFixed(1)}`);
