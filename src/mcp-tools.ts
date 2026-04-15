/**
 * MCP Tools Bridge — exposes BitRouter's upstream MCP tools as optional
 * OpenClaw agent tools.
 *
 * On each health-check refresh cycle, we fetch GET /v1/tools from
 * BitRouter and register any new tools (or unregister removed ones)
 * as optional OpenClaw agent tools. Tool execution is proxied via
 * BitRouter's MCP gateway (POST /mcp with JSON-RPC `tools/call`).
 */

import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { BitrouterState, OpenClawPluginApi, ToolInfo } from "./types.js";

// ── Tool name helpers ────────────────────────────────────────────────

/**
 * Namespace a BitRouter tool name for OpenClaw registration.
 * Replaces non-alphanumeric chars with underscores for tool name compatibility.
 */
function toOpenClawToolName(toolId: string): string {
  return `bitrouter_${toolId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

// ── JSON-RPC proxy ───────────────────────────────────────────────────

/**
 * Call a tool via BitRouter's MCP JSON-RPC gateway.
 */
async function callMcpTool(
  state: BitrouterState,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch(`${state.baseUrl}/mcp`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(state.apiToken
          ? { Authorization: `Bearer ${state.apiToken}` }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });

    if (!res.ok) {
      return {
        content: `MCP gateway error: ${res.status} ${res.statusText}`,
        isError: true,
      };
    }

    const body = (await res.json()) as {
      result?: {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      error?: { message?: string };
    };

    if (body.error) {
      return {
        content: `MCP error: ${body.error.message ?? "unknown"}`,
        isError: true,
      };
    }

    const textParts = (body.result?.content ?? [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text as string);

    return {
      content: textParts.join("\n") || "(no output)",
      isError: body.result?.isError ?? false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Tool creation ────────────────────────────────────────────────────

/**
 * Create an OpenClaw agent tool that proxies to a BitRouter MCP tool.
 */
function createMcpProxyTool(
  toolInfo: ToolInfo,
  state: BitrouterState,
): AnyAgentTool {
  const openClawName = toOpenClawToolName(toolInfo.id);

  // Build a simple JSON schema parameters definition or fall back
  // to a generic passthrough object.
  const parameters = {
    type: "object" as const,
    properties: {
      arguments: {
        type: "object" as const,
        description:
          "Arguments to pass to the MCP tool. See tool description for available parameters.",
        additionalProperties: true,
      },
    },
  };

  return {
    name: openClawName,
    label: `BitRouter MCP: ${toolInfo.name ?? toolInfo.id}`,
    displaySummary: toolInfo.description ?? `MCP tool: ${toolInfo.id}`,
    description:
      `Proxy to BitRouter MCP tool "${toolInfo.id}" (provider: ${toolInfo.provider}).` +
      (toolInfo.description ? `\n\n${toolInfo.description}` : "") +
      (toolInfo.input_schema
        ? `\n\nTool schema: ${JSON.stringify(toolInfo.input_schema)}`
        : ""),
    parameters,

    execute: async (
      _toolCallId: string,
      params: { arguments?: Record<string, unknown> },
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details: { isError: boolean };
    }> => {
      if (!state.healthy) {
        return {
          content: [
            {
              type: "text",
              text: "BitRouter is not healthy. Cannot execute MCP tool.",
            },
          ],
          details: { isError: true },
        };
      }

      const result = await callMcpTool(
        state,
        toolInfo.id,
        params.arguments ?? {},
      );

      return {
        content: [{ type: "text", text: result.content }],
        details: { isError: result.isError },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ── Bridge controller ────────────────────────────────────────────────

export interface McpToolsBridge {
  /** Register tools currently known from state.knownTools. */
  registerInitialTools(): void;
  /**
   * Sync tools: register new ones and report removed tools.
   * Called during health check refresh cycles.
   */
  refresh(): void;
  /** Set of currently registered OpenClaw tool names. */
  readonly registeredToolNames: ReadonlySet<string>;
}

/**
 * Create the MCP tools bridge that manages registering/unregistering
 * MCP tools as optional OpenClaw agent tools.
 */
export function createMcpToolsBridge(
  api: OpenClawPluginApi,
  state: BitrouterState,
): McpToolsBridge {
  const registered = new Set<string>();

  function registerToolsFromState(): void {
    // Only register MCP tools (not skill entries).
    const mcpTools = state.knownTools.filter((t) => t.provider !== "skill");

    for (const tool of mcpTools) {
      const name = toOpenClawToolName(tool.id);
      if (registered.has(name)) continue;

      try {
        api.registerTool(createMcpProxyTool(tool, state), {
          name,
          optional: true,
        });
        registered.add(name);
      } catch (err) {
        api.logger.warn(`Failed to register MCP tool ${tool.id}: ${err}`);
      }
    }
  }

  function refresh(): void {
    const mcpTools = state.knownTools.filter((t) => t.provider !== "skill");
    const currentNames = new Set(mcpTools.map((t) => toOpenClawToolName(t.id)));

    // Register new tools.
    registerToolsFromState();

    // Log removed tools (OpenClaw SDK doesn't support unregisterTool,
    // so we just note the removal — the tool will fail gracefully if
    // the backing MCP tool is gone).
    for (const name of registered) {
      if (!currentNames.has(name)) {
        api.logger.info(`MCP tool removed upstream: ${name}`);
        registered.delete(name);
      }
    }
  }

  return {
    registerInitialTools: registerToolsFromState,
    refresh,
    get registeredToolNames() {
      return registered;
    },
  };
}
