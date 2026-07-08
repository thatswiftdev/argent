import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Registry, ToolContext } from "@argent/registry";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// ── mock spawn at module level ───────────────────────────────────────
// ESM module namespaces aren't configurable, so vi.spyOn won't work.
// vi.mock replaces the module before imports resolve.

class FakeChildProcess extends EventEmitter {
  killed = false;
  kill(_signal?: string): boolean {
    this.killed = true;
    setTimeout(() => this.emit("exit", 0), 10);
    return true;
  }
  get pid() {
    return 12345;
  }
}

let lastSpawnedChild = new FakeChildProcess();
let spawnCallCount = 0;
let lastSpawnArgs: { cmd: string; args: string[] } | null = null;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      spawnCallCount++;
      lastSpawnArgs = { cmd: args[0], args: args[1] as string[] };
      return lastSpawnedChild as unknown as ReturnType<typeof actual.spawn>;
    },
  };
});

// ── import after mock ────────────────────────────────────────────────
const { createStartVideoRecordingTool } = await import("../src/tools/video-recording/start");
const { createStopVideoRecordingTool } = await import("../src/tools/video-recording/stop");
const { getSession, killAllSessions } = await import("../src/tools/video-recording/session");

// ── helpers ──────────────────────────────────────────────────────────

function createMockRegistry(): Registry {
  return {
    invokeTool: vi.fn(),
    getTool: vi.fn(),
  } as unknown as Registry;
}

async function createTempVideo(): Promise<string> {
  const dir = path.join(os.tmpdir(), "argent-recordings-test");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `test-${process.hrtime.bigint()}.mp4`);
  await fs.writeFile(file, Buffer.from("fake mp4 data"));
  return file;
}

const IOS_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

function createCtxWithArtifacts(): Partial<ToolContext> {
  return {
    artifacts: {
      register: vi.fn(async (hostPath: string, opts?: { filename?: string; mimeType?: string }) => ({
        __argentArtifact: true as const,
        id: "test-artifact-id",
        filename: opts?.filename ?? path.basename(hostPath),
        mimeType: opts?.mimeType ?? "video/mp4",
        size: 1234,
        hostPath,
      })),
      get: vi.fn(),
      list: vi.fn(),
    } as any,
  };
}

function resetSpawnMock() {
  lastSpawnedChild = new FakeChildProcess();
  spawnCallCount = 0;
  lastSpawnArgs = null;
}

// ── tests ────────────────────────────────────────────────────────────

describe("start-video-recording", () => {
  beforeEach(() => {
    killAllSessions();
    vi.clearAllMocks();
    resetSpawnMock();
  });

  afterEach(() => {
    killAllSessions();
  });

  it("starts a recording and returns a session id", async () => {
    const registry = createMockRegistry();
    const tool = createStartVideoRecordingTool(registry);

    const result = await tool.execute({} as any, { udid: IOS_UDID, codec: "h264" });

    expect(result.sessionId).toBe(IOS_UDID);
    expect(result.outputPath).toMatch(/\.mp4$/);
    expect(spawnCallCount).toBe(1);
    expect(lastSpawnArgs!.cmd).toBe("xcrun");
    expect(lastSpawnArgs!.args).toContain("recordVideo");
    expect(lastSpawnArgs!.args).toContain("--codec=h264");
    expect(getSession(IOS_UDID)).toBeDefined();
  });

  it("uses hevc codec by default", async () => {
    const registry = createMockRegistry();
    const tool = createStartVideoRecordingTool(registry);

    await tool.execute({} as any, { udid: IOS_UDID });

    expect(lastSpawnArgs!.args).toContain("--codec=hevc");
  });

  it("rejects a second recording on the same device", async () => {
    const registry = createMockRegistry();
    const tool = createStartVideoRecordingTool(registry);

    await tool.execute({} as any, { udid: IOS_UDID });

    await expect(
      tool.execute({} as any, { udid: IOS_UDID })
    ).rejects.toThrow(/already active/);
  });
});

describe("stop-video-recording", () => {
  beforeEach(() => {
    killAllSessions();
    vi.clearAllMocks();
    resetSpawnMock();
  });

  afterEach(() => {
    killAllSessions();
  });

  it("stops a recording and returns an artifact", async () => {
    const registry = createMockRegistry();
    const startTool = createStartVideoRecordingTool(registry);
    const stopTool = createStopVideoRecordingTool(registry);

    // Start recording
    await startTool.execute({} as any, { udid: IOS_UDID });

    // Replace the output path with a real temp file so stat works
    const session = getSession(IOS_UDID)!;
    const tempFile = await createTempVideo();
    session.outputPath = tempFile;
    session.process = lastSpawnedChild as unknown as ChildProcess;

    const ctx = createCtxWithArtifacts();
    const result = await stopTool.execute({} as any, { udid: IOS_UDID }, ctx as ToolContext);

    expect(result.video).toBeDefined();
    expect(result.video.mimeType).toBe("video/mp4");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.message).toMatch(/Recording saved/);
    expect(getSession(IOS_UDID)).toBeUndefined();
  });

  it("fails when no recording is active", async () => {
    const registry = createMockRegistry();
    const stopTool = createStopVideoRecordingTool(registry);

    await expect(
      stopTool.execute({} as any, { udid: IOS_UDID }, createCtxWithArtifacts() as ToolContext)
    ).rejects.toThrow(/No active video recording/);
  });

  it("uses custom label for filename", async () => {
    const registry = createMockRegistry();
    const startTool = createStartVideoRecordingTool(registry);
    const stopTool = createStopVideoRecordingTool(registry);

    await startTool.execute({} as any, { udid: IOS_UDID });

    const session = getSession(IOS_UDID)!;
    const tempFile = await createTempVideo();
    session.outputPath = tempFile;
    session.process = lastSpawnedChild as unknown as ChildProcess;

    const ctx = createCtxWithArtifacts();
    await stopTool.execute({} as any, { udid: IOS_UDID, label: "CUST-4324-verify" }, ctx as ToolContext);

    expect(ctx.artifacts!.register).toHaveBeenCalledWith(
      tempFile,
      expect.objectContaining({ filename: "CUST-4324-verify.mp4", mimeType: "video/mp4" })
    );
  });
});
