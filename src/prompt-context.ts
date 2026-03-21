/**
 * Prompt context injection — registers a `before_prompt_build` hook that
 * injects dynamic BitRouter state into the agent's context.
 *
 * Replaces the previous 9 registered tools with a lightweight context
 * injection (~150 tokens) that tells the LLM about BitRouter's current
 * state and points it to the `/bitrouter` skill and CLI for management.
 *
 * Uses two injection channels:
 *   - `appendSystemContext` — static CLI/skill reference (prompt-cache friendly)
 *   - `prependContext`      — dynamic per-turn state (health, routes, mode)
 */

import type {
  BitrouterPluginConfig,
  BitrouterState,
  OpenClawPluginApi,
  PluginHookAgentContext,
} from "./types.js";

// ── Hook event/result types (structural match to SDK) ────────────────

type BeforePromptBuildEvent = {
  prompt: string;
  messages?: unknown[];
};

type BeforePromptBuildResult = {
  prependContext?: string;
  appendSystemContext?: string;
};

// ── Static context (cacheable across turns) ──────────────────────────

const STATIC_CONTEXT = `BitRouter LLM proxy is available. For route management, status, key generation, or admin operations use the /bitrouter skill or the CLI:
  openclaw bitrouter status   — health, routes, daemon info
  openclaw bitrouter setup    — reconfigure provider/mode
  openclaw bitrouter wallet   — wallet/onboarding state

IMPORTANT — Model Selection: You have 33 models available at different cost/capability tiers. Before starting a task, actively choose the right model using the /model-select skill. Use \`bitrouter route add <name> openrouter:<model>\` to set task-appropriate routes. Do NOT default to auto/load-balance for every task — pick the cheapest tier that can handle the job well. Quick guide:
  Frontier ($2-25/M out): claude-opus-4.6, gpt-5.4, gemini-3.1-pro — complex architecture, research
  Strong ($0.4-15/M out): claude-sonnet-4.6, qwen3-max-thinking, mistral-large-2512 — standard dev work
  Fast ($0.13-5/M out): claude-haiku-4.5, devstral-2512, gemini-2.5-flash, grok-4.1-fast, gpt-5-mini — simple tasks, high throughput
  Ultra-cheap ($0.05-0.75/M out): gpt-5-nano, mimo-v2-flash, step-3.5-flash — batch, formatting, triage`;

// ── Dynamic context builder ──────────────────────────────────────────

function buildDynamicContext(
  config: BitrouterPluginConfig,
  state: BitrouterState
): string {
  const mode = config.mode ?? "unconfigured";
  const upstream =
    mode === "byok"
      ? `/${config.byok?.upstreamProvider ?? "unknown"}`
      : "";

  const healthTag = state.healthy ? ", healthy" : "";

  const routeCount = state.knownRoutes.length;
  const routeSummary =
    routeCount > 0
      ? state.knownRoutes.map((r) => `${r.model}→${r.provider}`).join(", ")
      : "none";

  return `[BitRouter: ${mode}${upstream}${healthTag}, ${routeCount} routes (${routeSummary})]`;
}

// ── Hook registration ────────────────────────────────────────────────

/**
 * Register the `before_prompt_build` hook that injects BitRouter context.
 *
 * The hook fires before every agent turn and injects:
 * - A static reference to the `/bitrouter` skill and CLI commands
 * - A dynamic one-liner with current health, mode, and route summary
 */
export function registerPromptContext(
  api: OpenClawPluginApi,
  config: BitrouterPluginConfig,
  state: BitrouterState
): void {
  api.on(
    "before_prompt_build",
    (
      _event: BeforePromptBuildEvent,
      _ctx: PluginHookAgentContext
    ): BeforePromptBuildResult => {
      return {
        appendSystemContext: STATIC_CONTEXT,
        prependContext: buildDynamicContext(config, state),
      };
    }
  );
}
