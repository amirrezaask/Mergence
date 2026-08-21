import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { test } from "vite-plus/test"
import { DatabaseOwner } from "./database.js"
import { DeviceAuthService } from "./device-auth.js"

test("device pairing consumes a code and revocation invalidates sessions", () => {
  const owner = new DatabaseOwner(":memory:")
  try {
    const auth = new DeviceAuthService(owner.session)
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const pairing = auth.createPairingCode()
    const device = auth.pair({
      code: pairing.code,
      name: "Laptop",
      publicKey: publicKey.export({ format: "jwk" }),
      algorithm: "Ed25519",
    })
    assert.equal(device.name, "Laptop")
    assert.throws(() => auth.pair({
      code: pairing.code,
      name: "Replay",
      publicKey: publicKey.export({ format: "jwk" }),
      algorithm: "Ed25519",
    }))
    const challenge = auth.challenge(device.id)
    const session = auth.authenticate({
      deviceId: device.id,
      nonce: challenge.nonce,
      signature: sign(null, Buffer.from(challenge.nonce), privateKey).toString("base64url"),
    })
    assert.equal(auth.session(session.token)?.deviceId, device.id)
    auth.revoke(device.id)
    assert.equal(auth.session(session.token), null)
  } finally {
    owner.close()
  }
})

test("device credential rotation keeps metadata and invalidates the old token", () => {
  const owner = new DatabaseOwner(":memory:")
  try {
    const auth = new DeviceAuthService(owner.session)
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const pairing = auth.createPairingCode()
    const device = auth.pair({
      code: pairing.code,
      name: "Laptop",
      publicKey: publicKey.export({ format: "jwk" }),
      algorithm: "Ed25519",
    })
    const challenge = auth.challenge(device.id)
    const session = auth.authenticate({
      deviceId: device.id,
      nonce: challenge.nonce,
      signature: sign(null, Buffer.from(challenge.nonce), privateKey).toString("base64url"),
    })
    const rotated = auth.rotate(session.token)
    assert.equal(rotated.device.id, device.id)
    assert.equal(rotated.device.name, "Laptop")
    assert.notEqual(rotated.token, session.token)
    assert.equal(auth.session(session.token), null)
    assert.equal(auth.session(rotated.token)?.deviceId, device.id)
  } finally {
    owner.close()
  }
})

test("repeated failed authentications are rate limited", () => {
  const owner = new DatabaseOwner(":memory:")
  try {
    const auth = new DeviceAuthService(owner.session)
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const pairing = auth.createPairingCode()
    const device = auth.pair({
      code: pairing.code,
      name: "Laptop",
      publicKey: publicKey.export({ format: "jwk" }),
      algorithm: "Ed25519",
    })
    for (let i = 0; i < 8; i += 1) {
      const challenge = auth.challenge(device.id)
      assert.throws(() =>
        auth.authenticate({
          deviceId: device.id,
          nonce: challenge.nonce,
          signature: "not-a-signature",
        }),
      )
    }
    const challenge = auth.challenge(device.id)
    assert.throws(
      () =>
        auth.authenticate({
          deviceId: device.id,
          nonce: challenge.nonce,
          signature: sign(null, Buffer.from(challenge.nonce), privateKey).toString("base64url"),
        }),
      /too many authentication attempts/,
    )
  } finally {
    owner.close()
  }
})
