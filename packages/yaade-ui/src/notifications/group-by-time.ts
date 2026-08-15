import type { AppNotification } from "@yaade/shared"

export type NotificationTimeGroup =
  | "now"
  | "earlier-today"
  | "yesterday"
  | "this-week"
  | "older"

export const NOTIFICATION_TIME_GROUP_LABELS = {
  now: "Now",
  "earlier-today": "Earlier today",
  yesterday: "Yesterday",
  "this-week": "This week",
  older: "Older",
} satisfies Record<NotificationTimeGroup, string>

const GROUP_ORDER: NotificationTimeGroup[] = [
  "now",
  "earlier-today",
  "yesterday",
  "this-week",
  "older",
]

export function notificationTimeGroup(
  createdAt: string,
  now = new Date(),
): NotificationTimeGroup {
  const created = new Date(createdAt)
  const diffMs = now.getTime() - created.getTime()
  if (diffMs < 15 * 60 * 1000) return "now"

  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  if (created >= startOfToday) return "earlier-today"

  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)
  if (created >= startOfYesterday) return "yesterday"

  const startOfWeek = new Date(startOfToday)
  startOfWeek.setDate(startOfWeek.getDate() - 6)
  if (created >= startOfWeek) return "this-week"

  return "older"
}

export type NotificationGroup = {
  id: NotificationTimeGroup
  label: string
  items: AppNotification[]
}

export function groupNotificationsByTime(
  items: AppNotification[],
  now = new Date(),
): NotificationGroup[] {
  const buckets = new Map<NotificationTimeGroup, AppNotification[]>()
  for (const id of GROUP_ORDER) buckets.set(id, [])
  for (const item of items) {
    const group = notificationTimeGroup(item.createdAt, now)
    buckets.get(group)!.push(item)
  }
  return GROUP_ORDER.filter(id => (buckets.get(id)?.length ?? 0) > 0).map(id => ({
    id,
    label: NOTIFICATION_TIME_GROUP_LABELS[id],
    items: buckets.get(id)!,
  }))
}

export function formatRelativeTime(iso: string, now = new Date()): string {
  const then = new Date(iso).getTime()
  const diffSec = Math.max(0, Math.round((now.getTime() - then) / 1000))
  if (diffSec < 60) return "just now"
  const mins = Math.round(diffSec / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}

/** Longer activity labels for sidebar session rows ("2 minutes ago", "Aug 2, 7:05 PM"). */
export function formatSidebarActivityTime(iso: string, now = new Date()): string {
  const then = new Date(iso).getTime()
  const diffSec = Math.max(0, Math.round((now.getTime() - then) / 1000))
  if (diffSec < 60) return "just now"
  const mins = Math.round(diffSec / 60)
  if (mins === 1) return "1 minute ago"
  if (mins < 60) return `${mins} minutes ago`
  const hours = Math.round(mins / 60)
  if (hours === 1) return "1 hour ago"
  if (hours < 24) return `${hours} hours ago`
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}
