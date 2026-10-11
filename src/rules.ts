/**
 * DETERMINISTIC RULE CORE.
 * Eligibility is decided ONLY here. The LLM shell (llm.ts) may rephrase
 * wording but may never change verdicts, amounts, or dates.
 */

export interface Attributes {
  age?: number;
  gender?: "female" | "male" | "other";
  domicile?: string; // e.g. "bihar"
  studentClass?: number; // 1..12
  schoolType?: "govt" | "aided" | "private";
  category?: "SC" | "ST" | "OBC" | "EBC" | "General" | "Minority";
  familyIncomeYearly?: number;
  maritalStatus?: "married" | "unmarried" | "widowed";
  disabilityPct?: number;
  houseless?: boolean;
  rationCard?: "AAY" | "PHH" | "none";
  passedClass12?: boolean;
  graduated?: boolean;
}

export type Verdict = "eligible" | "ineligible" | "needs-info";

export interface RuleResult {
  rule_id: string;
  scheme: string;
  verdict: Verdict;
  reasons: string[]; // deterministic, templated
  missing: string[]; // attributes needed when needs-info
}

interface RuleDef {
  rule_id: string;
  scheme: string;
  check: (a: Attributes) => RuleResult;
}

const isBihar = (a: Attributes) => (a.domicile ?? "").toLowerCase() === "bihar";

function need(a: Attributes, fields: (keyof Attributes)[], base: Omit<RuleResult, "missing" | "verdict"> & { verdict?: Verdict }): RuleResult | null {
  const missing = fields.filter((f) => a[f] === undefined || a[f] === null || a[f] === "");
  if (missing.length > 0) return { ...base, verdict: "needs-info", missing: missing.map(String) };
  return null;
}

