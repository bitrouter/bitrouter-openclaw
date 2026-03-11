/**
 * Shared types for the BitRouter OpenClaw plugin.
 *
 * These types bridge three worlds:
 * 1. OpenClaw's plugin API (what we register with)
 * 2. BitRouter's YAML config format (what we generate)
 * 3. BitRouter's HTTP API (what we query at runtime)
 */

import type { ChildProcess } from "node:child_process";

// ── Setup mode ───────────────────────────────────────────────────────

/**
 * How the user wants to use BitRouter.
 *
 * "byok"  — bring-your-own-key: user provides upstream provider API key(s).
 *           BitRouter holds them and proxies requests.
 * "cloud" — sign in to BitRouterAI cloud (stub; OAuth coming in next version).
 */
export type SetupMode = "byok" | "cloud";

/**
 * BYOK upstream provider config — stored in pluginConfig after wizard runs.
 * The apiKey is the raw key string (stored in openclaw's credential store
 * via ProviderAuthResult.profiles, not in plain config).
 */
export interface BitrouterByokConfig {
  /** Upstream provider id: "openrouter" | "openai" | "anthropic" | custom */
  upstreamProvider: string;
  /** Custom API base URL (optional — defaults to provider's public URL). */
  apiBase?: string;
}

// ── Plugin configuration (from openclaw.plugin.json configSchema) ────

/** Root plugin config — matches the configSchema in openclaw.plugin.json. */
export interface BitrouterPluginConfig {
  port?: number;
  host?: string;
  autoStart?: boolean;
  healthCheckIntervalMs?: number;
  interceptAllModels?: boolean;
  providers?: Record<string, ProviderEntry>;
  models?: Record<string, ModelEntry>;
  routing?: RoutingConfig;
  /** Set by the first-run wizard. Undefined = not yet configured. */
  mode?: SetupMode;
  /** BYOK upstream provider config. Set when mode === "byok". */
  byok?: BitrouterByokConfig;
}

/** A single provider entry in the plugin config (camelCase, TS-side). */
export interface ProviderEntry {
  apiKey?: string;
  apiBase?: string;
  envPrefix?: string;
  derives?: string;
}

/** A virtual model routing definition. */
export interface ModelEntry {
  strategy?: "priority" | "load_balance";
  endpoints: EndpointEntry[];
}

/** A single endpoint within a model route. */
export interface EndpointEntry {
  provider: string;
  modelId: string;
  apiKey?: string;
  apiBase?: string;
}

// ── BitRouter HTTP API response types ────────────────────────────────

/** A single route entry from GET /v1/routes. */
export interface RouteInfo {
  /** The virtual model name (e.g. "fast", "gpt-4o"). */
  model: string;
  /** Provider name (e.g. "openai", "anthropic"). */
  provider: string;
  /** API protocol used by this provider. */
  protocol: "openai" | "anthropic" | "google";
}

/** Response from GET /health. */
export interface HealthStatus {
  status: "ok" | "error";
}

// ── Metrics types ───────────────────────────────────────────────────

/** Per-endpoint performance metrics. */
export interface EndpointMetrics {
  total_requests: number;
  total_errors: number;
  error_rate: number;
  latency_p50_ms: number;
  latency_p99_ms: number;
}

/** Per-route metrics from GET /v1/metrics. */
export interface RouteMetrics {
  model: string;
  total_requests: number;
  total_errors: number;
  error_rate: number;
  latency_p50_ms: number;
  latency_p99_ms: number;
  by_endpoint: Record<string, EndpointMetrics>;
}

/** Full response from GET /v1/metrics. */
export interface MetricsResponse {
  routes: Record<string, RouteMetrics>;
}

// ── Feedback type ───────────────────────────────────────────────────

/** A feedback signal from POST /bitrouter/feedback. */
export interface FeedbackSignal {
  route: string;
  outcome: "success" | "failure";
  taskType?: string;
  timestamp: number;
}

// ── Routing config ──────────────────────────────────────────────────

/** Metrics-informed routing configuration. */
export interface RoutingConfig {
  errorRateThreshold?: number;
  minRequestsForScoring?: number;
  preferMetrics?: boolean;
  /**
   * TEMPORARY: Generate mock metrics from known routes when
   * the BitRouter binary doesn't support GET /v1/metrics yet.
   * Remove once bitrouter/bitrouter#70 ships.
   */
  mockMetrics?: boolean;
}

// ── Tool result type ─────────────────────────────────────────────────

/** Standard tool result returned from agent tool execute functions. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ── Dynamic route type ──────────────────────────────────────────────

/** A runtime-created route managed by agent tools (not from BitRouter config). */
export interface DynamicRoute {
  /** The virtual model name this route handles. */
  model: string;
  /** Routing strategy: "priority" (always first) or "load_balance" (round-robin). */
  strategy: "priority" | "load_balance";
  /** Ordered list of upstream endpoints. */
  endpoints: EndpointEntry[];
  /** Round-robin counter for load_balance strategy. */
  rrCounter: number;
  /** ISO timestamp of when this route was created/updated. */
  createdAt: string;
}

// ── Plugin runtime state ─────────────────────────────────────────────

/**
 * Mutable state shared across all plugin modules.
 *
 * Created once in index.ts and passed by reference to service.ts,
 * routing.ts, health.ts, and provider.ts. This avoids module-level
 * global state and makes testing straightforward (inject a mock state).
 */
