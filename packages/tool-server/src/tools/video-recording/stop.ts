import { type ChildProcess } from "node:child_process";
import { z } from "zod";
import type { Registry, ToolCapability, ToolContext, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { assertSupported } from "../../utils/capability";
import { requireArtifacts, type ArtifactHandle } from "../../artifacts";
import { getSession, deleteSession } from "./session";

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Target device id — must match the udid passed to `start-video-recording`."
    ),
  label: z
    .string()
    .optional()
    .describe(
      "Optional filename label for the output video (e.g. 'CUST-4324-verify'). " +
        "If omitted, uses the session's default filename."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  video: ArtifactHandle;
  durationMs: number;
  sizeBytes: number;
  message: string;
}

const capability: ToolCapability = {
  apple: { simulator: true },
  appleRemote: { simulator: true },
};

/** Wait for the recording process to exit and the file to finalize (moov atom). */
async function waitForExitAndFinalize(
  process: ChildProcess,
  outputPath: string,
  timeoutMs = 10_000
): Promise<{ sizeBytes: number }> {
  const { stat } = await import("node:fs/promises");

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Recording process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);

    process.on("exit", async () => {
      clearTimeout(timer);

      // Poll the file size until it stabilizes (simctl writes the moov atom on exit).
      let lastSize = -1;
      let stable = 0;
      for (let i = 0; i < 20; i++) {
        try {
          const st = await stat(outputPath);
          if (st.size === lastSize) {
            stable++;
            if (stable >= 2) break;
          } else {
            stable = 0;
          }
          lastSize = st.size;
        } catch {
          // File might not be written yet.
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      const finalStat = await stat(outputPath).catch(() => ({ size: 0 }));
      resolve({ sizeBytes: finalStat.size });
    });

    // Send SIGTERM to stop the recording gracefully.
    process.kill("SIGTERM");
  });
}

export function createStopVideoRecordingTool(
  _registry: Registry
): ToolDefinition<Params, Result> {
  return {
    id: "stop-video-recording",
    description: `Stop an active video recording and return the MP4 file as a downloadable artifact.
Pass the same \`udid\` used to start the recording. The recording process is terminated, the file is finalized, and the MP4 is registered as an artifact.
Fails if no recording is active on the device, or if the file cannot be finalized within 10 seconds.`,
    searchHint: "video record stop finalize mp4 artifact",
    zodSchema,
    outputHint: "text",
    capability,
    services: () => ({}),
    async execute(_services, params, ctx: ToolContext | undefined) {
      const device = resolveDevice(params.udid);
      assertSupported("stop-video-recording", capability, device);

      const udid = params.udid;
      const session = getSession(udid);
      if (!session) {
        throw new Error(
          `No active video recording on device ${udid}. Call \`start-video-recording\` first.`
        );
      }

      // Kill the process and wait for the file to finalize.
      const { sizeBytes } = await waitForExitAndFinalize(
        session.process,
        session.outputPath
      );

      // Remove from the session store.
      deleteSession(udid);

      // Register the MP4 as an artifact.
      const artifacts = requireArtifacts(ctx);
      const filename = params.label
        ? `${params.label}.mp4`
        : undefined;
      const video = await artifacts.register(session.outputPath, {
        mimeType: "video/mp4",
        filename,
      });

      const durationMs = Date.now() - session.startedAt;

      return {
        video,
        durationMs,
        sizeBytes,
        message: `Recording saved: ${filename ?? session.outputPath} (${(durationMs / 1000).toFixed(1)}s, ${(sizeBytes / 1024 / 1024).toFixed(1)} MB)`,
      };
    },
  };
}