export const RULES: RuleDef[] = [
  {
    rule_id: "R-CYCLE-01",
    scheme: "mukhyamantri-cycle-yojana",
    check: (a) => {
      const base = { rule_id: "R-CYCLE-01", scheme: "mukhyamantri-cycle-yojana", reasons: [] as string[] };
      const m = need(a, ["domicile", "gender", "studentClass", "schoolType"], base);
      if (m) return m;
      const reasons: string[] = [];
      if (!isBihar(a)) reasons.push("Requires Bihar domicile.");
      if (a.gender !== "female") reasons.push("Only girl students are covered.");
      if (a.studentClass !== 9) reasons.push("Only Class 9 enrolment is covered.");
      if (a.schoolType === "private") reasons.push("Private unaided schools are excluded.");
      if (reasons.length) return { ...base, verdict: "ineligible", reasons, missing: [] };
      return { ...base, verdict: "eligible", reasons: ["Girl student in Class 9 of a Bihar govt/aided school → Rs 3,000 cycle assistance via DBT."], missing: [] };
    },
  },
  {
    rule_id: "R-RATION-01",
    scheme: "mukhyamantri-ration-nfsa",
    check: (a) => {
      const base = { rule_id: "R-RATION-01", scheme: "mukhyamantri-ration-nfsa", reasons: [] as string[] };
      const m = need(a, ["domicile", "rationCard"], base);
      if (m) return m;
      if (!isBihar(a)) return { ...base, verdict: "ineligible", reasons: ["Requires Bihar domicile."], missing: [] };
      if (a.rationCard === "none") return { ...base, verdict: "ineligible", reasons: ["No NFSA ration card (AAY/PHH required)."], missing: [] };
      const ent = a.rationCard === "AAY" ? "35 kg/month per family" : "5 kg/person/month";
      return { ...base, verdict: "eligible", reasons: [`NFSA ${a.rationCard} card → ${ent}.`], missing: [] };
    },
  },
  {
    rule_id: "R-PENSION-OLD-01",
    scheme: "mukhyamantri-vridhjan-pension",
    check: (a) => {
      const base = { rule_id: "R-PENSION-OLD-01", scheme: "mukhyamantri-vridhjan-pension", reasons: [] as string[] };
      const m = need(a, ["domicile", "age"], base);
      if (m) return m;
      if (!isBihar(a)) return { ...base, verdict: "ineligible", reasons: ["Requires Bihar domicile."], missing: [] };
      if ((a.age ?? 0) < 60) return { ...base, verdict: "ineligible", reasons: [`Age ${a.age} < 60 years minimum.`], missing: [] };
      const amt = (a.age ?? 0) >= 80 ? "Rs 500/month" : "Rs 400/month";
      return { ...base, verdict: "eligible", reasons: [`Age ${a.age} meets 60+ criterion → ${amt} via DBT.`], missing: [] };
    },
  },
  {
    rule_id: "R-PENSION-WIDOW-01",
    scheme: "lakshmibai-widow-pension",
    check: (a) => {
      const base = { rule_id: "R-PENSION-WIDOW-01", scheme: "lakshmibai-widow-pension", reasons: [] as string[] };
      const m = need(a, ["domicile", "gender", "maritalStatus", "age"], base);
      if (m) return m;
      if (!isBihar(a)) return { ...base, verdict: "ineligible", reasons: ["Requires Bihar domicile."], missing: [] };
      if (a.maritalStatus !== "widowed") return { ...base, verdict: "ineligible", reasons: ["Only widowed applicants are covered."], missing: [] };
      if ((a.age ?? 0) < 18) return { ...base, verdict: "ineligible", reasons: ["Minimum age 18 years."], missing: [] };
      if (a.familyIncomeYearly !== undefined && a.familyIncomeYearly > 60000)
        return { ...base, verdict: "ineligible", reasons: ["Family income above Rs 60,000/year cap."], missing: [] };
      return { ...base, verdict: "eligible", reasons: ["Widow, 18+, Bihar domicile → Rs 400/month (Rs 500/month at 80+)."], missing: [] };
    },
  },
  {
    rule_id: "R-PENSION-DIS-01",
    scheme: "mukhyamantri-divyangjan-pension",
    check: (a) => {
      const base = { rule_id: "R-PENSION-DIS-01", scheme: "mukhyamantri-divyangjan-pension", reasons: [] as string[] };
      const m = need(a, ["domicile", "disabilityPct"], base);
      if (m) return m;
      if (!isBihar(a)) return { ...base, verdict: "ineligible", reasons: ["Requires Bihar domicile."], missing: [] };
      if ((a.disabilityPct ?? 0) < 40) return { ...base, verdict: "ineligible", reasons: [`Disability ${a.disabilityPct}% < 40% minimum (UDID).`], missing: [] };
      return { ...base, verdict: "eligible", reasons: [`Disability ${a.disabilityPct}% meets 40%+ criterion → Rs 400/month.`], missing: [] };
    },
  },
  {
    rule_id: "R-BSCC-01",
    scheme: "bihar-student-credit-card",
    check: (a) => {
      const base = { rule_id: "R-BSCC-01", scheme: "bihar-student-credit-card", reasons: [] as string[] };
      const m = need(a, ["domicile", "passedClass12", "age"], base);
      if (m) return m;
      if (!isBihar(a)) return { ...base, verdict: "ineligible", reasons: ["Requires Bihar domicile."], missing: [] };
      if (!a.passedClass12) return { ...base, verdict: "ineligible", reasons: ["Requires Class 12 pass."], missing: [] };
      if ((a.age ?? 0) > 25) return { ...base, verdict: "ineligible", reasons: [`Age ${a.age} > 25 year limit.`], missing: [] };
      return { ...base, verdict: "eligible", reasons: ["12th pass, Bihar domicile → loan up to Rs 4,00,000 (1% girls/divyang, 4% others)."], missing: [] };
    },
  },
  {
    rule_id: "R-RTE-01",
    scheme: "rte-admission-ews",
    check: (a) => {
      const base = { rule_id: "R-RTE-01", scheme: "rte-admission-ews", reasons: [] as string[] };
      const m = need(a, ["domicile", "age"], base);
      if (m) return m;
      if (!isBihar(a)) return { ...base, verdict: "ineligible", reasons: ["Requires Bihar domicile."], missing: [] };
      if ((a.age ?? 0) < 6 || (a.age ?? 0) > 14) return { ...base, verdict: "ineligible", reasons: [`Age ${a.age} outside 6-14 RTE band.`], missing: [] };
      if (a.familyIncomeYearly !== undefined && a.familyIncomeYearly > 200000)
        return { ...base, verdict: "ineligible", reasons: ["EWS income above Rs 2,00,000/year cap (DG categories may still apply)."], missing: [] };
      return { ...base, verdict: "eligible", reasons: ["Age 6-14, Bihar domicile → 25% RTE quota seat subject to EWS/DG proof."], missing: [] };
    },
  },
  {
    rule_id: "R-PMAY-01",
    scheme: "pmay-gramin-bihar",
    check: (a) => {
      const base = { rule_id: "R-PMAY-01", scheme: "pmay-gramin-bihar", reasons: [] as string[] };
      const m = need(a, ["domicile", "houseless"], base);
      if (m) return m;
      if (!isBihar(a)) return { ...base, verdict: "ineligible", reasons: ["Requires Bihar domicile."], missing: [] };
      if (!a.houseless) return { ...base, verdict: "ineligible", reasons: ["Only houseless / kutcha-house households on the SECC/Awaas+ waitlist."], missing: [] };
      return { ...base, verdict: "eligible", reasons: ["Houseless household on waitlist → Rs 1,20,000 + Rs 12,000 toilet + MGNREGA wages."], missing: [] };
    },
  },
  {
    rule_id: "R-PREMSC-01",
    scheme: "pre-matric-scholarship",
    check: (a) => {
      const base = { rule_id: "R-PREMSC-01", scheme: "pre-matric-scholarship", reasons: [] as string[] };
      const m = need(a, ["domicile", "studentClass"], base);
      if (m) return m;
      if (!isBihar(a)) return { ...base, verdict: "ineligible", reasons: ["Requires Bihar domicile."], missing: [] };
      if ((a.studentClass ?? 0) < 1 || (a.studentClass ?? 99) > 10)
        return { ...base, verdict: "ineligible", reasons: ["Only Classes 1-10 are covered."], missing: [] };
      if (a.familyIncomeYearly !== undefined && a.familyIncomeYearly > 250000)
        return { ...base, verdict: "ineligible", reasons: ["Family income above Rs 2,50,000/year cap."], missing: [] };
      return { ...base, verdict: "eligible", reasons: [`Class ${a.studentClass} student → pre-matric scholarship slab applies (income ≤ Rs 2,50,000).`], missing: [] };
    },
  },
  {
    rule_id: "R-POSTMSC-01",
    scheme: "post-matric-scholarship",
    check: (a) => {
      const base = { rule_id: "R-POSTMSC-01", scheme: "post-matric-scholarship", reasons: [] as string[] };
      const m = need(a, ["domicile", "studentClass", "passedClass12"], base);
      // post-matric = class 11+ ; accept studentClass>=11 OR passedClass12
      if (a.studentClass === undefined && a.passedClass12 === undefined)
        return { ...base, verdict: "needs-info", reasons: [], missing: ["studentClass"] };
      if (!isBihar(a) && a.domicile !== undefined) return { ...base, verdict: "ineligible", reasons: ["Requires Bihar domicile."], missing: [] };
      if (a.domicile === undefined) return { ...base, verdict: "needs-info", reasons: [], missing: ["domicile"] };
      const lvl = a.passedClass12 ? 12 : (a.studentClass ?? 0);
      if (lvl < 11) return { ...base, verdict: "ineligible", reasons: ["Post-matric starts at Class 11 (finish Class 10 first)."], missing: [] };
      if (a.familyIncomeYearly !== undefined && a.familyIncomeYearly > 300000)
        return { ...base, verdict: "ineligible", reasons: ["Family income above Rs 3,00,000/year state cap."], missing: [] };
      return { ...base, verdict: "eligible", reasons: ["Class 11+ student → maintenance Rs 3,800-13,500/year + fee reimbursement."], missing: [] };
    },
  },
  {
    rule_id: "R-MKUY-01",
    scheme: "mukhyamantri-kanya-utthan",
    check: (a) => {
      const base = { rule_id: "R-MKUY-01", scheme: "mukhyamantri-kanya-utthan", reasons: [] as string[] };
      const m = need(a, ["domicile", "gender"], base);
      if (m) return m;
      if (!isBihar(a)) return { ...base, verdict: "ineligible", reasons: ["Requires Bihar domicile."], missing: [] };
      if (a.gender !== "female") return { ...base, verdict: "ineligible", reasons: ["Only girl children are covered."], missing: [] };
      if (a.graduated && a.maritalStatus === "unmarried")
        return { ...base, verdict: "eligible", reasons: ["Unmarried graduate daughter → Rs 25,000 (part of Rs 50,000 lifetime total)."], missing: [] };
      return { ...base, verdict: "eligible", reasons: ["Girl child of Bihar → stage-wise benefits up to Rs 50,000 total (birth → graduation)."], missing: [] };
    },
  },
  {
    rule_id: "R-POSHAK-01",
    scheme: "mukhyamantri-poshak-yojana",
    check: (a) => {
      const base = { rule_id: "R-POSHAK-01", scheme: "mukhyamantri-poshak-yojana", reasons: [] as string[] };
      const m = need(a, ["domicile", "studentClass", "schoolType"], base);
      if (m) return m;
      if (!isBihar(a)) return { ...base, verdict: "ineligible", reasons: ["Requires Bihar domicile."], missing: [] };
      if (a.schoolType === "private") return { ...base, verdict: "ineligible", reasons: ["Private unaided schools excluded."], missing: [] };
      const c = a.studentClass ?? 0;
      if (c < 1 || c > 12) return { ...base, verdict: "ineligible", reasons: ["Only Classes 1-12 covered."], missing: [] };
      const amt = c >= 9 ? "Rs 1,500/year" : "Rs 1,200/year";
      return { ...base, verdict: "eligible", reasons: [`Class ${c} govt-school student → ${amt} uniform DBT.`], missing: [] };
    },
  },
];