export interface BitrouterState {
  /** The managed BitRouter child process, or null if not running. */
  process: ChildProcess | null;
  /** Whether the last health check succeeded. */
  healthy: boolean;
  /** Base URL for BitRouter's HTTP API (e.g. "http://127.0.0.1:8787"). */
  baseUrl: string;
  /** Cached routing table from GET /v1/routes. */
  knownRoutes: RouteInfo[];
  /** Handle for the periodic health check interval. */
  healthCheckTimer: ReturnType<typeof setInterval> | null;
  /** Absolute path to the generated BitRouter home directory. */
  homeDir: string;
  /** Agent-created dynamic routes, keyed by model name. */
  dynamicRoutes: Map<string, DynamicRoute>;
  /** Cached metrics from GET /v1/metrics (null if unavailable). */
  metrics: MetricsResponse | null;
}

// ── OpenClaw Plugin API type stubs ───────────────────────────────────
//
// These are minimal type declarations for the OpenClaw plugin API surface
// that this plugin uses. In production, these would come from @openclaw/sdk.
// For now, we declare them here so the plugin compiles without the SDK.

export interface OpenClawPluginApi {
  /** Register a managed service with start/stop lifecycle. */
  registerService(opts: {
    id: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }): void;

  /** Register an LLM provider. */
  registerProvider(opts: {
    id: string;
    label: string;
    baseUrl?: string;
    auth?: ProviderAuthMethod[];
  }): void;

  /**
   * Listen for plugin lifecycle events.
   *
   * The `before_model_resolve` hook fires before the agent runtime selects
   * a model. The handler can call `event.override()` to redirect the
   * request to a different provider/model.
   */
  on(
    event: "before_model_resolve",
    handler: (event: ModelResolveEvent) => void
  ): void;

  /** Get this plugin's resolved config (merged with defaults). */
  getConfig(): BitrouterPluginConfig;

  /** Get the plugin's data directory (persistent across restarts). */
  getDataDir(): string;

  /** Register an agent-callable tool. */
  registerTool(
    definition: {
      name: string;
      description: string;
      parameters: unknown;
      execute: (
        id: string,
        params: Record<string, unknown>
      ) => Promise<ToolResult>;
    },
    opts?: { optional?: boolean }
  ): void;

  /** Register an HTTP route on the OpenClaw gateway. */
  registerHttpRoute(opts: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    handler: (req: {
      body: unknown;
      query: Record<string, string>;
    }) => Promise<{ status: number; body: unknown }>;
  }): void;

  /** Register an RPC method on the OpenClaw gateway. */
  registerGatewayMethod(
    name: string,
    handler: () => Promise<unknown>
  ): void;

  /** Register a CLI subcommand under the openclaw binary. */
  registerCli(
    registrar: (ctx: { program: unknown; config: Record<string, unknown>; logger: OpenClawPluginApi["log"] }) => void | Promise<void>,
    opts?: { commands?: string[] }
  ): void;

  /** Structured logger scoped to this plugin. */
  log: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
}

// ── Provider auth types (matching real OpenClaw SDK) ─────────────────

/** A select option in the wizard prompter. */
export interface WizardSelectOption<T = string> {
  value: T;
  label: string;
  hint?: string;
}

/** Real WizardPrompter surface (from openclaw/plugin-sdk/wizard/prompts). */
export interface WizardPrompter {
  intro(title: string): Promise<void>;
  outro(message: string): Promise<void>;
  note(message: string, title?: string): Promise<void>;
  select<T>(params: {
    message: string;
    options: Array<WizardSelectOption<T>>;
    initialValue?: T;
  }): Promise<T>;
  multiselect<T>(params: {
    message: string;
    options: Array<WizardSelectOption<T>>;
    initialValues?: T[];
    searchable?: boolean;
  }): Promise<T[]>;
  text(params: {
    message: string;
    initialValue?: string;
    placeholder?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  confirm(params: { message: string; initialValue?: boolean }): Promise<boolean>;
  progress(label: string): { update(msg: string): void; stop(msg?: string): void };
}

/** Context passed to a provider's auth run() function (matches real SDK). */
export interface ProviderAuthContext {
  config: Record<string, unknown>;
  agentDir?: string;
  workspaceDir?: string;
  prompter: WizardPrompter;
  runtime: unknown;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  oauth: { createVpsAwareHandlers: unknown };
}

/** A single auth method offered by a provider. */
export interface ProviderAuthMethod {
  id: string;
  label: string;
  hint?: string;
  kind: "api_key" | "oauth" | "token" | "device_code" | "custom";
  run: (ctx: ProviderAuthContext) => Promise<ProviderAuthResult>;
}

/** Result returned from a provider's auth run() function (matches real SDK). */
export interface ProviderAuthResult {
  profiles: Array<{
    profileId: string;
    credential: {
      type: "api_key";
      provider: string;
      key: string;
    };
  }>;
  /** Partial OpenClaw config to merge into openclaw.json. */
  configPatch?: Record<string, unknown>;
  /** Suggest a default model after auth. */
  defaultModel?: string;
  /** Advisory messages shown to the user after auth. */
  notes?: string[];
}

/** Event object passed to the before_model_resolve hook. */
export interface ModelResolveEvent {
  /** The model name requested by the agent (e.g. "gpt-4o", "claude-sonnet"). */
  model: string;
  /** Override the provider and optionally the model name. */
  override(opts: { provider: string; model?: string }): void;
}

// ── Config defaults ──────────────────────────────────────────────────

export const DEFAULTS = {
  port: 8787,
  host: "127.0.0.1",
  autoStart: true,
  healthCheckIntervalMs: 30_000,
  interceptAllModels: false,
  /** How long to wait for BitRouter to become healthy on startup. */
  startupTimeoutMs: 15_000,
  /** Interval between startup health check polls. */
  startupPollMs: 200,
  /** How long to wait for the process to exit on stop. */
  stopTimeoutMs: 10_000,
  /** Refresh the routing table every N health checks. */
  routeRefreshInterval: 5,
} as const;
