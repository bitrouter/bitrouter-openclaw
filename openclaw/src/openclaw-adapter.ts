/**
 * OpenClaw real-API adapter.
 *
 * Bridges the plugin's stub API surface (types.ts) to the real OpenClaw
 * plugin API without modifying any plugin logic.
 *
 * Translations:
 *   stub api.getConfig()                 ← real api.pluginConfig
 *   stub api.getDataDir()                ← service ctx.stateDir (captured at start)
 *   stub api.log.*                       ← real api.logger.*
 *   stub api.registerService(opts)       ← real api.registerService({ id, start(ctx), stop(ctx) })
 *   stub api.registerProvider(opts)      ← real api.registerProvider(ProviderPlugin)
 *   stub api.on("before_model_resolve")  ← real api.on("before_model_resolve", ...)
 *   stub api.registerTool(def)           ← real api.registerTool(factory)
 *   stub api.registerHttpRoute(opts)     ← real api.registerHttpRoute({ path, auth, handler })
 *   stub api.registerGatewayMethod       ← real api.registerGatewayMethod (passthrough)
 *   stub api.registerCli(fn, opts)       ← real api.registerCli (passthrough)
 *
 * Provider auth context:
 *   The real ProviderAuthContext (with WizardPrompter) is passed directly
 *   through to setup.ts wizard functions — no adaptation needed there.
 */

import * as http from "node:http";
import type {
  OpenClawPluginApi as RealApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  ProviderAuthContext as RealProviderAuthContext,
  ProviderAuthResult as RealProviderAuthResult,
} from "openclaw/plugin-sdk";
import type { OpenClawPluginApi as StubApi } from "./types.js";
import { activate } from "./index.js";

