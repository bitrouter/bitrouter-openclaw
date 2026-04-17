import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../src/binary.js", () => ({
  findSystemBinary: vi.fn(() => null),
}));

import { spawn } from "node:child_process";
import { createBitrouterInstallTool } from "../src/bitrouter-install-tool.js";
import { findSystemBinary } from "../src/binary.js";

function mockSpawn(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}) {
  (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
      if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
      child.emit("close", opts.exitCode ?? 0);
    });
    return child;
  });
}

describe("bitrouter_install tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a tool with the expected metadata", () => {
    const tool = createBitrouterInstallTool();
    expect(tool.name).toBe("bitrouter_install");
    expect(tool.label).toBe("Install BitRouter");
    expect(tool.description).toContain("install");
    expect(tool.description).toContain("https://bitrouter.ai/install.sh");
  });

  it("reports a fresh install when binary appears after install", async () => {
    const findMock = findSystemBinary as unknown as ReturnType<typeof vi.fn>;
    findMock
      .mockReturnValueOnce(null) // before
      .mockReturnValueOnce("/usr/local/bin/bitrouter"); // after
    mockSpawn({ stdout: "downloading...\ninstalled\n", exitCode: 0 });

    const tool = createBitrouterInstallTool();
    const result = await tool.execute("call-install-1", {});

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.details.exitCode).toBe(0);
    expect(result.content[0].text).toContain("BitRouter installed");
    expect(result.content[0].text).toContain("/usr/local/bin/bitrouter");
  });

  it("reports an update when binary already existed", async () => {
    const findMock = findSystemBinary as unknown as ReturnType<typeof vi.fn>;
    findMock
      .mockReturnValueOnce("/usr/local/bin/bitrouter")
      .mockReturnValueOnce("/usr/local/bin/bitrouter");
    mockSpawn({ stdout: "updated\n", exitCode: 0 });

    const tool = createBitrouterInstallTool();
    const result = await tool.execute("call-install-2", {});

    expect(result.details.exitCode).toBe(0);
    expect(result.content[0].text).toContain("BitRouter updated");
  });

  it("reports installer failure", async () => {
    const findMock = findSystemBinary as unknown as ReturnType<typeof vi.fn>;
    findMock.mockReturnValue(null);
    mockSpawn({ stderr: "network error\n", exitCode: 1 });

    const tool = createBitrouterInstallTool();
    const result = await tool.execute("call-install-3", {});

    expect(result.details.exitCode).toBe(1);
    expect(result.content[0].text).toContain("Installer failed");
    expect(result.content[0].text).toContain("network error");
  });

  it("warns when installer reports success but binary still missing", async () => {
    const findMock = findSystemBinary as unknown as ReturnType<typeof vi.fn>;
    findMock.mockReturnValue(null);
    mockSpawn({ stdout: "done\n", exitCode: 0 });

    const tool = createBitrouterInstallTool();
    const result = await tool.execute("call-install-4", {});

    expect(result.details.exitCode).toBe(0);
    expect(result.content[0].text).toContain("still not on $PATH");
  });

  it("respects abort signal", async () => {
    const tool = createBitrouterInstallTool();
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute("call-install-5", {}, controller.signal);

    expect(spawn).not.toHaveBeenCalled();
    expect(result.details.exitCode).toBe(130);
    expect(result.content[0].text).toBe("Aborted.");
  });
});
