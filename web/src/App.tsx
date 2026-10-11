import { useState } from "react";

interface Rule { rule_id: string; scheme: string; verdict: string; reasons: string[]; missing: string[] }
interface Retrieved { id: string; para: number; title: string; score: number; text: string }
interface Resp { answer: string; citations: string[]; confidence: number; blocked: boolean; rule: Rule | null; retrieved?: Retrieved[] }

export default function App() {
  const [q, setQ] = useState("My daughter is in class 9 in a Bihar government school. Cycle?");
  const [hindi, setHindi] = useState(false);
  const [resp, setResp] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);

  async function ask() {
    setLoading(true);
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q, hindi }),
      });
      setResp(await r.json());
    } catch (e) {
      setResp({ answer: String(e), citations: [], confidence: 0, blocked: false, rule: null });
    } finally {
      setLoading(false);
    }
  }

  const conf = resp ? Math.round(resp.confidence * 100) : 0;
  const verdictColor = !resp?.rule ? "#666" : resp.rule.verdict === "eligible" ? "#137333" : resp.rule.verdict === "ineligible" ? "#b3261e" : "#b06000";

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 760, margin: "0 auto", padding: 20 }}>
      <h1>Nyaya-Guard ⚖️</h1>
      <p style={{ color: "#444" }}>
        Hallucination-proof Bihar welfare helpdesk. Rules decide eligibility — the LLM only rephrases.
        Below 40% retrieval confidence it says <i>"I don't know — ask a sahayak"</i> instead of guessing.
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, padding: 10, fontSize: 15 }}
          placeholder="e.g. cycle yojana class 9…" onKeyDown={(e) => e.key === "Enter" && ask()} />
        <button onClick={ask} disabled={loading} style={{ padding: "10px 18px" }}>{loading ? "…" : hindi ? "पूछें" : "Ask"}</button>
      </div>
      <label style={{ display: "block", marginTop: 8 }}>
        <input type="checkbox" checked={hindi} onChange={(e) => setHindi(e.target.checked)} /> हिन्दी उत्तर (Hindi reply)
      </label>
      {resp && (
        <div style={{ marginTop: 16, border: "1px solid #ddd", borderRadius: 8, padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span>Confidence</span>
            <div style={{ flex: 1, height: 10, background: "#eee", borderRadius: 5 }}>
              <div style={{ width: `${conf}%`, height: "100%", borderRadius: 5, background: conf >= 40 ? "#137333" : "#b3261e" }} />
            </div>
            <b>{conf}%</b>
          </div>
          {resp.rule && (
            <div style={{ marginTop: 10, fontSize: 14 }}>
              <span style={{ background: verdictColor, color: "#fff", padding: "2px 8px", borderRadius: 4 }}>{resp.rule.verdict}</span>{" "}
              <code>{resp.rule.rule_id}</code> · {resp.rule.scheme}
              <ul>{resp.rule.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
              {resp.rule.missing.length > 0 && <p>Missing: {resp.rule.missing.join(", ")}</p>}
            </div>
          )}
          <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: 12, borderRadius: 6 }}>{resp.answer}</pre>
          {resp.citations.length > 0 && <p>Citations: {resp.citations.map((c) => <code key={c} style={{ marginRight: 6 }}>{c}</code>)}</p>}
          {resp.retrieved?.map((r) => (
            <details key={r.id + r.para}><summary>{r.id} §p{r.para} (score {r.score.toFixed(2)})</summary><p>{r.text}</p></details>
          ))}
        </div>
      )}
    </div>
  );
}
