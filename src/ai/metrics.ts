type AiCallRecord = {
  id: string;
  ok: boolean;
  durationMs: number;
  errorType?: string;
  timestamp: number;
};

type AiMetricsSnapshot = {
  count: number;
  avgLatencyMs: number;
  failCount: number;
  schemaFailCount: number;
  recent: AiCallRecord[];
};

const MAX_RECENT = 20;

let totalCount = 0;
let totalLatencyMs = 0;
let failCount = 0;
let schemaFailCount = 0;
const recentCalls: AiCallRecord[] = [];

export function recordAiCall(record: AiCallRecord): void {
  totalCount += 1;
  totalLatencyMs += record.durationMs;
  if (!record.ok) {
    failCount += 1;
    if (record.errorType === "schema_mismatch") {
      schemaFailCount += 1;
    }
  }

  recentCalls.unshift(record);
  if (recentCalls.length > MAX_RECENT) {
    recentCalls.pop();
  }
}

export function getAiMetrics(): AiMetricsSnapshot {
  return {
    count: totalCount,
    avgLatencyMs: totalCount > 0 ? Math.round(totalLatencyMs / totalCount) : 0,
    failCount,
    schemaFailCount,
    recent: [...recentCalls],
  };
}
