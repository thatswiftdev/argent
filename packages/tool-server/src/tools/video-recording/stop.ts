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

/**
 * Scan a file for the `moov` atom marker. simctl writes it only on graceful
 * SIGINT exit — without it the MP4 is unplayable (has ftyp + mdat but no index).
 * Returns true when found.
 */
async function hasMoovAtom(filePath: string): Promise<boolean> {
  const { open } = await import("node:fs/promises");
  try {
    const fh = await open(filePath, "r");
    try {
      // The moov atom can be at the end of the file (simctl writes it last).
      // Read the last 64KB — enough for typical moov without scanning the whole file.
      const { stat } = await import("node:fs/promises");
      const st = await stat(filePath);
      if (st.size < 8) return false;

      const tailSize = Math.min(65536, st.size);
      const buf = Buffer.alloc(tailSize);
      await fh.read(buf, 0, tailSize, st.size - tailSize);
      return buf.includes(Buffer.from("moov"));
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/**
 * Wait for the recording process to exit, then poll for the moov atom to
 * confirm the file is playable. simctl writes the moov atom as its last act
 * before exiting on SIGINT — size stability alone doesn't guarantee it landed.
 */
async function waitForExitAndFinalize(
  process: ChildProcess,
  outputPath: string,
  timeoutMs = 15_000
): Promise<{ sizeBytes: number }> {
  const { stat } = await import("node:fs/promises");

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Recording process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);

    process.on("exit", async () => {
      clearTimeout(timer);

      // Poll for the moov atom — the file isn't playable without it. simctl
      // writes it as its final step, so we check the tail of the file. Up to
      // 50 attempts × 100ms = 5s of polling after process exit.
      for (let i = 0; i < 50; i++) {
        if (await hasMoovAtom(outputPath)) {
          const finalStat = await stat(outputPath).catch(() => ({ size: 0 }));
          resolve({ sizeBytes: finalStat.size });
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      // moov not found — the file exists but is corrupt.
      const st = await stat(outputPath).catch(() => ({ size: 0 }));
      reject(new Error(
        `Recording did not finalize correctly — the MP4 is missing the moov atom ` +
        `(file is ${st.size > 0 ? `${(st.size / 1024 / 1024).toFixed(1)} MB` : "empty"} but unplayable). ` +
        `This usually means simctl was killed before it could write the index. ` +
        `Retry after ensuring no duplicate tool-servers are running: ` +
        `\`argent server stop && argent server start\`, or reboot the simulator: ` +
        `\`xcrun simctl shutdown <UDID> && xcrun simctl boot <UDID>\`.`
      ));
    });

    // Send SIGINT to stop the recording gracefully. simctl io recordVideo
    // writes the MP4 moov atom (index/metadata) ONLY on SIGINT — SIGTERM and
    // SIGKILL leave the file unplayable ("could not be opened") because the
    // moov atom is missing.
    process.kill("SIGINT");
  });
}

export function createStopVideoRecordingTool(
  _registry: Registry
): ToolDefinition<Params, Result> {
  return {
    id: "stop-video-recording",
    description: `Stop an active video recording and return the MP4 file as a downloadable artifact.
Pass the same \`udid\` used to start the recording. The recording process is terminated, the file is finalized, and the MP4 is registered as an artifact.
Fails if no recording is active on the device, if the file cannot be finalized within 15 seconds, or if the finalized file is missing the moov atom (unplayable).`,
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

      // Kill the process and wait for the file to finalize (moov atom verified).
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
