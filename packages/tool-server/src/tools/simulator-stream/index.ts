import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { isTvOsSimulator } from "../../utils/ios-devices";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id (iOS simulator UDID). Must be booted."),
});

const capability: ToolCapability = {
  apple: { simulator: true },
};

export function createSimulatorStreamTool(registry: Registry): ToolDefinition<z.infer<typeof zodSchema>> {
  return {
    id: "simulator-stream",
    description:
      "Get the live MJPEG screen-stream URL for a booted iOS simulator. The URL serves " +
      "multipart/x-mixed-replace frames and renders directly in an <img> tag. Valid while " +
      "the simulator-server process lives; on stream error, re-resolve. Read-only: " +
      "watching holds no lease and does not disturb automation.",
    zodSchema,
    capability,
    services: () => ({}),
    async execute(_services, params) {
      const device = resolveDevice(params.udid);
      if (device.platform === "ios" && (await isTvOsSimulator(params.udid))) {
        throw new Error("simulator-stream is not available on tvOS simulators");
      }
      if (device.platform !== "ios") {
        throw new Error(`simulator-stream supports iOS simulators only (got platform "${device.platform}")`);
      }
      const ref = simulatorServerRef(device);
      const api = (await registry.resolveService(ref.urn, ref.options)) as SimulatorServerApi;
      return { streamUrl: api.streamUrl, platform: device.platform };
    },
  };
}
