/**
 * Recording session store — module-level Map tracking active video recordings.
 *
 * Only one recording per device at a time. Starting a new recording while one
 * is active on the same device returns an error pointing to the existing session.
 *
 * The store is cleaned up on process exit to avoid orphaned simctl processes.
 */

import { type ChildProcess } from "node:child_process";

export interface RecordingSession {
  /** The spawned `simctl io recordVideo` child process. */
  process: ChildProcess;
  /** Absolute path to the output .mp4 on the tool-server host. */
  outputPath: string;
  /** Device UDID this recording belongs to. */
  udid: string;
  /** Epoch ms when recording started. */
  startedAt: number;
  /** Codec used: h264 or hevc. */
  codec: "h264" | "hevc";
}

const sessions = new Map<string, RecordingSession>();

/** Keyed by `udid` — one active recording per device. */
export function getSession(udid: string): RecordingSession | undefined {
  return sessions.get(udid);
}

export function setSession(udid: string, session: RecordingSession): void {
  sessions.set(udid, session);
}

export function deleteSession(udid: string): RecordingSession | undefined {
  const session = sessions.get(udid);
  if (session) sessions.delete(udid);
  return session;
}

/**
 * Kill all active recordings — called on process exit to avoid orphaned processes.
 *
 * Sends SIGINT (not SIGTERM) so simctl finalizes the MP4 moov atom. Without
 * SIGINT the file is unplayable — it has video data but no index/metadata.
 * We can't wait for the process to fully exit here (process.on("exit") is
 * synchronous), so the finalize may not complete before the process dies.
 * That's acceptable for a shutdown path — the explicit `stop-video-recording`
 * tool path (which does wait) is the one that matters for usable artifacts.
 */
export function killAllSessions(): void {
  for (const [udid, session] of sessions) {
    try {
      session.process.kill("SIGINT");
    } catch {
      // Process may have already exited — ignore.
    }
    sessions.delete(udid);
  }
}

// Clean up on process exit.
process.on("exit", killAllSessions);
