import { describe, expect, test } from "bun:test"
import type { ConfigModelSettings, Model, Provider, ProviderCompaction } from "./model"

describe("OpenCode 2.0.12 model settings", () => {
  test("keeps model overlays in settings and accepts both compaction variants", () => {
    const summary = { type: "summary" } satisfies ProviderCompaction
    const native = { type: "native" } satisfies ProviderCompaction
    const model = {
      settings: { compaction: summary },
      headers: { "x-model": "enabled" },
      body: { reasoning: "high" },
    } satisfies Pick<Model, "settings" | "headers" | "body">

    expect(model.settings?.compaction).toEqual(summary)
    expect(native.type).toBe("native")
    expect(model.headers?.["x-model"]).toBe("enabled")
    expect(model.body?.reasoning).toBe("high")
  })

  test("keeps provider request controls and config compaction in settings", () => {
    const provider = {
      settings: {
        timeout: false,
        chunkTimeout: 15_000,
        compaction: { type: "native" },
        transport: "websocket",
        apiKey: "configured-key",
      },
      headers: { authorization: "Bearer configured-key" },
      body: { stream: true },
    } satisfies Pick<Provider, "settings" | "headers" | "body">
    const config = { compaction: { type: "summary" } } satisfies ConfigModelSettings

    expect(provider.settings?.timeout).toBe(false)
    expect(provider.settings?.chunkTimeout).toBe(15_000)
    expect(provider.settings?.transport).toBe("websocket")
    expect(provider.settings?.compaction).toEqual({ type: "native" })
    expect(config.compaction).toEqual({ type: "summary" })
  })
})
