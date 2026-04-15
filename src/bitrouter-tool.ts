/**
 * Unified `bitrouter` agent tool — exposes safe BitRouter CLI subcommands
 * as a single tool that the LLM can invoke.
 *
 * The tool validates that every command is in the allowlist before
 * dispatching to the BitRouter binary. Destructive operations (wallet
 * mutations, key creation, auth login, daemon lifecycle) are blocked.
 */

import { execFile } from "node:child_process";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { BitrouterState } from "./types.js";
import { resolveBinaryPath } from "./binary.js";

// ── Allowlist ────────────────────────────────────────────────────────

/**
 * Agent-safe subcommand prefixes. A command is allowed if its positional
 * tokens (before any `--flag`) start with one of these prefixes.
 *
 * Example: "route add mymodel openai:gpt-4o" matches ["route", "add"].
 */
const ALLOWED_COMMANDS: string[][] = [
  ["status"],
  ["models", "list"],
  ["tools", "list"],
  ["tools", "status"],
  ["route", "list"],
  ["route", "add"],
  ["route", "rm"],
  ["agents", "list"],
  ["agents", "check"],
  ["auth", "status"],
  ["wallet", "list"],
  ["wallet", "info"],
  ["key", "list"],
  ["policy", "list"],
  ["policy", "show"],
];

/** Human-readable list of allowed commands for the tool description. */
export const ALLOWED_COMMANDS_DESCRIPTION = ALLOWED_COMMANDS.map(
  (tokens) => `bitrouter ${tokens.join(" ")}`,
).join("\n  ");

// ── Command validation ───────────────────────────────────────────────

/**
 * Split a raw command string into shell-like tokens.
 * Handles double-quoted strings but not escapes (good enough for CLI args).
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;

  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === " " && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Extract the subcommand prefix (positional tokens before the first flag).
 */
function extractSubcommand(tokens: string[]): string[] {
  const sub: string[] = [];
  for (const t of tokens) {
    if (t.startsWith("-")) break;
    sub.push(t);
  }
  return sub;
}

/**
 * Check whether a tokenised command matches any entry in the allowlist.
 *
 * The command's leading positional tokens must start with an allowed prefix.
 * Extra positional args after the prefix are fine (e.g. "route add model endpoint").
 */
function isAllowed(tokens: string[]): boolean {
  // Strip a leading "bitrouter" token if the user included it.
  const effective =
    tokens.length > 0 && tokens[0] === "bitrouter" ? tokens.slice(1) : tokens;

  const sub = extractSubcommand(effective);
  if (sub.length === 0) return false;

  return ALLOWED_COMMANDS.some((allowed) => {
    if (sub.length < allowed.length) return false;
    return allowed.every((tok, i) => sub[i] === tok);
  });
}

/**
 * Return the CLI args to pass to the binary (stripping a leading "bitrouter" token).
 */
function toCliArgs(tokens: string[]): string[] {
  if (tokens.length > 0 && tokens[0] === "bitrouter") {
    return tokens.slice(1);
  }
  return tokens;
}

// ── CLI execution ────────────────────────────────────────────────────

/** Cached binary path — resolved once per process. */
let cachedBinaryPath: string | null = null;
let cachedStateDir: string | null = null;

async function getBinaryPath(stateDir: string): Promise<string> {
  if (cachedBinaryPath && cachedStateDir === stateDir) {
    return cachedBinaryPath;
  }
  cachedBinaryPath = await resolveBinaryPath(stateDir);
  cachedStateDir = stateDir;
  return cachedBinaryPath;
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(
  stateDir: string,
  homeDir: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<CliResult> {
  const binaryPath = await getBinaryPath(stateDir);
  return new Promise((resolve) => {
    execFile(
      binaryPath,
      ["--home-dir", homeDir, ...args],
      { timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err && "code" in err && typeof err.code === "number") {
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode: err.code,
          });
        } else if (err) {
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? err.message,
            exitCode: 1,
          });
        } else {
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 });
        }
      },
    );
  });
}

// ── Tool parameters ──────────────────────────────────────────────────

const BitrouterToolParameters = {
  type: "object" as const,
  required: ["command"],
  properties: {
    command: {
      type: "string" as const,
      description:
        "BitRouter CLI command to execute. Examples: " +
        '"status", "models list", "route add research openai:gpt-4o", ' +
        '"route rm research", "wallet list", "policy show --id default".',
    },
  },
};

// ── Tool factory ─────────────────────────────────────────────────────

/**
 * Create the unified `bitrouter` agent tool.
 *
 * The tool dispatches safe CLI commands to the BitRouter binary and
 * returns the output. Destructive commands are rejected before execution.
 */
export function createBitrouterTool(
  state: BitrouterState,
  stateDirRef: { value: string },
): AnyAgentTool {
  return {
    name: "bitrouter",
    label: "BitRouter CLI",
    displaySummary: "Manage BitRouter routes, models, tools, and policies",
    description:
      "Execute BitRouter CLI commands. Use this tool to inspect and manage the BitRouter " +
      "LLM proxy — list models, manage routes, check agent status, view policies, etc.\n\n" +
      "Available commands:\n  " +
      ALLOWED_COMMANDS_DESCRIPTION +
      "\n\nExamples:\n" +
      '  command: "status"\n' +
      '  command: "models list"\n' +
      '  command: "route add fast openai:gpt-4o-mini"\n' +
      '  command: "route add research openai:o3 anthropic:claude-opus-4-20250514 --strategy load_balance"\n' +
      '  command: "route rm fast"\n' +
      '  command: "wallet list"\n' +
      '  command: "policy show --id default"',
    parameters: BitrouterToolParameters,

    execute: async (
      _toolCallId: string,
      params: { command?: string },
      signal?: AbortSignal,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details: { exitCode: number };
    }> => {
      const raw = (params.command ?? "").trim();
      if (!raw) {
        return {
          content: [
            {
              type: "text",
              text: "Error: empty command. Provide a BitRouter CLI command.",
            },
          ],
          details: { exitCode: 1 },
        };
      }

      const tokens = tokenize(raw);
      if (!isAllowed(tokens)) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error: command "${raw}" is not allowed. ` +
                "Only read-only and route management commands are permitted.\n\n" +
                "Allowed commands:\n  " +
                ALLOWED_COMMANDS_DESCRIPTION,
            },
          ],
          details: { exitCode: 1 },
        };
      }

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Aborted." }],
          details: { exitCode: 130 },
        };
      }

      const args = toCliArgs(tokens);
      const result = await runCli(stateDirRef.value, state.homeDir, args);

      const parts: string[] = [];
      if (result.stdout.trim()) {
        parts.push(result.stdout.trim());
      }
      if (result.stderr.trim()) {
        parts.push(`[stderr] ${result.stderr.trim()}`);
      }
      if (parts.length === 0) {
        parts.push(
          result.exitCode === 0
            ? "Command completed successfully (no output)."
            : "Command failed with no output.",
        );
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: { exitCode: result.exitCode },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}
