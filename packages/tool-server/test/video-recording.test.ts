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
  // Write a fake MP4 with a moov atom so the finalize validator passes.
  await fs.writeFile(file, Buffer.concat([
    Buffer.from("ftypisom\x00\x00\x02\x00isomiso2"),
    Buffer.from("\x00\x00\x00\x08moov"),
    Buffer.from("mdat-fake-video-data"),
  ]));
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

// ── wedged-recorder recovery (escalation + session cleanup) ──────────

class WedgedChildProcess extends EventEmitter {
  killed: string[] = [];
  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGINT");
    if (signal === "SIGKILL") setTimeout(() => this.emit("exit", null, "SIGKILL"), 10);
    // SIGINT is IGNORED — the wedge this class simulates
    return true;
  }
  get pid() { return 12346; }
}

describe("stop-video-recording wedged recorder", () => {
  it("escalates to SIGKILL when SIGINT is ignored, clears the session, and errors honestly", async () => {
    // start a session whose process ignores SIGINT
    const wedged = new WedgedChildProcess();
    vi.mocked; // noop — spawn mock below returns our wedged child
    const { setSession, getSession } = await import("../src/tools/video-recording/session");
    const dir = path.join(os.tmpdir(), "argent-recordings-test");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `wedged-${process.hrtime.bigint()}.mp4`);
    await fs.writeFile(file, Buffer.from("ftypmdat-no-index")); // no moov
    setSession("AAAAAAAA-BBBB-CCCC-DDDD-FFFFFFFFFFFF", {
      process: wedged as unknown as ChildProcess,
      outputPath: file,
      udid: "AAAAAAAA-BBBB-CCCC-DDDD-FFFFFFFFFFFF",
      startedAt: Date.now(),
      codec: "h264",
    });

    const tool = createStopVideoRecordingTool(createMockRegistry());
    const ctx = createCtxWithArtifacts() as ToolContext;
    process.env.ARGENT_VIDEO_STOP_TIMEOUT_MS = "500";
    process.env.ARGENT_VIDEO_MOOV_POLL_ATTEMPTS = "3";
    try {
      await expect(tool.execute(undefined as never, { udid: "AAAAAAAA-BBBB-CCCC-DDDD-FFFFFFFFFFFF" }, ctx))
        .rejects.toThrow(/missing the moov atom|did not exit/);
    } finally {
      delete process.env.ARGENT_VIDEO_STOP_TIMEOUT_MS;
      delete process.env.ARGENT_VIDEO_MOOV_POLL_ATTEMPTS;
    }

    // SIGINT was tried first, SIGKILL escalated
    expect(wedged.killed[0]).toBe("SIGINT");
    expect(wedged.killed).toContain("SIGKILL");
    // session CLEARED despite failure — future starts are unblocked
    expect(getSession("AAAAAAAA-BBBB-CCCC-DDDD-FFFFFFFFFFFF")).toBeUndefined();
  });

  it("a failed stop no longer latches 'already active' — a fresh start works", async () => {
    const { getSession, setSession } = await import("../src/tools/video-recording/session");
    // after the wedged stop above, session store is empty for AAAAAAAA-BBBB-CCCC-DDDD-FFFFFFFFFFFF
    expect(getSession("AAAAAAAA-BBBB-CCCC-DDDD-FFFFFFFFFFFF")).toBeUndefined();
  });
});
