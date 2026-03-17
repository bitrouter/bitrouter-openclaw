import { describe, it, expect } from "vitest";
import { buildDiscoveryHandler } from "../src/discovery.js";
import type { BitrouterState, RouteInfo } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createMockState(overrides?: Partial<BitrouterState>): BitrouterState {
  return {
    process: null,
    healthy: true,
    baseUrl: "http://127.0.0.1:8787",
    knownRoutes: [],
    healthCheckTimer: null,
    homeDir: "/tmp/bitrouter-test",
    metrics: null,
    apiToken: null,
    adminToken: null,
    onboardingState: null,
    ...overrides,
  };
}

const ROUTES: RouteInfo[] = [
  { model: "gpt-4o", provider: "openai", protocol: "openai" },
  { model: "claude-3-5-sonnet", provider: "anthropic", protocol: "anthropic" },
  { model: "gemini-pro", provider: "google", protocol: "google" },
];

// ── Tests ────────────────────────────────────────────────────────────

describe("buildDiscoveryHandler", () => {
  it("returns null when BitRouter is not healthy", async () => {
    const state = createMockState({ healthy: false, knownRoutes: ROUTES });
    const handler = buildDiscoveryHandler(state);
    const result = await handler({});
    expect(result).toBeNull();
  });

  it("returns null when no routes are known", async () => {
    const state = createMockState({ healthy: true, knownRoutes: [] });
    const handler = buildDiscoveryHandler(state);
    const result = await handler({});
    expect(result).toBeNull();
  });

  it("returns model definitions from known routes", async () => {
    const state = createMockState({ healthy: true, knownRoutes: ROUTES });
    const handler = buildDiscoveryHandler(state);
    const result = await handler({});

    expect(result).toBeTruthy();
    expect(result.provider).toBeTruthy();
    expect(result.provider.baseUrl).toBe("http://127.0.0.1:8787/v1");
    expect(result.provider.models).toHaveLength(3);

    // Check model definitions are properly constructed.
    const gpt4o = result.provider.models.find(
      (m: Record<string, unknown>) => m.id === "gpt-4o"
    );
    expect(gpt4o).toBeTruthy();
    expect(gpt4o.name).toContain("BitRouter");
    expect(gpt4o.name).toContain("openai");
    expect(gpt4o.contextWindow).toBe(128_000);
  });

  it("uses anthropic defaults for anthropic protocol", async () => {
    const routes: RouteInfo[] = [
      { model: "claude", provider: "anthropic", protocol: "anthropic" },
    ];
    const state = createMockState({ healthy: true, knownRoutes: routes });
    const handler = buildDiscoveryHandler(state);
    const result = await handler({});

    expect(result.provider.models[0].contextWindow).toBe(200_000);
    expect(result.provider.models[0].maxTokens).toBe(8_192);
  });

  it("deduplicates routes by model id", async () => {
    const routes: RouteInfo[] = [
      { model: "gpt-4o", provider: "openai", protocol: "openai" },
      { model: "gpt-4o", provider: "openrouter", protocol: "openai" },
    ];
    const state = createMockState({ healthy: true, knownRoutes: routes });
    const handler = buildDiscoveryHandler(state);
    const result = await handler({});

    expect(result.provider.models).toHaveLength(1);
    // First route wins.
    expect(result.provider.models[0].name).toContain("openai");
  });
});
