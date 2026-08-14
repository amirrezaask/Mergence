// @yaade-telemetry-plugin v1
// Yaade ADE telemetry plugin — fire-and-forget, never block OpenCode.
export const YaadeTelemetry = async () => {
  return {
    event: async ({ event }) => {
      const url = process.env.YAADE_INGEST_URL
      if (!url) return
      const body = JSON.stringify({ event })
      // Do not await — OpenCode must not stall on Yaade availability.
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(2000),
      }).catch(() => {})
    },
  }
}
