/**
 * Provider discovery — publishes BitRouter's routing table as model catalog
 * entries so `openclaw models list` shows BitRouter-routed models.
 *
 * Uses the ProviderPlugin.discovery API introduced in OpenClaw 2026.3.x.
 * When BitRouter is running and healthy, fetches the route table and
 * translates each route into a ModelDefinitionConfig entry.
 *
 * This replaces the need for a dedicated `augmentModelCatalog` hook —
 * discovery runs during gateway startup and model catalog refresh,
 * injecting BitRouter's routes into the standard model catalog.
 */

import type { BitrouterState, RouteInfo } from "./types.js";

// ── Route → model definition mapping ─────────────────────────────────

/** Default context windows and max tokens per protocol (conservative estimates). */
const PROTOCOL_DEFAULTS: Record<string, { contextWindow: number; maxTokens: number }> = {
  openai: { contextWindow: 128_000, maxTokens: 16_384 },
  anthropic: { contextWindow: 200_000, maxTokens: 8_192 },
  google: { contextWindow: 128_000, maxTokens: 8_192 },
};

/**
 * Convert a BitRouter RouteInfo into a model definition for the catalog.
 */
function routeToModelDef(route: RouteInfo): Record<string, unknown> {
  const defaults = PROTOCOL_DEFAULTS[route.protocol] ?? PROTOCOL_DEFAULTS.openai;
  return {
    id: route.model,
    name: `${route.model} (via BitRouter → ${route.provider})`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  };
}

// ── Discovery function ───────────────────────────────────────────────

/**
 * Build the discovery handler for the "bitrouter" provider.
 *
 * Returns a function that, when called by OpenClaw's discovery system,
 * checks if BitRouter is healthy and returns its routes as model
 * definitions. If BitRouter is down, returns null (no models to add).
 */
export function buildDiscoveryHandler(
  state: BitrouterState
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): (ctx: any) => Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (_ctx: any) => {
    // If BitRouter isn't healthy, don't advertise any models.
    if (!state.healthy || state.knownRoutes.length === 0) {
      return null;
    }

    const models = state.knownRoutes.map(routeToModelDef);

    // Deduplicate by model id (first route wins).
    const seen = new Set<string>();
    const unique = models.filter((m) => {
      const id = m.id as string;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    return {
      provider: {
        baseUrl: `${state.baseUrl}/v1`,
        models: unique,
      },
    };
  };
}
