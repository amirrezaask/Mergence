import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto"
import type { DatabaseSession } from "./database.js"

export type DeviceScope = "observe" | "control" | "admin"

export type PairedDevice = {
  id: string
  name: string
  algorithm: string
  scopes: DeviceScope[]
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

type DeviceRow = {
  id: string
  name: string
  public_key: string
  algorithm: string
  scopes_json: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

type PendingChallenge = {
  deviceId: string
  nonce: string
  expiresAt: number
}

type Session = {
  deviceId: string
  scopes: DeviceScope[]
  expiresAt: number
}

const PAIRING_TTL_MS = 5 * 60 * 1000
const CHALLENGE_TTL_MS = 60 * 1000
const SESSION_TTL_MS = 15 * 60 * 1000
const AUTH_FAILURE_LIMIT = 8
const AUTH_FAILURE_WINDOW_MS = 60 * 1000
const MAX_PENDING_CHALLENGES = 1_024
const MAX_SESSIONS = 4_096
const MAX_FAILURE_KEYS = 4_096
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,96}$/
const MAX_PUBLIC_KEY_BYTES = 4 * 1024
const MAX_SIGNATURE_CHARS = 2 * 1024

function nowIso(): string {
  return new Date().toISOString()
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function code(): string {
  return randomBytes(5).toString("hex").toUpperCase()
}

function evictOldest<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest === undefined) return
    map.delete(oldest)
  }
}

function parseScopes(value: string): DeviceScope[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return ["control"]
    const scopes = parsed.filter(
      (item): item is DeviceScope =>
        item === "observe" || item === "control" || item === "admin",
    )
    return scopes.length > 0 ? scopes : ["control"]
  } catch {
    return ["control"]
  }
}

function toDevice(row: DeviceRow): PairedDevice {
  return {
    id: row.id,
    name: row.name,
    algorithm: row.algorithm,
    scopes: parseScopes(row.scopes_json),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }
}

function isPublicKey(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.kty === "string" && typeof record.crv === "string"
}

/** Device pairing and short-lived challenge sessions. Secrets stay in memory. */
export class DeviceAuthService {
  private readonly challenges = new Map<string, PendingChallenge>()
  private readonly sessions = new Map<string, Session>()
  private readonly failures = new Map<string, number[]>()

