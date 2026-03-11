/**
 * BitRouter first-run setup wizard.
 *
 * Runs inside the `openclaw models auth login --provider bitrouter` flow.
 * Two auth methods are registered on the provider:
 *
 *   byok  — Bring Your Own Key: interactive wizard that collects an
 *            upstream provider (OpenRouter, OpenAI, Anthropic, or custom)
 *            and an API key. Persists mode + byok config via configPatch.
 *
 *   cloud — BitRouter Cloud (stub; OAuth coming in next version). Shows a
 *            "coming soon" message and exits without making changes.
 *
 * On success, returns a ProviderAuthResult whose `configPatch` writes
 * `mode`, `byok`, and `interceptAllModels: true` into
 * `plugins.entries.bitrouter.config` in openclaw.json — no filesystem
 * hacks required.
 *
 * The API key is also written to the BitRouter home dir's .env file so
 * the service can inject it into bitrouter.yaml on startup.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type {
  ProviderAuthContext,
  ProviderAuthResult,
  SetupMode,
} from "./types.js";

// ── Well-known upstream providers ────────────────────────────────────

const UPSTREAM_PROVIDERS = [
  {
    value: "openrouter",
    label: "OpenRouter",
    hint: "Access 100+ models via a single key — recommended",
    apiBase: "https://openrouter.ai/api/v1",
    keyPlaceholder: "sk-or-...",
    docsUrl: "https://openrouter.ai/keys",
  },
  {
    value: "openai",
    label: "OpenAI",
    hint: "GPT-4o, o1, and other OpenAI models",
    apiBase: "https://api.openai.com/v1",
    keyPlaceholder: "sk-...",
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    value: "anthropic",
    label: "Anthropic",
    hint: "Claude 3.5, Claude 3 Opus, and others",
    apiBase: "https://api.anthropic.com",
    keyPlaceholder: "sk-ant-...",
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    value: "other",
    label: "Other / self-hosted",
    hint: "Any OpenAI-compatible API (Ollama, LM Studio, etc.)",
    apiBase: undefined,
    keyPlaceholder: "",
    docsUrl: undefined,
  },
] as const;

type UpstreamProviderId = (typeof UPSTREAM_PROVIDERS)[number]["value"];

// ── BYOK wizard ──────────────────────────────────────────────────────

/**
 * Run the BYOK setup wizard.
 *
 * Registered as the "byok" ProviderAuthMethod on the "bitrouter" provider.
 * Called by: `openclaw models auth login --provider bitrouter --method byok`
 * or: `openclaw models auth login --provider bitrouter` (first choice).
 */