function buildStubApi(real: RealApi, stateDirRef: { value: string }): StubApi {
  return {
    getConfig() {
      return (real.pluginConfig ?? {}) as ReturnType<StubApi["getConfig"]>;
    },

    getDataDir() {
      return stateDirRef.value;
    },

    log: {
      info: (msg: string) => real.logger.info(msg),
      warn: (msg: string) => real.logger.warn(msg),
      error: (msg: string) => real.logger.error(msg),
    },

    registerService(opts) {
      const svc: OpenClawPluginService = {
        id: opts.id,
        start: async (ctx: OpenClawPluginServiceContext) => {
          stateDirRef.value = ctx.stateDir;
          await opts.start();
        },
        stop: async (_ctx: OpenClawPluginServiceContext) => {
          await opts.stop();
        },
      };
      real.registerService(svc);
    },

    registerProvider(opts) {
      // The real ProviderPlugin shape does not have a top-level baseUrl.
      // BitRouter's URL is managed via service config; the provider registration
      // here is for auth method discovery and model routing metadata only.
      //
      // Auth methods: the stub ProviderAuthMethod.run receives a stub
      // ProviderAuthContext, but we pass the real one straight through because
      // our setup.ts wizard functions (byokWizard, cloudStub) use the real
      // WizardPrompter interface directly.
      real.registerProvider({
        id: opts.id,
        label: opts.label,
        auth: (opts.auth ?? []).map((method) => ({
          id: method.id,
          label: method.label,
          hint: method.hint,
          kind: method.kind,
          run: async (ctx: RealProviderAuthContext): Promise<RealProviderAuthResult> => {
            // Cast the real ctx to our stub type — structurally compatible since
            // our stub ProviderAuthContext now mirrors the real one closely.
            const result = await method.run(ctx as unknown as Parameters<typeof method.run>[0]);
            // Cast result back — same shape, configPatch is Partial<OpenClawConfig>
            // and we produce Record<string,unknown> which is assignable.
            return result as unknown as RealProviderAuthResult;
          },
        })),
      });
    },

    on(event, handler) {
      if (event !== "before_model_resolve") return;

      // Real before_model_resolve: event = { prompt }, return { modelOverride?, providerOverride? }
      // Stub: event = { model, override(opts) }
      // We derive the model name from the agent's configured primary model in config.
      real.on(
        "before_model_resolve",
        (
          _event: { prompt: string },
          ctx: { agentId?: string }
        ): { modelOverride?: string; providerOverride?: string } | void => {
          const agentId = ctx.agentId ?? "main";

          // Resolve the configured model name for this agent from OpenClaw config
          const agentList = (real.config as {
            agents?: {
              list?: Array<{
                id: string;
                model?: { primary?: string } | string;
              }>;
              defaults?: { model?: { primary?: string } | string };
            };
          }).agents;

          const agentEntry = agentList?.list?.find((a) => a.id === agentId);
          const agentModel = agentEntry?.model;
          const defaultModel = agentList?.defaults?.model;

          const resolveModel = (m: unknown): string | undefined => {
            if (typeof m === "string") return m;
            if (m && typeof m === "object" && "primary" in m) {
              return (m as { primary?: string }).primary;
            }
            return undefined;
          };

          const fullModel =
            resolveModel(agentModel) ?? resolveModel(defaultModel) ?? "default";

          // Strip provider prefix (e.g. "openrouter/auto" → "auto")
          const modelName = fullModel.includes("/")
            ? fullModel.split("/").slice(1).join("/")
            : fullModel;

          let result: { providerOverride?: string; modelOverride?: string } | undefined;

          const stubEvent = {
            model: modelName,
            override(opts: { provider: string; model?: string }) {
              result = {
                providerOverride: opts.provider,
                modelOverride: opts.model,
              };
            },
          };

          (handler as (e: typeof stubEvent) => void)(stubEvent);
          return result;
        }
      );
    },

    registerTool(definition, opts?: { optional?: boolean }) {
      // Real AgentTool.execute signature: (toolCallId, params, signal?, onUpdate?)
      real.registerTool(
        (_ctx: unknown) =>
          ({
            name: definition.name,
            label: definition.name,
            description: definition.description,
            parameters: definition.parameters as never,
            execute: async (
              toolCallId: string,
              params: Record<string, unknown>
            ) => {
              const res = await definition.execute(toolCallId, params);
              const text = res.content.map((c) => c.text).join("\n");
              return res.isError
                ? { type: "text" as const, text: `Error: ${text}` }
                : { type: "text" as const, text };
            },
          } as never),
        { optional: opts?.optional }
      );
    },

    registerHttpRoute(opts) {
      // Real: handler is (req: IncomingMessage, res: ServerResponse) => Promise<boolean|void>
      real.registerHttpRoute({
        path: opts.path,
        auth: "gateway",
        handler: async (
          req: http.IncomingMessage,
          res: http.ServerResponse
        ): Promise<boolean | void> => {
          if (req.method !== opts.method) return false;

          const rawBody = await new Promise<string>((resolve) => {
            let data = "";
            req.on("data", (chunk: Buffer | string) => (data += chunk));
            req.on("end", () => resolve(data));
          });

          let parsedBody: unknown;
          try {
            parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
          } catch {
            parsedBody = rawBody;
          }

          const url = new URL(req.url ?? "/", "http://localhost");
          const query: Record<string, string> = {};
          url.searchParams.forEach((v, k) => {
            query[k] = v;
          });

          const result = await opts.handler({ body: parsedBody, query });
          res.writeHead(result.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result.body));
          return true;
        },
      });
    },

    registerGatewayMethod(name, handler) {
      real.registerGatewayMethod(name, handler as never);
    },

    registerCli(registrar, opts) {
      // Pass through directly — real API has the same signature.
      real.registerCli(registrar as never, opts);
    },
  };
}

/**
 * OpenClaw plugin definition.
 * `register(api)` is called by OpenClaw when the plugin loads.
 */
const plugin = {
  id: "bitrouter",
  name: "BitRouter",
  description:
    "Route LLM requests through BitRouter — a local multi-provider proxy with " +
    "failover, load balancing, and unified API key management.",

  register(api: RealApi): void {
    const stateDirRef = {
      value: `${process.env.HOME}/.openclaw/plugins/bitrouter`,
    };
    const stubApi = buildStubApi(api, stateDirRef);
    activate(stubApi);
  },
};

export default plugin;
