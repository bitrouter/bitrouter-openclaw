/**
 * `bitrouter_install` agent tool — installs or updates the system
 * `bitrouter` binary using the official installer scripts.
 *
 * Unix:    https://bitrouter.ai/install.sh
 * Windows: https://bitrouter.ai/install.ps1
 *
 * Split out from the unified `bitrouter` tool so the model gets a strong
 * one-line nudge to call this first when other bitrouter_* tools report a
 * missing binary.
 */

import { spawn } from "node:child_process";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { findSystemBinary } from "./binary.js";

const INSTALL_SH_URL = "https://bitrouter.ai/install.sh";
const INSTALL_PS1_URL = "https://bitrouter.ai/install.ps1";

interface InstallResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runInstaller(timeoutMs = 180_000): Promise<InstallResult> {
  const isWindows = process.platform === "win32";
  const command = isWindows ? "powershell.exe" : "sh";
  const args = isWindows
    ? [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `iwr -useb ${INSTALL_PS1_URL} | iex`,
      ]
    : ["-c", `curl -fsSL ${INSTALL_SH_URL} | sh`];

  return new Promise((resolve) => {
    const child = spawn(command, args, { timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      resolve({ stdout, stderr: stderr || err.message, exitCode: 1 });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

const InstallToolParameters = {
  type: "object" as const,
  properties: {},
};

/**
 * Create the `bitrouter_install` agent tool.
 *
 * Call this whenever the `bitrouter` tool reports the system binary is
 * missing, or when the user explicitly asks to install or update BitRouter.
 */
export function createBitrouterInstallTool(): AnyAgentTool {
  return {
    name: "bitrouter_install",
    label: "Install BitRouter",
    displaySummary: "Install or update the system bitrouter binary",
    description:
      "Install or update the system `bitrouter` binary by running the official " +
      "installer script (https://bitrouter.ai/install.sh on Unix, " +
      "https://bitrouter.ai/install.ps1 on Windows).\n\n" +
      "Call this tool BEFORE any other `bitrouter` tool if you receive an error " +
      "that the bitrouter binary is missing from $PATH. Also call it when the " +
      "user asks to install, reinstall, or update BitRouter.",
    parameters: InstallToolParameters,

    execute: async (
      _toolCallId: string,
      _params: Record<string, never>,
      signal?: AbortSignal,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details: { exitCode: number };
    }> => {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Aborted." }],
          details: { exitCode: 130 },
        };
      }

      const before = findSystemBinary();
      const result = await runInstaller();
      const after = findSystemBinary();

      const parts: string[] = [];
      if (result.stdout.trim()) parts.push(result.stdout.trim());
      if (result.stderr.trim()) {
        parts.push(`[stderr] ${result.stderr.trim()}`);
      }

      if (result.exitCode === 0 && after) {
        parts.push(
          before
            ? `BitRouter updated. Binary at: ${after}`
            : `BitRouter installed. Binary at: ${after}\n` +
                "If `bitrouter` is still not on $PATH in new shells, " +
                "add the installer's bin directory to your PATH " +
                "(commonly `~/.bitrouter/bin` or `~/.cargo/bin`).",
        );
      } else if (result.exitCode === 0 && !after) {
        parts.push(
          "Installer reported success but `bitrouter` is still not on $PATH. " +
            "You may need to open a new shell or add the install directory to PATH.",
        );
      } else {
        parts.push(
          `Installer failed (exit ${result.exitCode}). ` +
            `See ${INSTALL_SH_URL} or ${INSTALL_PS1_URL} for manual install.`,
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