  constructor(private readonly db: DatabaseSession) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS devices(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS pairing_codes(
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_events(
        id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        device_id TEXT,
        action TEXT NOT NULL,
        resource_type TEXT,
        resource_id TEXT,
        details_json TEXT NOT NULL
      );
    `)
  }

  createPairingCode(): { code: string; expiresAt: string } {
    const value = code()
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString()
    this.db
      .prepare("INSERT INTO pairing_codes(id,code_hash,expires_at) VALUES(?,?,?)")
      .run(randomUUID(), hash(value), expiresAt)
    return { code: value, expiresAt }
  }

  pair(input: {
    code: string
    deviceId?: string
    name: string
    publicKey: unknown
    algorithm: string
    scopes?: readonly DeviceScope[]
  }): PairedDevice {
    this.assertNotRateLimited("pair")
    const pairingCode = input.code.trim().toUpperCase()
    if (!/^[A-F0-9]{10}$/.test(pairingCode)) {
      this.recordFailure("pair")
      throw new Error("invalid pairing code")
    }
    if (
      !isPublicKey(input.publicKey) ||
      Buffer.byteLength(JSON.stringify(input.publicKey), "utf8") >
        MAX_PUBLIC_KEY_BYTES
    ) throw new Error("invalid device public key")
    const row = this.db
      .prepare(
        "SELECT id,code_hash,expires_at,used_at FROM pairing_codes WHERE code_hash=? AND used_at IS NULL ORDER BY expires_at DESC LIMIT 1",
      )
      .get(hash(pairingCode)) as
      | { id: string; code_hash: string; expires_at: string; used_at: string | null }
      | undefined
    if (!row || Date.parse(row.expires_at) <= Date.now()) {
      this.recordFailure("pair")
      throw new Error("pairing code expired")
    }
    const scopes: DeviceScope[] = [...new Set(input.scopes ?? ["control" as const])]
    if (scopes.some(scope => scope !== "observe" && scope !== "control" && scope !== "admin")) {
      throw new Error("invalid device scope")
    }
    if (scopes.includes("admin")) throw new Error("admin pairing requires a local administrator")
    const consumed = this.db
      .prepare(
        "UPDATE pairing_codes SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>?",
      )
      .run(nowIso(), row.id, nowIso())
    if (Number(consumed.changes) !== 1) {
      this.recordFailure("pair")
      throw new Error("pairing code already used")
    }
    const device: PairedDevice = {
      id: input.deviceId && DEVICE_ID_PATTERN.test(input.deviceId)
        ? input.deviceId
        : `dev-${randomUUID()}`,
      name: input.name.trim().slice(0, 120) || "YAADE device",
      algorithm: input.algorithm.trim().slice(0, 64) || "Ed25519",
      scopes: scopes.length > 0 ? scopes : ["control"],
      createdAt: nowIso(),
      lastUsedAt: null,
      revokedAt: null,
    }
    this.db
      .prepare(
        "INSERT INTO devices(id,name,public_key,algorithm,scopes_json,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        device.id,
        device.name,
        JSON.stringify(input.publicKey),
        device.algorithm,
        JSON.stringify(device.scopes),
        device.createdAt,
      )
    this.audit("device.paired", device.id, "device", device.id, { name: device.name })
    return device
  }

  list(): PairedDevice[] {
    const rows = this.db
      .prepare("SELECT * FROM devices ORDER BY created_at DESC")
      .all() as DeviceRow[]
    return rows.map(toDevice)
  }

  revoke(deviceId: string): boolean {
    const result = this.db
      .prepare("UPDATE devices SET revoked_at=COALESCE(revoked_at, ?) WHERE id=?")
      .run(nowIso(), deviceId)
    for (const [token, session] of this.sessions) {
      if (session.deviceId === deviceId) this.sessions.delete(token)
    }
    if (Number(result.changes) > 0) this.audit("device.revoked", deviceId, "device", deviceId, {})
    return Number(result.changes) > 0
  }

  challenge(deviceId: string): { nonce: string; expiresAt: string } {
    this.cleanupEphemeral()
    if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error("invalid device id")
    const device = this.device(deviceId)
    if (!device || device.revokedAt) throw new Error("device is revoked or unknown")
    const nonce = randomBytes(32).toString("base64url")
    const expiresAt = Date.now() + CHALLENGE_TTL_MS
    this.challenges.set(nonce, { deviceId, nonce, expiresAt })
    evictOldest(this.challenges, MAX_PENDING_CHALLENGES)
    return { nonce, expiresAt: new Date(expiresAt).toISOString() }
  }

  authenticate(input: {
    deviceId: string
    nonce: string
    signature: string
  }): { token: string; expiresAt: string; device: PairedDevice } {
    this.cleanupEphemeral()
    if (
      !DEVICE_ID_PATTERN.test(input.deviceId) ||
      input.nonce.length > 128 ||
      input.signature.length > MAX_SIGNATURE_CHARS
    ) {
      this.recordFailure("invalid-device")
      throw new Error("invalid authentication payload")
    }
    this.assertNotRateLimited(input.deviceId)
    const challenge = this.challenges.get(input.nonce)
    this.challenges.delete(input.nonce)
    const device = this.row(input.deviceId)
    if (!challenge || challenge.deviceId !== input.deviceId || challenge.expiresAt <= Date.now()) {
      this.recordFailure(input.deviceId)
      throw new Error("challenge expired")
    }
    if (!device || device.revoked_at) {
      this.recordFailure(input.deviceId)
      throw new Error("device is revoked or unknown")
    }
    let valid = false
    try {
      const publicKey = createPublicKey({
        key: JSON.parse(device.public_key),
        format: "jwk",
      })
      valid = verify(
        null,
        Buffer.from(input.nonce),
        publicKey,
        Buffer.from(input.signature, "base64url"),
      )
    } catch {
      valid = false
    }
    if (!valid) {
      this.recordFailure(input.deviceId)
      throw new Error("invalid device signature")
    }
    this.failures.delete(input.deviceId)
    const token = randomBytes(32).toString("base64url")
    const expiresAt = Date.now() + SESSION_TTL_MS
    this.sessions.set(token, {
      deviceId: input.deviceId,
      scopes: parseScopes(device.scopes_json),
      expiresAt,
    })
    evictOldest(this.sessions, MAX_SESSIONS)
    this.db
      .prepare("UPDATE devices SET last_used_at=? WHERE id=?")
      .run(nowIso(), input.deviceId)
    return {
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      device: toDevice(device),
    }
  }

  rotate(token: string): { token: string; expiresAt: string; device: PairedDevice } {
    this.cleanupEphemeral()
    const current = this.sessions.get(token)
    if (!current || current.expiresAt <= Date.now()) {
      this.sessions.delete(token)
      throw new Error("unknown session")
    }
    const device = this.row(current.deviceId)
    if (!device || device.revoked_at) {
      this.sessions.delete(token)
      throw new Error("device is revoked or unknown")
    }
    this.sessions.delete(token)
    const next = randomBytes(32).toString("base64url")
    const expiresAt = Date.now() + SESSION_TTL_MS
    this.sessions.set(next, {
      deviceId: current.deviceId,
      scopes: current.scopes,
      expiresAt,
    })
    evictOldest(this.sessions, MAX_SESSIONS)
    this.db
      .prepare("UPDATE devices SET last_used_at=? WHERE id=?")
      .run(nowIso(), current.deviceId)
    this.audit("device.rotated", current.deviceId, "device", current.deviceId, {})
    return {
      token: next,
      expiresAt: new Date(expiresAt).toISOString(),
      device: toDevice(device),
    }
  }

  ephemeralCounts(): {
    challenges: number
    sessions: number
    failureKeys: number
  } {
    this.cleanupEphemeral()
    return {
      challenges: this.challenges.size,
      sessions: this.sessions.size,
      failureKeys: this.failures.size,
    }
  }

  listAudit(): Array<{
    action: string
    deviceId: string | null
    resourceType: string | null
    resourceId: string | null
    details: Record<string, unknown>
  }> {
    const rows = this.db
      .prepare(
        "SELECT action,device_id,resource_type,resource_id,details_json FROM audit_events ORDER BY occurred_at ASC",
      )
      .all() as Array<{
      action: string
      device_id: string | null
      resource_type: string | null
      resource_id: string | null
      details_json: string
    }>
    return rows.map(row => ({
      action: row.action,
      deviceId: row.device_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      details: (() => {
        try {
          const parsed: unknown = JSON.parse(row.details_json)
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {}
        } catch {
          return {}
        }
      })(),
    }))
  }

  session(token: string): { deviceId: string; scopes: DeviceScope[] } | null {
    this.cleanupEphemeral()
    const current = this.sessions.get(token)
    if (!current || current.expiresAt <= Date.now()) {
      this.sessions.delete(token)
      return null
    }
    const device = this.row(current.deviceId)
    if (!device || device.revoked_at) {
      this.sessions.delete(token)
      return null
    }
    this.db
      .prepare("UPDATE devices SET last_used_at=? WHERE id=?")
      .run(nowIso(), current.deviceId)
    return { deviceId: current.deviceId, scopes: current.scopes }
  }

  private row(deviceId: string): DeviceRow | undefined {
    return this.db.prepare("SELECT * FROM devices WHERE id=?").get(deviceId) as DeviceRow | undefined
  }

  private device(deviceId: string): PairedDevice | null {
    const row = this.row(deviceId)
    return row ? toDevice(row) : null
  }

  private assertNotRateLimited(key: string): void {
    const now = Date.now()
    const recent = (this.failures.get(key) ?? []).filter(at => now - at < AUTH_FAILURE_WINDOW_MS)
    if (recent.length > 0) this.failures.set(key, recent)
    else this.failures.delete(key)
    if (recent.length >= AUTH_FAILURE_LIMIT) throw new Error("too many authentication attempts")
  }

  private recordFailure(key: string): void {
    const now = Date.now()
    const recent = (this.failures.get(key) ?? []).filter(at => now - at < AUTH_FAILURE_WINDOW_MS)
    recent.push(now)
    this.failures.set(key, recent)
    evictOldest(this.failures, MAX_FAILURE_KEYS)
  }

  private cleanupEphemeral(now = Date.now()): void {
    for (const [nonce, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(nonce)
    }
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token)
    }
    for (const [key, failures] of this.failures) {
      const recent = failures.filter(at => now - at < AUTH_FAILURE_WINDOW_MS)
      if (recent.length > 0) this.failures.set(key, recent)
      else this.failures.delete(key)
    }
    evictOldest(this.challenges, MAX_PENDING_CHALLENGES)
    evictOldest(this.sessions, MAX_SESSIONS)
    evictOldest(this.failures, MAX_FAILURE_KEYS)
  }

  private audit(
    action: string,
    deviceId: string | null,
    resourceType: string | null,
    resourceId: string | null,
    details: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        "INSERT INTO audit_events(id,occurred_at,device_id,action,resource_type,resource_id,details_json) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        nowIso(),
        deviceId,
        action,
        resourceType,
        resourceId,
        JSON.stringify(details),
      )
  }
}
