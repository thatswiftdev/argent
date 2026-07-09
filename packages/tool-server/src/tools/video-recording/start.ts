import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { assertSupported } from "../../utils/capability";
import { ensureDeps } from "../../utils/check-deps";
import { getSession, setSession, deleteSession } from "./session";

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Target device id from `list-devices` (iOS UDID)."
    ),
  codec: z
    .enum(["h264", "hevc"])
    .optional()
    .describe(
      "Video codec. 'hevc' (default) produces smaller files but some players don't support it. " +
        "'h264' is safer for sharing."
    ),
  mask: z
    .enum(["ignored", "alpha", "black"])
    .optional()
    .describe(
      "Mask policy for non-rectangular displays (iPhone notch/Dynamic Island). " +
        "'ignored' captures the full framebuffer. Default is 'alpha' (simctl default)."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  sessionId: string;
  message: string;
  outputPath: string;
}

const capability: ToolCapability = {
  apple: { simulator: true },
  appleRemote: { simulator: true },
};

/** Exit code simctl uses when a host recording is already active. */
const EXIT_HOST_RECORDING_ACTIVE = 16;

/**
 * Attempt to recover from a stuck host recording by killing any orphaned
 * `simctl io recordVideo` processes for this UDID. CoreSimulator enforces
 * one host recording per simulator — a crashed or orphaned process holds
 * that slot and every new attempt exits 16 until the simulator is restarted.
 *
 * We run `pkill` for the specific recordVideo + udid pattern rather than
 * restarting the simulator (which is disruptive and slow).
 */
function tryClearStuckRecording(udid: string): void {
  try {
    spawn("pkill", ["-f", `simctl io ${udid} recordVideo`], {
      stdio: "ignore",
    });
  } catch {
    // Best-effort — if pkill fails the caller will see exit 16 again.
  }
}

export function createStartVideoRecordingTool(
  _registry: Registry
): ToolDefinition<Params, Result> {
  return {
    id: "start-video-recording",
    description: `Start recording the iOS Simulator screen as a video. Spawns \`simctl io recordVideo\` in the background and returns immediately.
Use to capture app behavior during a verification flow. Call \`stop-video-recording\` with the returned sessionId to finalize and obtain the MP4.
Only one recording per device at a time. Fails if a recording is already active on the device, or if simctl is unavailable.
If a previous recording was orphaned (server crash, killed mid-record), the tool attempts automatic recovery before failing.
iOS Simulator only.`,
    searchHint: "video record capture screen movie mp4",
    zodSchema,
    outputHint: "text",
    capability,
    services: () => ({}),
    async execute(_services, params) {
      const device = resolveDevice(params.udid);
      assertSupported("start-video-recording", capability, device);
      await ensureDeps(["xcrun"]);

      const udid = params.udid;
      const codec = params.codec ?? "hevc";
      const mask = params.mask;

      // Reject if a recording is already active on this device in our session map.
      if (getSession(udid)) {
        throw new Error(
          `A video recording is already active on device ${udid}. Call \`stop-video-recording\` first.`
        );
      }

      // Build the output path.
      const sessionId = `${udid.slice(0, 8)}-${process.hrtime.bigint()}`;
      const dir = path.join(os.tmpdir(), "argent-recordings");
      const outputPath = path.join(dir, `${sessionId}.mp4`);

      // Ensure the directory exists.
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });

      // Build the simctl args.
      const args = ["simctl", "io", udid, "recordVideo", `--codec=${codec}`];
      if (mask) args.push(`--mask=${mask}`);
      args.push(outputPath);

      async function tryStart(): Promise<{ earlyError: string | null; child: typeof import("node:child_process")["ChildProcess"] extends infer _ ? ReturnType<typeof spawn> : never }> {
        const child = spawn("xcrun", args, {
          stdio: [/* stdin */ "ignore", "pipe", "pipe"],
        });

        // If the process fails to spawn or exits immediately, surface the error.
        // We give it a longer window (1500ms) to catch exit 16 which can take
        // ~1s to surface — the old 500ms window let it slip through as "success".
        const earlyError = await new Promise<string | null>((resolve) => {
          let stderrBuffer = "";
          child.stderr?.setEncoding("utf8");
          child.stderr?.on("data", (chunk: string) => {
            stderrBuffer += chunk;
          });
          child.on("error", (err) => resolve(err.message));
          child.on("exit", (code) => {
            if (code !== 0 && code !== null) {
              const hint = code === EXIT_HOST_RECORDING_ACTIVE
                ? "host recording already in progress — a previous recording may be stuck"
                : `simctl io recordVideo exited with code ${code}`;
              resolve(`${hint}${stderrBuffer ? `: ${stderrBuffer.trim()}` : ""}`);
            } else {
              resolve(null);
            }
          });
          // Wait longer than before (1500ms vs 500ms) so exit 16 is caught here
          // rather than silently becoming a "success" that fails later.
          setTimeout(() => resolve(null), 1500);
        });

        return { earlyError, child };
      }

      let { earlyError, child } = await tryStart();

      // If we hit exit 16 (stuck host recording), attempt recovery and retry once.
      if (earlyError && earlyError.includes("host recording already in progress")) {
        // Kill the orphaned process, wait briefly, then retry.
        deleteSession(udid);
        tryClearStuckRecording(udid);
        await new Promise((r) => setTimeout(r, 1000));
        const retry = await tryStart();
        earlyError = retry.earlyError;
        child = retry.child;
      }

      if (earlyError) {
        throw new Error(`Failed to start video recording: ${earlyError}`);
      }

      setSession(udid, {
        process: child,
        outputPath,
        udid,
        startedAt: Date.now(),
        codec,
      });

      return {
        sessionId: udid,
        message: `Recording started on device ${udid} (${codec}). Call stop-video-recording with udid ${udid} to finalize.`,
        outputPath,
      };
    },
  };
}
