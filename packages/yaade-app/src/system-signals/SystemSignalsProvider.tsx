import {
  createContext,
  lazy,
  Suspense,
  use,
  useCallback,
  type PropsWithChildren,
} from "react"
import type { AppNotification } from "@yaade/shared"
import {
  useNotificationCenter,
  type NotificationCenterState,
} from "../hooks/useNotificationCenter.js"

const NotificationCenter = lazy(() =>
  import("@yaade/ui/notifications").then(({ NotificationCenter: View }) => ({
    default: View,
  })),
)
const SystemSignalsContext = createContext<NotificationCenterState | null>(null)

export function SystemSignalsProvider({ children }: PropsWithChildren) {
  const notifications = useNotificationCenter()
  const { setOpen } = notifications
  const onOpenNotification = useCallback(
    (notification: AppNotification) => {
      if (notification.sessionId) {
        window.dispatchEvent(
          new CustomEvent("yaade:open-agent", {
            detail: { sessionId: notification.sessionId },
          }),
        )
      }
      setOpen(false)
    },
    [setOpen],
  )

  return (
    <SystemSignalsContext.Provider value={notifications}>
      {children}
      {notifications.open ? (
        <Suspense fallback={null}>
          <NotificationCenter
            open
            onOpenChange={notifications.setOpen}
            items={notifications.items}
            query={notifications.query}
            onQueryChange={notifications.setQuery}
            loading={notifications.loading}
            error={notifications.error}
            onMarkAllRead={notifications.markAllVisibleRead}
            onRefresh={notifications.refresh}
            onOpenNotification={onOpenNotification}
            onMarkRead={notifications.markRead}
            onMarkUnread={notifications.markUnread}
            onDismiss={notifications.dismiss}
            onAcknowledge={notifications.acknowledge}
            selectedId={notifications.selectedId}
            onSelectedIdChange={notifications.setSelectedId}
          />
        </Suspense>
      ) : null}
      <div id="yaade-notification-live" className="sr-only" aria-live="assertive" />
    </SystemSignalsContext.Provider>
  )
}

export function useSystemSignals(): NotificationCenterState {
  const value = use(SystemSignalsContext)
  if (!value) {
    throw new Error("useSystemSignals must be used inside SystemSignalsProvider")
  }
  return value
}
