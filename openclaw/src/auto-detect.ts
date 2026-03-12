/**
 * Auto-detection — scans for provider API keys in environment variables.
 *
 * When BitRouter is installed but not yet configured (config.mode unset),
 * this module discovers providers the user already has set up by checking
 * for well-known environment variable patterns like OPENAI_API_KEY.
 *
 * Sources (merged, deduplicated):
 * 1. api.config.models.providers — providers OpenClaw knows about
 * 2. PROVIDER_API_BASES — well-known providers BitRouter supports
 *
 * For each candidate, checks process.env[toEnvVarKey(name)]. If a key
 * exists, the provider is included in the auto-proxy configuration.
 */

import type { OpenClawPluginApi, ProviderEntry } from "./types.js";
import { PROVIDER_API_BASES, toEnvVarKey } from "./config.js";

// ── Types ────────────────────────────────────────────────────────────

/** A provider discovered via environment variable sniffing. */
export interface DetectedProvider {
  /** Provider name (e.g. "openai", "anthropic"). */
  name: string;
  /** The env var that held the key (e.g. "OPENAI_API_KEY"). */
  envVarKey: string;
  /** The raw API key value from the environment. */
  apiKey: string;
  /** Canonical API base URL, if known. */
  apiBase?: string;
}

// ── Detection ────────────────────────────────────────────────────────

/**
 * Scan for providers with API keys present in environment variables.
 *
 * Merges candidates from OpenClaw's configured providers and BitRouter's
 * well-known provider list. Returns only those with a non-empty env var.
 */
export function detectProviders(api: OpenClawPluginApi): DetectedProvider[] {
  // Collect candidate provider names from both sources.
  const candidates = new Set<string>();

  // 1. Providers configured in OpenClaw.
  const openclawProviders = (api.config as {
    models?: { providers?: Record<string, unknown> };
  }).models?.providers;

  if (openclawProviders) {
    for (const name of Object.keys(openclawProviders)) {
      candidates.add(name);
    }
  }

  // 2. Well-known providers BitRouter supports.
  for (const name of Object.keys(PROVIDER_API_BASES)) {
    candidates.add(name);
  }

  // Check each candidate for an API key in the environment.
  const detected: DetectedProvider[] = [];

  for (const name of candidates) {
    const envVarKey = toEnvVarKey(name);
    const apiKey = process.env[envVarKey]?.trim();

    if (!apiKey) continue;

    detected.push({
      name,
      envVarKey,
      apiKey,
      apiBase: PROVIDER_API_BASES[name], // undefined for unknown providers
    });
  }

  // Sort alphabetically for deterministic logging.
  detected.sort((a, b) => a.name.localeCompare(b.name));

  return detected;
}

// ── Multi-provider config building ───────────────────────────────────

/** Default model IDs per well-known provider for "auto" routes. */
const AUTO_MODEL_IDS: Record<string, string> = {
  openrouter: "anthropic/claude-3-haiku",
  openai: "gpt-4o",
  anthropic: "claude-3-5-haiku-20241022",
};

/**
 * Build provider entries and model routes from detected providers.
 *
 * Returns the providers and models maps that can be merged into a
 * BitrouterPluginConfig for YAML generation.
 */
export function buildAutoProviderConfig(detected: DetectedProvider[]): {
  providers: Record<string, ProviderEntry>;
  models: Record<string, { strategy: "priority"; endpoints: Array<{ provider: string; modelId: string }> }>;
} {
  const providers: Record<string, ProviderEntry> = {};
  const models: Record<string, { strategy: "priority"; endpoints: Array<{ provider: string; modelId: string }> }> = {};

  for (const dp of detected) {
    // Provider entry.
    providers[dp.name] = {
      apiKey: dp.apiKey,
      ...(dp.apiBase ? { apiBase: dp.apiBase } : {}),
      // Non-OpenAI providers derive the OpenAI-compatible protocol.
      ...(dp.name === "openai" ? {} : { derives: "openai" }),
    };

    // Default model routes for this provider.
    const defaultModelId = AUTO_MODEL_IDS[dp.name] ?? "auto";
    const virtualNames = ["auto", "default", `${dp.name}/auto`];

    for (const vn of virtualNames) {
      // Don't overwrite if a higher-priority provider already claimed this name.
      // First detected provider (alphabetically) wins for shared names like "auto".
      if (!models[vn]) {
        models[vn] = {
          strategy: "priority",
          endpoints: [{ provider: dp.name, modelId: defaultModelId }],
        };
      }
    }
  }

  // Cross-provider "auto" route: if multiple providers, use priority fallback.
  if (detected.length > 1) {
    models["auto"] = {
      strategy: "priority",
      endpoints: detected.map((dp) => ({
        provider: dp.name,
        modelId: AUTO_MODEL_IDS[dp.name] ?? "auto",
      })),
    };
  }

  return { providers, models };
}
