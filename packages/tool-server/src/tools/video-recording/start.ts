import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { assertSupported } from "../../utils/capability";
import { ensureDeps } from "../../utils/check-deps";
import { getSession, setSession } from "./session";

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

export function createStartVideoRecordingTool(
  _registry: Registry
): ToolDefinition<Params, Result> {
  return {
    id: "start-video-recording",
    description: `Start recording the iOS Simulator screen as a video. Spawns \`simctl io recordVideo\` in the background and returns immediately.
Use to capture app behavior during a verification flow. Call \`stop-video-recording\` with the returned sessionId to finalize and obtain the MP4.
Only one recording per device at a time. Fails if a recording is already active on the device, or if simctl is unavailable.
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

      // Reject if a recording is already active on this device.
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

      // Spawn the recording process.
      const child = spawn("xcrun", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      // If the process fails to spawn or exits immediately, surface the error.
      const spawnError = new Promise<string | null>((resolve) => {
        child.on("error", (err) => resolve(err.message));
        child.on("exit", (code) => {
          if (code !== 0 && code !== null) {
            resolve(`simctl io recordVideo exited with code ${code}`);
          } else {
            resolve(null);
          }
        });
        // Give it a brief moment to fail before assuming success.
        setTimeout(() => resolve(null), 500);
      });

      const earlyError = await spawnError;
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