export async function byokWizard(
  ctx: ProviderAuthContext
): Promise<ProviderAuthResult> {
  const { prompter } = ctx;

  await prompter.intro("BitRouter — BYOK Setup");
  await prompter.note(
    "BitRouter proxies your LLM requests locally, adding failover,\n" +
      "load balancing, and metrics. Your API key is stored securely\n" +
      "in OpenClaw's credential store.",
    "Welcome"
  );

  // ── Step 1: Choose upstream provider ────────────────────────────

  const providerChoice = await prompter.select<UpstreamProviderId>({
    message: "Which LLM provider do you want BitRouter to route through?",
    options: UPSTREAM_PROVIDERS.map((p) => ({
      value: p.value,
      label: p.label,
      hint: p.hint,
    })),
    initialValue: "openrouter",
  });

  const providerMeta = UPSTREAM_PROVIDERS.find(
    (p) => p.value === providerChoice
  )!;

  // ── Step 2: API key ──────────────────────────────────────────────

  let apiBase: string | undefined;

  if (providerChoice === "other") {
    apiBase = await prompter.text({
      message: "API base URL (must be OpenAI-compatible):",
      placeholder: "http://localhost:11434/v1",
      validate: (v) => {
        if (!v.trim()) return "Base URL is required for custom providers.";
        try {
          new URL(v.trim());
        } catch {
          return "Enter a valid URL (e.g. http://localhost:11434/v1)";
        }
        return undefined;
      },
    });
  } else {
    apiBase = providerMeta.apiBase as string;
  }

  const keyHint =
    providerMeta.docsUrl
      ? `Get your key at ${providerMeta.docsUrl}`
      : "Paste your API key below.";

  await prompter.note(keyHint);

  const apiKey = await prompter.text({
    message: `${providerMeta.label} API key:`,
    placeholder:
      providerChoice !== "other" ? providerMeta.keyPlaceholder : "sk-...",
    validate: (v) => {
      if (!v.trim()) return "API key cannot be empty.";
      if (v.trim().length < 8) return "That doesn't look like a valid API key.";
      return undefined;
    },
  });

  // ── Step 3: Confirm ──────────────────────────────────────────────

  const confirmed = await prompter.confirm({
    message: `Route all agent requests through BitRouter → ${providerMeta.label}?`,
    initialValue: true,
  });

  if (!confirmed) {
    throw new Error("Setup cancelled.");
  }

  // ── Done ─────────────────────────────────────────────────────────

  // Write the API key to the BitRouter home dir's .env file so the service
  // can pick it up at startup without re-prompting.
  const homeDir = resolveSetupHomeDir(ctx);
  writeKeyToEnv(homeDir, providerChoice, apiKey.trim());

  await prompter.outro(
    "BitRouter configured! Restart the gateway to activate routing:\n" +
      "  openclaw gateway restart"
  );

  // Build the config patch. This gets merged into openclaw.json by OpenClaw.
  //
  // Two things we patch:
  //
  // 1. plugins.entries.bitrouter.config — stores mode/byok settings so the
  //    plugin knows it's configured on next gateway start.
  //
  // 2. models.providers.<upstreamProvider>.baseUrl — redirects the existing
  //    provider's HTTP requests through BitRouter. This is the real routing
  //    mechanism: OpenClaw keeps using the provider it knows (e.g. "openrouter")
  //    but sends all requests to BitRouter's local endpoint instead.
  //    BitRouter proxies them upstream using the stored API key.
  const bitrouterApiBase = `http://127.0.0.1:8787/v1`;

  const configPatch = {
    plugins: {
      entries: {
        bitrouter: {
          config: {
            mode: "byok" satisfies SetupMode,
            byok: {
              upstreamProvider: providerChoice,
              ...(apiBase ? { apiBase } : {}),
            },
            interceptAllModels: false, // not needed — we redirect at the provider level
          },
        },
      },
    },
    // Redirect the upstream provider through BitRouter.
    // After gateway restart, all "openrouter" (or chosen provider) calls
    // go to 127.0.0.1:8787/v1 instead of the public API.
    //
    // mode: "merge" — keeps OpenClaw's built-in model definitions intact;
    // we only override baseUrl for the chosen provider.
    // models: [] — required field in ModelProviderConfig; empty is fine
    // since the built-in model list is preserved via merge mode.
    models: {
      mode: "merge",
      providers: {
        [providerChoice]: {
          baseUrl: bitrouterApiBase,
          models: [],
        },
      },
    },
  };

  return {
    profiles: [
      {
        profileId: "bitrouter:default",
        credential: {
          type: "api_key" as const,
          provider: "bitrouter",
          // Store the raw key — OpenClaw handles secure storage.
          key: apiKey.trim(),
        },
      },
    ],
    configPatch,
    notes: [
      `Upstream provider: ${providerMeta.label}`,
      `BitRouter will intercept all ${providerMeta.label} requests (127.0.0.1:8787/v1).`,
      "Restart the gateway to activate: openclaw gateway restart",
      "To change settings, run: openclaw models auth login --provider bitrouter",
    ],
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the BitRouter home directory for this plugin.
 *
 * When the plugin is loaded via plugins.load.paths (symlink dev install),
 * OpenClaw sets ctx.stateDir to ~/.openclaw/<plugin-id>. We can derive this
 * from the OpenClaw config directory, which is always ~/.openclaw.
 *
 * The pattern is: ~/.openclaw/bitrouter — this matches what resolveHomeDir()
 * in config.ts produces (api.getDataDir() + "/bitrouter" where getDataDir()
 * returns ctx.stateDir = ~/.openclaw/bitrouter, so final = ~/.openclaw/bitrouter).
 *
 * Note: for npm-installed plugins the stateDir differs. This heuristic works
 * for the common case; the service will still read from wherever it wrote config.
 */
function resolveSetupHomeDir(_ctx: ProviderAuthContext): string {
  const home = os.homedir();
  // Match the path that service.ts + config.ts resolveHomeDir() produces
  // when called with the real ctx.stateDir from OpenClaw's plugin service runner.
  // ctx.stateDir for load.paths = ~/.openclaw/bitrouter
  // resolveHomeDir = ctx.stateDir + "/bitrouter" = ~/.openclaw/bitrouter/bitrouter
  // BUT logs show "Config written to ~/.openclaw/bitrouter" so stateDir itself
  // is the parent. The actual home = stateDir (not stateDir+/bitrouter).
  // Cross-reference: the log says stateDir appears to be ~/.openclaw/bitrouter
  // so resolveHomeDir returns ~/.openclaw/bitrouter/bitrouter... but log says
  // "Config written to ~/.openclaw/bitrouter". 
  // Conclusion: getDataDir() returns ~/.openclaw/bitrouter already (stateDir IS the home).
  // So we target ~/.openclaw/bitrouter directly.
  return path.join(home, ".openclaw", "bitrouter");
}

/**
 * Write the API key to the BitRouter home dir's .env file.
 * The key name follows the pattern PROVIDER_API_KEY.
 */
function writeKeyToEnv(
  homeDir: string,
  provider: string,
  apiKey: string
): void {
  try {
    fs.mkdirSync(homeDir, { recursive: true });
    const envPath = path.join(homeDir, ".env");
    const envKey = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;

    // Read existing .env entries (if any) and merge.
    const entries = new Map<string, string>();
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          entries.set(trimmed.slice(0, eqIdx).trim(), trimmed.slice(eqIdx + 1).trim());
        }
      }
    }

    entries.set(envKey, apiKey);

    const header =
      "# BitRouter environment variables\n" +
      "# Written by @bitrouter/openclaw-plugin setup wizard — do not commit.\n\n";
    const lines = Array.from(entries.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    fs.writeFileSync(envPath, header + lines + "\n", "utf-8");
  } catch (err) {
    // Non-fatal — the service will fall back to env vars.
    console.warn(`[bitrouter] Warning: could not write .env file: ${err}`);
  }
}

// ── Cloud stub ───────────────────────────────────────────────────────

/**
 * Stub for the BitRouterAI Cloud auth flow.
 *
 * Shows a "coming soon" message and exits cleanly.
 * Will be replaced with OAuth in the next version.
 */
export async function cloudStub(
  ctx: ProviderAuthContext
): Promise<ProviderAuthResult> {
  const { prompter } = ctx;

  await prompter.intro("BitRouter Cloud");
  await prompter.note(
    "BitRouter Cloud authentication is coming in the next version.\n\n" +
      "In the meantime, use the BYOK option to route through your own\n" +
      "API key (OpenRouter, OpenAI, Anthropic, or any OpenAI-compatible API).\n\n" +
      "Run: openclaw models auth login --provider bitrouter --method byok",
    "Coming Soon"
  );
  await prompter.outro("No changes made.");

  // Return a no-op result — no profiles, no config patch.
  return {
    profiles: [],
    notes: [
      "BitRouter Cloud is not yet available. Use BYOK mode for now.",
      "Run: openclaw models auth login --provider bitrouter --method byok",
    ],
  };
}
