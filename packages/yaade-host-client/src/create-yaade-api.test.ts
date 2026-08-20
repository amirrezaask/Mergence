import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { decodeHostRouteArgs } from "@yaade/rpc"
import { createYaadeApi } from "./create-yaade-api.js"
import type { YaadeHostTransport } from "./transport.js"

test("encodes a missing history cursor as null when requesting a sized page", async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const transport: YaadeHostTransport = {
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args })
      decodeHostRouteArgs(channel, args)
      throw new Error("stop after validating args")
    },
    on: () => () => undefined,
  }

  await assert.rejects(
    () => createYaadeApi(transport).git.historyPage("file:///repo", undefined, 1),
    /stop after validating args/,
  )

  assert.deepEqual(calls, [
    {
      channel: "git:historyPage",
      args: ["file:///repo", null, 1],
    },
  ])
})

test("omits an absent agent project filter from the RPC tuple", async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const transport: YaadeHostTransport = {
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args })
      decodeHostRouteArgs(channel, args)
      throw new Error("stop after validating args")
    },
    on: () => () => undefined,
  }

  await assert.rejects(
    () => createYaadeApi(transport).agents.listLive(),
    /stop after validating args/,
  )

  assert.deepEqual(calls, [{ channel: "agents:listLive", args: [] }])
})

test("omits an absent commit body from the RPC tuple", async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const transport: YaadeHostTransport = {
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args })
      decodeHostRouteArgs(channel, args)
      throw new Error("stop after validating args")
    },
    on: () => () => undefined,
  }

  await assert.rejects(
    () => createYaadeApi(transport).git.commit("file:///repo", "commit changes"),
    /stop after validating args/,
  )

  assert.deepEqual(calls, [
    {
      channel: "git:commit",
      args: ["file:///repo", "commit changes"],
    },
  ])
})
