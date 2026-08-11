import { useCallback, useEffect, useRef, useState } from "react"
import type {
  AppNotification,
  ListNotificationsRequest,
  NotificationCounts,
  NotificationFilter,
  NotificationPreferences,
  NotificationStreamEvent,
} from "@yaade/shared"
import {
  evaluateDesktopDeliveryClient,
  maybeShowDesktopNotification,
} from "./notification-desktop.js"

const EMPTY_COUNTS: NotificationCounts = {
  totalUnread: 0,
  actionRequired: 0,
  errors: 0,
}

function notificationsApi() {
  return window.yaade?.notifications
}

export type NotificationCenterState = {
  open: boolean
  setOpen: (open: boolean) => void
  openFiltered: (opts: {
    projectId?: string | null
    sessionId?: string | null
    filter?: NotificationFilter
  }) => void
  items: AppNotification[]
  recentItems: AppNotification[]
  counts: NotificationCounts
  unreadBySession: Record<string, number>
  filter: NotificationFilter
  setFilter: (filter: NotificationFilter) => void
  query: string
  setQuery: (query: string) => void
  projectId: string | null
  sessionId: string | null
  loading: boolean
  error: string | null
  prefs: NotificationPreferences | null
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  refresh: () => Promise<void>
  markRead: (id: string) => Promise<void>
  markUnread: (id: string) => Promise<void>
  markSessionRead: (sessionId: string) => Promise<void>
  markSessionUnread: (sessionId: string) => Promise<void>
  dismiss: (id: string) => Promise<void>
  acknowledge: (id: string) => Promise<void>
  markAllVisibleRead: () => Promise<void>
  ingestForTests: (
    req: import("@yaade/shared").IngestNotificationRequest,
  ) => Promise<unknown>
  bindSession: (
    req: import("@yaade/shared").BindNotificationSessionRequest,
  ) => Promise<void>
  viewingSessionId: string | null
  setViewingSessionId: (id: string | null) => void
}

