/**
 * @bitrouter/openclaw-plugin — entry point.
 *
 * This is the main export that OpenClaw calls when the plugin is loaded.
 * It wires together all sub-modules:
 *
 *   - service.ts  → daemon lifecycle (spawn/stop bitrouter)
 *   - provider.ts → register "bitrouter" as an LLM provider
 *   - routing.ts  → before_model_resolve hook for selective interception
 *   - config.ts   → generate bitrouter.yaml from plugin config
 *   - health.ts   → periodic health checks and readiness polling
 *   - setup.ts    → first-run wizard (BYOK / Cloud)
 *
 * First-run behaviour:
 *   If config.mode is unset (plugin never configured), the plugin:
 *     1. Registers the "bitrouter" provider with both auth methods
 *        (so `openclaw models auth login --provider bitrouter` works)
 *     2. Registers a `openclaw bitrouter setup` CLI alias
 *     3. Logs a clear hint and returns early — daemon is NOT started,
 *        tools are NOT registered, model interception is OFF.
 *
 *   After the wizard runs (writes configPatch → openclaw.json) and the
 *   gateway is restarted, config.mode will be set and full activation runs.
 *
 * The plugin degrades gracefully:
 *   - If the binary isn't found, logs an error but still registers
 *     the provider and hook (the user may be running BitRouter externally).
 *   - If health checks fail, the routing hook becomes a no-op (falls
 *     through to OpenClaw's native model resolution).
 */

import type {
  BitrouterPluginConfig,
  BitrouterState,
  OpenClawPluginApi,
} from "./types.js";
import { DEFAULTS } from "./types.js";
import { resolveHomeDir } from "./config.js";
import { registerBitrouterService } from "./service.js";
import { registerBitrouterProvider } from "./provider.js";
import { registerModelInterceptor } from "./routing.js";
import { registerAgentTools } from "./tools.js";
import { registerFeedbackRoute } from "./feedback.js";
import { registerGatewayMethods } from "./gateway.js";

/**
 * Plugin activation — called by OpenClaw when the plugin is loaded.
 *
 * Registers the service, provider, and model routing hook. Each
 * registration is independent: a failure in one doesn't block the others.
 */
export function activate(api: OpenClawPluginApi): void {
  const config: BitrouterPluginConfig = api.getConfig();
  const host = config.host ?? DEFAULTS.host;
  const port = config.port ?? DEFAULTS.port;

  // Shared mutable state — passed by reference to all sub-modules.
  const state: BitrouterState = {
    process: null,
    healthy: false,
    baseUrl: `http://${host}:${port}`,
    knownRoutes: [],
    healthCheckTimer: null,
    homeDir: resolveHomeDir(api),
    dynamicRoutes: new Map(),
    metrics: null,
  };

  // ── Always register the provider so the auth wizard is reachable ──
  //
  // This must happen even before mode is checked, so the user can always
  // run `openclaw models auth login --provider bitrouter` regardless of
  // whether they've completed setup.
  try {
    registerBitrouterProvider(api, config, state);
  } catch (err) {
    api.log.error(`Failed to register BitRouter provider: ${err}`);
  }

  // ── Always register CLI alias ─────────────────────────────────────
  //
  // `openclaw bitrouter setup` is a discoverable alias for the wizard.
  try {
    api.registerCli(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ program }: { program: any }) => {
        program
          .command("bitrouter setup")
          .description(
            "Configure BitRouter (first-run setup wizard). " +
              "Equivalent to: openclaw models auth login --provider bitrouter"
          )
          .action(() => {
            // Print redirect hint — the actual wizard runs via models auth login.
            // We can't easily invoke it directly here without reimplementing
            // the auth flow runner, so we guide the user.
            console.log(
              "\nBitRouter setup wizard:\n" +
                "  openclaw models auth login --provider bitrouter\n\n" +
                "Choose 'BYOK' to enter your API key, or 'BitRouter Cloud'\n" +
                "to sign in (coming soon).\n"
            );
          });
      },
      { commands: ["bitrouter"] }
    );
  } catch (err) {
    // Non-fatal — CLI alias is a convenience, not required.
    api.log.warn(`Failed to register bitrouter CLI alias: ${err}`);
  }

  // ── Check if setup has been completed ────────────────────────────
  //
  // If mode is unset, emit a clear hint and stop here. The daemon won't
  // start and no tools or hooks will be registered until setup is done.
  if (!config.mode) {
    api.log.warn(
      "BitRouter plugin is installed but not yet configured. " +
        "Run: openclaw models auth login --provider bitrouter"
    );
    return;
  }

  // ── Full activation (mode is set) ────────────────────────────────

  // Register the daemon service (spawn/stop bitrouter).
  try {
    registerBitrouterService(api, config, state);
  } catch (err) {
    api.log.error(`Failed to register BitRouter service: ${err}`);
    // Continue — the user may run BitRouter externally.
  }

  // Hook into model resolution to selectively route through BitRouter.
  try {
    registerModelInterceptor(api, config, state);
  } catch (err) {
    api.log.error(`Failed to register model interceptor: ${err}`);
  }

  // Register agent tools for runtime route management.
  try {
    registerAgentTools(api, config, state);
  } catch (err) {
    api.log.error(`Failed to register agent tools: ${err}`);
  }

  // Register HTTP feedback endpoint.
  try {
    registerFeedbackRoute(api);
  } catch (err) {
    api.log.error(`Failed to register feedback route: ${err}`);
  }

  // Register gateway RPC methods.
  try {
    registerGatewayMethods(api, state);
  } catch (err) {
    api.log.error(`Failed to register gateway methods: ${err}`);
  }

  const upstream = config.byok?.upstreamProvider ?? "unknown";
  api.log.info(
    `BitRouter plugin activated (${state.baseUrl}, mode=${config.mode}, ` +
      `upstream=${upstream}, interceptAll=${config.interceptAllModels ?? DEFAULTS.interceptAllModels})`
  );
}

// Default export for OpenClaw plugin loading.
export default activate;
