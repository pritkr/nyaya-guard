import { describe, it, expect } from "vitest";
import { evaluateRules, extractAttributes } from "../src/rules.js";

describe("rules: cycle yojana", () => {
  it("eligible girl in class 9 govt school", () => {
    const r = evaluateRules({ domicile: "bihar", gender: "female", studentClass: 9, schoolType: "govt" });
    const hit = r.find((x) => x.rule_id === "R-CYCLE-01")!;
    expect(hit.verdict).toBe("eligible");
  });
  it("boy is ineligible", () => {
    const hit = evaluateRules({ domicile: "bihar", gender: "male", studentClass: 9, schoolType: "govt" }).find((x) => x.rule_id === "R-CYCLE-01")!;
    expect(hit.verdict).toBe("ineligible");
  });
  it("private school is ineligible", () => {
    const hit = evaluateRules({ domicile: "bihar", gender: "female", studentClass: 9, schoolType: "private" }).find((x) => x.rule_id === "R-CYCLE-01")!;
    expect(hit.verdict).toBe("ineligible");
  });
  it("missing attrs -> needs-info", () => {
    const hit = evaluateRules({}).find((x) => x.rule_id === "R-CYCLE-01")!;
    expect(hit.verdict).toBe("needs-info");
    expect(hit.missing.length).toBeGreaterThan(0);
  });
});

describe("rules: pensions", () => {
  it("65yo eligible, 30yo not", () => {
    const ok = evaluateRules({ domicile: "bihar", age: 65 }).find((x) => x.rule_id === "R-PENSION-OLD-01")!;
    const no = evaluateRules({ domicile: "bihar", age: 30 }).find((x) => x.rule_id === "R-PENSION-OLD-01")!;
    expect(ok.verdict).toBe("eligible");
    expect(no.verdict).toBe("ineligible");
  });
  it("widow eligible; non-widow not", () => {
    const ok = evaluateRules({ domicile: "bihar", gender: "female", maritalStatus: "widowed", age: 40 }).find((x) => x.rule_id === "R-PENSION-WIDOW-01")!;
    expect(ok.verdict).toBe("eligible");
    const no = evaluateRules({ domicile: "bihar", gender: "female", maritalStatus: "married", age: 40 }).find((x) => x.rule_id === "R-PENSION-WIDOW-01")!;
    expect(no.verdict).toBe("ineligible");
  });
  it("disability threshold 40%", () => {
    const ok = evaluateRules({ domicile: "bihar", disabilityPct: 50 }).find((x) => x.rule_id === "R-PENSION-DIS-01")!;
    const no = evaluateRules({ domicile: "bihar", disabilityPct: 20 }).find((x) => x.rule_id === "R-PENSION-DIS-01")!;
    expect(ok.verdict).toBe("eligible");
    expect(no.verdict).toBe("ineligible");
  });
  it("non-bihar domicile ineligible", () => {
    const no = evaluateRules({ domicile: "up", age: 70 }).find((x) => x.rule_id === "R-PENSION-OLD-01")!;
    expect(no.verdict).toBe("ineligible");
  });
});

describe("rules: education & housing", () => {
  it("BSCC needs 12th pass", () => {
    const no = evaluateRules({ domicile: "bihar", passedClass12: false, age: 19 }).find((x) => x.rule_id === "R-BSCC-01")!;
    expect(no.verdict).toBe("ineligible");
  });
  it("RTE age band 6-14", () => {
    const ok = evaluateRules({ domicile: "bihar", age: 7 }).find((x) => x.rule_id === "R-RTE-01")!;
    const no = evaluateRules({ domicile: "bihar", age: 20 }).find((x) => x.rule_id === "R-RTE-01")!;
    expect(ok.verdict).toBe("eligible");
    expect(no.verdict).toBe("ineligible");
  });
  it("PMAY needs houseless", () => {
    const no = evaluateRules({ domicile: "bihar", houseless: false }).find((x) => x.rule_id === "R-PMAY-01")!;
    expect(no.verdict).toBe("ineligible");
  });
  it("extractAttributes pulls class/age/bihar", () => {
    const a = extractAttributes("My daughter age 14 in class 9 Bihar government school");
    expect(a.domicile).toBe("bihar");
    expect(a.studentClass).toBe(9);
    expect(a.age).toBe(14);
  });
});
