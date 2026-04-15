/**
 * Usage & spend tracking — hooks into BitRouter's /v1/metrics endpoint
 * to provide usage data for the provider's usage surface.
 *
 * Since BitRouter is a proxy/router, it aggregates metrics across all
 * upstream providers. The resolveUsageAuth hook returns the local JWT
 * token, and fetchUsageSnapshot fetches and normalizes BitRouter's
 * per-route metrics into a usage snapshot.
 */

import type { BitrouterState, MetricsResponse } from "./types.js";

// ── Metrics fetching ─────────────────────────────────────────────────

/**
 * Fetch metrics from BitRouter's /v1/metrics endpoint.
 * Updates state.metrics on success. Returns null on failure.
 */
export async function fetchMetrics(
  state: BitrouterState,
): Promise<MetricsResponse | null> {
  if (!state.healthy) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(`${state.baseUrl}/v1/metrics`, {
      signal: controller.signal,
      headers: state.apiToken
        ? { Authorization: `Bearer ${state.apiToken}` }
        : undefined,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const body = (await res.json()) as MetricsResponse;
    state.metrics = body;
    return body;
  } catch {
    return null;
  }
}

// ── Usage summary ────────────────────────────────────────────────────

export interface UsageSummaryLine {
  route: string;
  requests: number;
  errors: number;
  p50Ms: number | null;
  p99Ms: number | null;
  avgInputTokens: number | null;
  avgOutputTokens: number | null;
  lastUsed: string | null;
}

/**
 * Convert BitRouter metrics into a human-readable usage summary.
 * Used by the provider's fetchUsageSnapshot hook and the status CLI.
 */
export function summarizeMetrics(metrics: MetricsResponse): {
  uptime: number;
  routes: UsageSummaryLine[];
} {
  const routes: UsageSummaryLine[] = [];

  for (const [routeName, routeMetrics] of Object.entries(metrics.routes)) {
    routes.push({
      route: routeName,
      requests: routeMetrics.total_requests,
      errors: routeMetrics.total_errors,
      p50Ms: routeMetrics.latency_p50_ms ?? null,
      p99Ms: routeMetrics.latency_p99_ms ?? null,
      avgInputTokens: routeMetrics.avg_input_tokens ?? null,
      avgOutputTokens: routeMetrics.avg_output_tokens ?? null,
      lastUsed: routeMetrics.last_used ?? null,
    });
  }

  return { uptime: metrics.uptime_seconds, routes };
}

/**
 * Format usage metrics as a text block for display.
 */
export function formatUsageText(metrics: MetricsResponse): string {
  const summary = summarizeMetrics(metrics);
  const lines: string[] = [
    `BitRouter Uptime: ${Math.floor(summary.uptime / 60)}m ${Math.floor(summary.uptime % 60)}s`,
    "",
  ];

  if (summary.routes.length === 0) {
    lines.push("No route metrics recorded yet.");
    return lines.join("\n");
  }

  lines.push("Route Metrics:");
  for (const r of summary.routes) {
    const parts = [`  ${r.route}: ${r.requests} req, ${r.errors} err`];
    if (r.p50Ms !== null) parts.push(`p50=${r.p50Ms}ms`);
    if (r.p99Ms !== null) parts.push(`p99=${r.p99Ms}ms`);
    if (r.avgInputTokens !== null) parts.push(`avg_in=${r.avgInputTokens}tok`);
    if (r.avgOutputTokens !== null)
      parts.push(`avg_out=${r.avgOutputTokens}tok`);
    if (r.lastUsed) parts.push(`last=${r.lastUsed}`);
    lines.push(parts.join(", "));
  }

  return lines.join("\n");
}
