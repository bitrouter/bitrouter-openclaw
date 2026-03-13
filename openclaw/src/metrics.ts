/**
 * Metrics integration — fetches and caches performance metrics from
 * BitRouter's GET /v1/metrics endpoint.
 *
 * Metrics are consumed by:
 * - tools.ts — surfaced in agent tools for visibility
 *
 * Degrades gracefully: returns null if the endpoint isn't available.
 */

import type {
  BitrouterState,
  MetricsResponse,
  OpenClawPluginApi,
} from "./types.js";

/**
 * Fetch metrics from BitRouter and cache them on state.
 *
 * On failure, preserves the existing cache (stale > empty).
 */
export async function refreshMetrics(
  state: BitrouterState,
  api: OpenClawPluginApi
): Promise<MetricsResponse | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const res = await fetch(`${state.baseUrl}/v1/metrics`, {
      signal: controller.signal,
      headers: state.apiToken
        ? { Authorization: `Bearer ${state.apiToken}` }
        : undefined,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      if (res.status !== 404) {
        api.logger.warn(
          `Failed to fetch metrics: ${res.status} ${res.statusText}`
        );
      }
      return null;
    }

    const body = (await res.json()) as MetricsResponse;
    state.metrics = body;
    return body;
  } catch (err) {
    api.logger.warn(`Metrics refresh failed: ${err}`);
    return null;
  }
}