export function useNotificationCenter(): NotificationCenterState {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<AppNotification[]>([])
  const [recentItems, setRecentItems] = useState<AppNotification[]>([])
  const [counts, setCounts] = useState<NotificationCounts>(EMPTY_COUNTS)
  const [unreadBySession, setUnreadBySession] = useState<Record<string, number>>(
    {},
  )
  const [filter, setFilter] = useState<NotificationFilter>("unread")
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [projectId, setProjectId] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [viewingSessionId, setViewingSessionId] = useState<string | null>(null)
  const recentDesktop = useRef(new Map<string, number>())
  const refreshSequence = useRef(0)

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 200)
    return () => window.clearTimeout(t)
  }, [query])

  const refresh = useCallback(async () => {
    const api = notificationsApi()
    if (!api) return
    const requestSequence = ++refreshSequence.current
    setLoading(true)
    try {
      const req: ListNotificationsRequest = {
        filter,
        query: debouncedQuery || undefined,
        projectId: projectId ?? undefined,
        sessionId: sessionId ?? undefined,
        limit: 100,
      }
      const [list, recent, preferences, bySession] = await Promise.all([
        api.list(req),
        api.list({ filter: "all", limit: 12 }),
        prefs ? Promise.resolve(prefs) : api.getPreferences(),
        api.unreadBySession?.() ?? Promise.resolve({}),
      ])
      if (requestSequence !== refreshSequence.current) return
      setItems(list.items)
      setRecentItems(recent.items)
      setCounts(list.counts)
      setUnreadBySession(bySession ?? {})
      if (!prefs) setPrefs(preferences)
      setError(null)
    } catch (err) {
      if (requestSequence !== refreshSequence.current) return
      setError("Could not refresh notifications")
      console.error("[yaade] notifications refresh failed", err)
    } finally {
      if (requestSequence === refreshSequence.current) setLoading(false)
    }
  }, [filter, debouncedQuery, projectId, sessionId, prefs])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const api = notificationsApi()
    if (!api?.onEvent) return
    return api.onEvent((event: NotificationStreamEvent) => {
      window.dispatchEvent(new CustomEvent("yaade:notification-signal"))
      if (event.type === "notification.counts-updated") {
        setCounts(event.counts)
        return
      }
      if (event.type === "notification.created") {
        const n = event.notification
        setRecentItems(prev => [n, ...prev.filter(item => item.id !== n.id)].slice(0, 12))
        setItems(prev => {
          if (prev.some(x => x.id === n.id)) {
            return prev.map(x => (x.id === n.id ? n : x))
          }
          return [n, ...prev]
        })
        // Host emits create once per id; counts-updated corrects totals.
        if (n.sessionId && n.status === "unread") {
          const sid = n.sessionId
          setUnreadBySession(prev => ({
            ...prev,
            [sid]: (prev[sid] ?? 0) + 1,
          }))
        }
        const decision = evaluateDesktopDeliveryClient({
          prefs,
          notification: n,
          viewingSessionId,
          recentDesktop: recentDesktop.current,
        })
        if (decision.deliver) {
          const now = Date.now()
          recentDesktop.current.set(n.id, now)
          if (recentDesktop.current.size > 256) {
            for (const [id, deliveredAt] of recentDesktop.current) {
              if (now - deliveredAt >= 60_000 || recentDesktop.current.size > 256) {
                recentDesktop.current.delete(id)
              }
            }
          }
          maybeShowDesktopNotification(n, {
            soundEnabled: prefs?.soundEnabled,
            onClick: () => {
              setSelectedId(n.id)
              setProjectId(null)
              setSessionId(null)
              setFilter("unread")
              setOpen(true)
            },
          })
        }
        // Announce high-priority for SR
        if (n.severity === "error" || n.requiresAction) {
          const live = document.getElementById("yaade-notification-live")
          if (live) live.textContent = `${n.title}. ${n.message ?? ""}`
        }
        return
      }
      if (
        event.type === "notification.updated" ||
        event.type === "notification.dismissed"
      ) {
        void refresh()
      }
    })
  }, [prefs, viewingSessionId, refresh])

  // Reconcile after reconnect / visibility
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    document.addEventListener("visibilitychange", onVis)
    window.addEventListener("yaade:host-reconnected", onVis)
    return () => {
      document.removeEventListener("visibilitychange", onVis)
      window.removeEventListener("yaade:host-reconnected", onVis)
    }
  }, [refresh])

  const openFiltered: NotificationCenterState["openFiltered"] = opts => {
    setProjectId(opts.projectId ?? null)
    setSessionId(opts.sessionId ?? null)
    if (opts.filter) setFilter(opts.filter)
    setOpen(true)
  }

  const markRead = async (id: string) => {
    await notificationsApi()?.markRead(id)
    await refresh()
  }
  const markUnread = async (id: string) => {
    await notificationsApi()?.markUnread(id)
    await refresh()
  }
  const markSessionRead = async (sessionId: string) => {
    await notificationsApi()?.markAllRead({ sessionId })
    await refresh()
  }
  const markSessionUnread = async (sessionId: string) => {
    await notificationsApi()?.markSessionUnread(sessionId)
    await refresh()
  }
  const dismiss = async (id: string) => {
    await notificationsApi()?.dismiss(id)
    await refresh()
  }
  const acknowledge = async (id: string) => {
    await notificationsApi()?.acknowledge(id)
    await refresh()
  }
  const markAllVisibleRead = async () => {
    await notificationsApi()?.markAllRead({
      onlyVisible: true,
      filter,
      projectId: projectId ?? undefined,
      sessionId: sessionId ?? undefined,
      query: debouncedQuery || undefined,
    })
    await refresh()
  }

  return {
    open,
    setOpen: next => {
      if (!next) {
        setProjectId(null)
        setSessionId(null)
      }
      setOpen(next)
    },
    openFiltered,
    items,
    recentItems,
    counts,
    unreadBySession,
    filter,
    setFilter,
    query,
    setQuery,
    projectId,
    sessionId,
    loading,
    error,
    prefs,
    selectedId,
    setSelectedId,
    refresh,
    markRead,
    markUnread,
    markSessionRead,
    markSessionUnread,
    dismiss,
    acknowledge,
    markAllVisibleRead,
    ingestForTests: req => notificationsApi()!.ingest(req),
    bindSession: async req => {
      await notificationsApi()?.bindSession(req)
    },
    viewingSessionId,
    setViewingSessionId,
  }
}
