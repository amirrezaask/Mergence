import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "vite-plus/test"
import { loadConfig } from "./config.js"
import { startHostServer } from "./server.js"

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected JSON object")
  }
  return value as JsonRecord
}

async function postJson(url: string, body: unknown, token?: string): Promise<JsonRecord> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

test("paired observe scope cannot mutate RPC or device administration", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-security-scopes-"))
  const dataDir = path.join(root, "data")
  const config = await loadConfig([
    root,
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--data-dir",
    dataDir,
    "--allowed-roots",
    root,
    "--token",
    "host-admin",
  ])
  const started = await startHostServer(config)
  const origin = `http://127.0.0.1:${started.port}`
  try {
    const pairingResponse = await postJson(
      `${origin}/api/v1/security/pairing-code`,
      {},
      "host-admin",
    )
    assert.equal(pairingResponse.status, 201)
    const pairing = record(pairingResponse.body)
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const paired = await postJson(`${origin}/api/v1/security/pair`, {
      code: pairing.code,
      name: "observe-device",
      publicKey: publicKey.export({ format: "jwk" }),
      algorithm: "Ed25519",
      scopes: ["observe"],
    })
    assert.equal(paired.status, 201)
    const device = record(paired.body)
    const challenge = await postJson(`${origin}/api/v1/security/challenge`, {
      deviceId: device.id,
    })
    assert.equal(challenge.status, 200)
    const challengeBody = record(challenge.body)
    const session = await postJson(`${origin}/api/v1/security/session`, {
      deviceId: device.id,
      nonce: challengeBody.nonce,
      signature: sign(null, Buffer.from(String(challengeBody.nonce)), privateKey).toString("base64url"),
    })
    assert.equal(session.status, 200)
    const sessionBody = record(session.body)
    const token = String(sessionBody.token)

    const observe = await postJson(
      `${origin}/api/v1/rpc`,
      { channel: "mux:listSessions", args: [false], clientId: "browser" },
      token,
    )
    assert.equal(observe.status, 200)

    const mutate = await postJson(
      `${origin}/api/v1/rpc`,
      { channel: "mux:createSession", args: ["forbidden"], clientId: "browser" },
      token,
    )
    assert.equal(mutate.status, 403)

    const devices = await fetch(`${origin}/api/v1/security/devices`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(devices.status, 403)
  } finally {
    await started.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
