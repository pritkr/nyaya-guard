/** PII redaction + prompt-injection defense. Presidio-style regex layer (no network). */

export interface RedactionResult {
  redacted: string;
  findings: { type: string; count: number }[];
}

const PATTERNS: { type: string; re: RegExp; replace: string }[] = [
  // Aadhaar: 12 digits with optional spaces, avoid matching long serial numbers loosely
  { type: "aadhaar", re: /\b\d{4}\s?\d{4}\s?\d{4}\b/g, replace: "[AADHAAR-REDACTED]" },
  // Indian mobile: 10 digits starting 6-9, optional +91 / spaces
  { type: "phone", re: /(?:\+91[\s-]?)?\b[6-9]\d{9}\b/g, replace: "[PHONE-REDACTED]" },
  // Email
  { type: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: "[EMAIL-REDACTED]" },
  // Bank account-ish: 9-18 digit runs (only when near bank/account keywords to limit FPs)
  { type: "bank_account", re: /\b\d{9,18}\b/g, replace: "[ACCOUNT-REDACTED]" },
  // DOB dd/mm/yyyy
  { type: "dob", re: /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{4}\b/g, replace: "[DOB-REDACTED]" },
];

export function redactPII(text: string): RedactionResult {
  let out = text;
  const findings: { type: string; count: number }[] = [];
  for (const p of PATTERNS) {
    // bank_account only fires near bank keywords to avoid eating scheme amounts
    if (p.type === "bank_account" && !/bank|account|khata|ac\b/i.test(out)) continue;
    // aadhaar: skip matches that are clearly scheme amounts (<= 999999 with spaces odd) — keep simple: redact all 12-digit
    let count = 0;
    out = out.replace(p.re, () => {
      count++;
      return p.replace;
    });
    if (count) findings.push({ type: p.type, count });
  }
  return { redacted: out, findings };
}

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /disregard\s+(all\s+)?(rules|instructions|guidelines)/i,
  /reveal\s+(your\s+)?(system\s+)?prompt/i,
  /show\s+(me\s+)?your\s+(hidden\s+|system\s+)*(prompt|instructions)/i,
  /override\s+(the\s+)?rules/i,
  /pretend\s+you\s+are/i,
  /you\s+are\s+now\s+(dan|jailbroken|unrestricted)/i,
  /\bdan\s+mode\b/i,
  /jailbreak/i,
  /bypass\s+(the\s+)?(rules|guardrails|safety)/i,
  /do\s+not\s+cite/i,
  /stop\s+citing/i,
  /act\s+as\s+if\s+(no|without)\s+(rules|limits)/i,
  /system\s*:\s*/i,
  /\[system\]/i,
  /<\|system\|>/i,
];

export interface InjectionCheck {
  blocked: boolean;
  matched: string[];
}

export function detectInjection(text: string): InjectionCheck {
  const matched = INJECTION_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
  return { blocked: matched.length > 0, matched };
}

export const REFUSAL_EN = "I don't know — please ask a sahayak (helper) at your block/RTPS office.";
export const REFUSAL_HI = "मुझे नहीं पता — कृपया अपने प्रखंड/RTPS कार्यालय में सहाय​क से पूछें।";
export const INJECTION_REFUSAL_EN =
  "That request tries to override my safety rules, so I can't comply. Ask me about a Bihar welfare scheme instead.";
export const INJECTION_REFUSAL_HI = "यह अनुरोध मेरे सुरक्षा नियमों को तोड़ने की कोशिश करता है, इसलिए मैं इसका पालन नहीं कर सकता। बिहार की किसी कल्याण योजना के बारे में पूछें।";

export function refusalMessage(hindi: boolean): string {
  return hindi ? `${REFUSAL_HI}\n${REFUSAL_EN}` : `${REFUSAL_EN}\n${REFUSAL_HI}`;
}

export function injectionMessage(hindi: boolean): string {
  return hindi ? `${INJECTION_REFUSAL_HI}\n${INJECTION_REFUSAL_EN}` : `${INJECTION_REFUSAL_EN}\n${INJECTION_REFUSAL_HI}`;
}
