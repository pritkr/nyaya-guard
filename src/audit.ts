import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEvent {
  ts: string;
  query_redacted: string;
  top_doc?: string;
  rule_id: string;
  verdict: string;
  citations: string[];
  confidence: number;
  blocked?: boolean;
  pii_findings?: { type: string; count: number }[];
  /** v2: staleness guard fired (superseded versions seen in top-k). */
  stale_corrected?: boolean;
  superseded_seen?: string[];
}

export function auditLogPath(): string {
  return process.env.AUDIT_LOG ?? `${process.cwd()}/logs/audit.jsonl`;
}

export function appendAudit(ev: AuditEvent): void {
  try {
    const p = auditLogPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(ev) + "\n", "utf-8");
  } catch {
    // audit must never crash serving
  }
}
