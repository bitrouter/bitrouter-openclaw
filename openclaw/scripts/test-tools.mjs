/**
 * Direct tool integration test — calls all 7 bitrouter tools through the
 * same adapter path used in production, without any LLM.
 *
 * Uses a lightweight mock of the real OpenClaw plugin API surface to capture
 * registered tools and invoke them directly.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../dist");

// ── Minimal mock of the real OpenClaw API ───────────────────────────────────

const stateDir = path.join(os.homedir(), ".openclaw/bitrouter");

const registeredTools = new Map();
const registeredServices = [];
let serviceCtx = null;

const mockApi = {
  pluginConfig: {},
  config: { agents: { list: [], defaults: { model: { primary: "openrouter/auto" } } } },
  logger: {
    info: (m) => console.log(`  [log:info]  ${m}`),
    warn: (m) => console.log(`  [log:warn]  ${m}`),
    error: (m) => console.error(`  [log:error] ${m}`),
  },
  registerService(svc) {
    registeredServices.push(svc);
  },
  registerProvider(opts) {
    console.log(`  [registerProvider] id=${opts.id} label=${opts.label}`);
  },
  on(event, handler) {
    console.log(`  [on] event=${event}`);
  },
  registerTool(factory, opts) {
    const tool = factory({});
    registeredTools.set(tool.name, { tool, opts });
    console.log(`  [registerTool] name=${tool.name} optional=${opts?.optional ?? false}`);
  },
  registerHttpRoute(opts) {
    console.log(`  [registerHttpRoute] path=${opts.path} auth=${opts.auth}`);
  },
  registerGatewayMethod(name, handler) {
    console.log(`  [registerGatewayMethod] name=${name}`);
  },
};

// ── Load plugin ─────────────────────────────────────────────────────────────

console.log("\n=== Loading plugin ===");
const adapterPath = path.join(distDir, "openclaw-adapter.js");
const { default: plugin } = await import(adapterPath);
console.log(`Plugin: ${plugin.id} — ${plugin.name}`);

console.log("\n=== Registering (activate) ===");
plugin.register(mockApi);

// Start the registered service so internal state is initialised
console.log("\n=== Starting service ===");
for (const svc of registeredServices) {
  await svc.start({ stateDir });
}

// Give BitRouter a moment to be ready
await new Promise((r) => setTimeout(r, 500));

console.log(`\n=== Registered tools (${registeredTools.size}) ===`);
for (const name of registeredTools.keys()) {
  console.log(`  - ${name}`);
}

// ── Helper ──────────────────────────────────────────────────────────────────

async function callTool(name, params) {
  const entry = registeredTools.get(name);
  if (!entry) throw new Error(`Tool not found: ${name}`);
  console.log(`\n--- ${name} ---`);
  console.log(`  params: ${JSON.stringify(params)}`);
  try {
    const result = await entry.tool.execute(`test-call-${name}`, params);
    console.log(`  result: ${JSON.stringify(result)}`);
    return result;
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    return { type: "text", text: `Error: ${err.message}` };
  }
}

// ── Run tests ───────────────────────────────────────────────────────────────

console.log("\n=== Tool Tests ===");

// 1. bitrouter_status
await callTool("bitrouter_status", {});

// 2. bitrouter_list_providers
await callTool("bitrouter_list_providers", {});

// 3. bitrouter_list_routes  (should be empty initially)
await callTool("bitrouter_list_routes", {});

// 4. bitrouter_create_route  (the previously broken one)
const createResult = await callTool("bitrouter_create_route", {
  model: "test-model",
  strategy: "priority",
  endpoints: [{ provider: "openai", modelId: "gpt-4o" }],
});

// 5. bitrouter_list_routes  (should show the new route)
await callTool("bitrouter_list_routes", {});

// 6. bitrouter_route_metrics
await callTool("bitrouter_route_metrics", { model: "test-model" });

// 7. bitrouter_route_task  (the previously broken one)
await callTool("bitrouter_route_task", {
  taskType: "coding",
  budgetHint: "cheap",
});

// 8. bitrouter_delete_route
await callTool("bitrouter_delete_route", { model: "test-model" });

// 9. bitrouter_list_routes  (should be empty again)
await callTool("bitrouter_list_routes", {});

// ── Stop service ────────────────────────────────────────────────────────────
console.log("\n=== Stopping service ===");
for (const svc of registeredServices) {
  await svc.stop({ stateDir });
}

console.log("\n=== Done ===");
