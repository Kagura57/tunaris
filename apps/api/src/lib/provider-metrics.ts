type ProviderMetricEntry = {
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  lastLatencyMs: number;
  lastStatus: number | null;
  lastError: string | null;
  lastSeenAt: string;
  maxAttempts: number;
};

const providerMetrics = new Map<string, ProviderMetricEntry>();

function getOrCreate(provider: string): ProviderMetricEntry {
  const existing = providerMetrics.get(provider);
  if (existing) return existing;

  const created: ProviderMetricEntry = {
    totalCalls: 0,
    successCalls: 0,
    failedCalls: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    lastLatencyMs: 0,
    lastStatus: null,
    lastError: null,
    lastSeenAt: new Date(0).toISOString(),
    maxAttempts: 0,
  };
  providerMetrics.set(provider, created);
  return created;
}

export function recordProviderMetric(input: {
  provider: string;
  success: boolean;
  latencyMs: number;
  status?: number | null;
  error?: string | null;
  attempts?: number;
}) {
  const entry = getOrCreate(input.provider);
  entry.totalCalls += 1;
  if (input.success) {
    entry.successCalls += 1;
  } else {
    entry.failedCalls += 1;
  }

  const safeLatency = Math.max(0, Math.round(input.latencyMs));
  entry.totalLatencyMs += safeLatency;
  entry.maxLatencyMs = Math.max(entry.maxLatencyMs, safeLatency);
  entry.lastLatencyMs = safeLatency;
  entry.lastStatus = input.status ?? null;
  entry.lastError = input.error ?? null;
  entry.lastSeenAt = new Date().toISOString();
  entry.maxAttempts = Math.max(entry.maxAttempts, Math.max(1, input.attempts ?? 1));
}

export function providerMetricsSnapshot() {
  const result: Record<string, ProviderMetricEntry & { averageLatencyMs: number }> = {};
  for (const [provider, entry] of providerMetrics.entries()) {
    result[provider] = {
      ...entry,
      averageLatencyMs:
        entry.totalCalls > 0 ? Math.round(entry.totalLatencyMs / entry.totalCalls) : 0,
    };
  }
  return result;
}
