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
} from "./types.js";
import { ALLOWED_COMMANDS_DESCRIPTION } from "./bitrouter-tool.js";

// ── Static context (cacheable across turns) ──────────────────────────

const STATIC_CONTEXT = `BitRouter LLM proxy is available. Use the \`bitrouter\` tool for route management, status checks, and administration.

Available tool commands:
  ${ALLOWED_COMMANDS_DESCRIPTION}

Examples:
  bitrouter tool → command: "status"
  bitrouter tool → command: "models list"
  bitrouter tool → command: "route add fast openai:gpt-4o-mini"
  bitrouter tool → command: "route add research openai:o3 anthropic:claude-opus-4-20250514 --strategy load_balance"
  bitrouter tool → command: "route rm fast"

BitRouter also provides:
  MCP Gateway — proxy upstream MCP servers via /mcp (tools/list, tools/call, resources/*, prompts/*)
  Skills Registry — manage agent skills via /v1/skills (CRUD) and discover via /v1/tools

IMPORTANT — Model Selection: Choose the right model for the task. Use \`bitrouter\` tool with "route add <name> openrouter:<model>" to set task-appropriate routes. Do NOT default to auto/load-balance for every task — pick the cheapest tier that can handle the job well. Quick guide:
  Frontier ($2-25/M out): claude-opus-4.6, gpt-5.4, gemini-3.1-pro — complex architecture, research
  Strong ($0.4-15/M out): claude-sonnet-4.6, qwen3-max-thinking, mistral-large-2512 — standard dev work
  Fast ($0.13-5/M out): claude-haiku-4.5, devstral-2512, gemini-2.5-flash, grok-4.1-fast, gpt-5-mini — simple tasks, high throughput
  Ultra-cheap ($0.05-0.75/M out): gpt-5-nano, mimo-v2-flash, step-3.5-flash — batch, formatting, triage`;

// ── Dynamic context builder ──────────────────────────────────────────

function buildDynamicContext(
  config: BitrouterPluginConfig,
  state: BitrouterState,
): string {
  const mode = config.mode ?? "unconfigured";
  const upstream =
    mode === "byok" ? `/${config.byok?.upstreamProvider ?? "unknown"}` : "";

  const healthTag = state.healthy ? ", healthy" : "";

  const routeCount = state.knownRoutes.length;
  const routeSummary =
    routeCount > 0
      ? state.knownRoutes.map((r) => `${r.model}→${r.provider}`).join(", ")
      : "none";

  const parts: string[] = [
    `[BitRouter: ${mode}${upstream}${healthTag}, ${routeCount} routes (${routeSummary})]`,
  ];

  // A2A agents summary
  if (state.knownAgents.length > 0) {
    const agentSummary = state.knownAgents
      .map((a) => {
        const skills =
          a.skills.length > 0
            ? ` (${a.skills.map((s) => s.name).join(", ")})`
            : "";
        return `${a.id}${skills}`;
      })
      .join("; ");
    parts.push(`[A2A agents: ${state.knownAgents.length} — ${agentSummary}]`);
  }

  // MCP tools + skills summary
  if (state.knownTools.length > 0) {
    const mcpTools = state.knownTools.filter((t) => t.provider !== "skill");
    const skillTools = state.knownTools.filter((t) => t.provider === "skill");
    const toolParts: string[] = [];
    if (mcpTools.length > 0) {
      toolParts.push(`${mcpTools.length} MCP tools`);
    }
    if (skillTools.length > 0) {
      toolParts.push(`${skillTools.length} skills`);
    }
    parts.push(`[Tools: ${toolParts.join(", ")}]`);
  }

  return parts.join(" ");
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
  state: BitrouterState,
): void {
  api.on("before_prompt_build", (_event, _ctx) => {
    return {
      appendSystemContext: STATIC_CONTEXT,
      prependContext: buildDynamicContext(config, state),
    };
  });
}