/** Run all rules; return eligible first, then needs-info, then ineligible. */
export function evaluateRules(attrs: Attributes): RuleResult[] {
  const out = RULES.map((r) => {
    try {
      return r.check(attrs);
    } catch {
      return { rule_id: r.rule_id, scheme: r.scheme, verdict: "needs-info" as Verdict, reasons: [], missing: ["domicile"] };
    }
  });
  const rank = { eligible: 0, "needs-info": 1, ineligible: 2 } as const;
  return out.sort((a, b) => rank[a.verdict] - rank[b.verdict]);
}

/** Heuristic attribute extraction from free text (server convenience only). */
export function extractAttributes(query: string): Attributes {
  const q = query.toLowerCase();
  const a: Attributes = {};
  if (/\bbihar\b|बिहार/.test(q)) a.domicile = "bihar";
  if (/\b(girl|daughter|beti|ladki|kanya|female|widow)\b/.test(q)) a.gender = "female";
  else if (/\b(boy|son|male)\b/.test(q)) a.gender = "male";
  if (/\bwidow|vidhwa\b/.test(q)) a.maritalStatus = "widowed";
  if (/\bunmarried\b/.test(q)) a.maritalStatus = "unmarried";
  const age = q.match(/age\s*(\d{1,3})|(\d{1,3})\s*(years?\s*old|yrs?\s*old|saal)/);
  if (age) a.age = parseInt(age[1] ?? age[2] ?? "", 10);
  const cls = q.match(/class\s*(\d{1,2})|kaksha\s*(\d{1,2})/);
  if (cls) a.studentClass = parseInt(cls[1] ?? cls[2] ?? "", 10);
  if (/\b(private|nijee|pvt)\b/.test(q)) a.schoolType = "private";
  else if (/\b(govt|government|sarkari|aided)\b/.test(q)) a.schoolType = a.schoolType ?? "govt";
  if (/\b12th\s*pass|class 12|intermediate|passed 12/.test(q)) a.passedClass12 = true;
  if (/\bgraduat/.test(q)) { a.graduated = true; a.passedClass12 = true; }
  const inc = q.match(/rs\.?\s*([\d,]+)\s*(lakh|l|per year|\/year|yearly|annual)?/);
  if (inc) {
    let v = parseFloat((inc[1] ?? "").replace(/,/g, ""));
    if (/lakh/.test(inc[0])) v *= 100000;
    if (!Number.isNaN(v)) a.familyIncomeYearly = v;
  }
  const dis = q.match(/(\d{1,3})\s*%\s*disab/);
  if (dis) a.disabilityPct = parseInt(dis[1] ?? "", 10);
  else if (/\bdivyang|disabled|handicap/.test(q)) a.disabilityPct = 40;
  if (/\bhouseless|no house|kutcha|beghar\b/.test(q)) a.houseless = true;
  if (/\bpucca house|own.*house\b/.test(q)) a.houseless = false;
  return a;
}
