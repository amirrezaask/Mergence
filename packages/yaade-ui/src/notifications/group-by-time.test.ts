import { describe, it } from "vite-plus/test"
import assert from "node:assert/strict"
import {
  formatRelativeTime,
  formatSidebarActivityTime,
  groupNotificationsByTime,
  notificationTimeGroup,
} from "./group-by-time.js"
import type { AppNotification } from "@yaade/shared"

function fake(partial: Partial<AppNotification> & { createdAt: string }): AppNotification {
  return {
    id: partial.id ?? "1",
    projectId: null,
    sessionId: null,
    projectName: null,
    sessionTitle: null,
    provider: null,
    type: "system",
    severity: "info",
    status: "unread",
    title: "t",
    message: null,
    source: "system",
    eventId: null,
    eventSequence: null,
    providerSessionId: null,
    providerEvent: null,
    providerTurnId: null,
    requiresAction: false,
    actionResolvedAt: null,
    readAt: null,
    dismissedAt: null,
    updatedAt: partial.createdAt,
    metadata: {},
    ...partial,
  }
}

describe("notificationTimeGroup", () => {
  const now = new Date("2026-07-28T15:00:00.000Z")

  it("groups relative buckets", () => {
    assert.equal(
      notificationTimeGroup("2026-07-28T14:50:00.000Z", now),
      "now",
    )
    assert.equal(
      notificationTimeGroup("2026-07-28T10:00:00.000Z", now),
      "earlier-today",
    )
    assert.equal(
      notificationTimeGroup("2026-07-27T12:00:00.000Z", now),
      "yesterday",
    )
    assert.equal(
      notificationTimeGroup("2026-07-24T12:00:00.000Z", now),
      "this-week",
    )
    assert.equal(
      notificationTimeGroup("2026-06-01T12:00:00.000Z", now),
      "older",
    )
  })

  it("orders groups chronologically", () => {
    const groups = groupNotificationsByTime(
      [
        fake({ id: "a", createdAt: "2026-06-01T12:00:00.000Z" }),
        fake({ id: "b", createdAt: "2026-07-28T14:55:00.000Z" }),
      ],
      now,
    )
    assert.deepEqual(
      groups.map(g => g.id),
      ["now", "older"],
    )
  })

  it("formats relative timestamps", () => {
    assert.equal(formatRelativeTime("2026-07-28T14:59:30.000Z", now), "just now")
    assert.equal(formatRelativeTime("2026-07-28T14:30:00.000Z", now), "30m")
  })

  it("formats sidebar activity timestamps", () => {
    assert.equal(
      formatSidebarActivityTime("2026-07-28T14:59:30.000Z", now),
      "just now",
    )
    assert.equal(
      formatSidebarActivityTime("2026-07-28T14:57:00.000Z", now),
      "3 minutes ago",
    )
    assert.equal(
      formatSidebarActivityTime("2026-07-28T10:59:00.000Z", now),
      "4 hours ago",
    )
  })
})
