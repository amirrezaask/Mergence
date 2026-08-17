import {
  createContext,
  useContext,
  type PropsWithChildren,
} from "react"
import { NotificationCenter } from "@yaade/ui/notifications"
import {
  useNotificationCenter,
  type NotificationCenterState,
} from "../hooks/useNotificationCenter.js"

const SystemSignalsContext = createContext<NotificationCenterState | null>(null)

export function SystemSignalsProvider({ children }: PropsWithChildren) {
  const notifications = useNotificationCenter()

  return (
    <SystemSignalsContext.Provider value={notifications}>
      {children}
      <NotificationCenter
        open={notifications.open}
        onOpenChange={notifications.setOpen}
        items={notifications.items}
        query={notifications.query}
        onQueryChange={notifications.setQuery}
        loading={notifications.loading}
        error={notifications.error}
        onMarkAllRead={() => void notifications.markAllVisibleRead()}
        onRefresh={() => void notifications.refresh()}
        onOpenNotification={notification => {
          if (notification.sessionId) {
            window.dispatchEvent(
              new CustomEvent("yaade:open-agent", {
                detail: { sessionId: notification.sessionId },
              }),
            )
          }
          notifications.setOpen(false)
        }}
        onMarkRead={id => void notifications.markRead(id)}
        onMarkUnread={id => void notifications.markUnread(id)}
        onDismiss={id => void notifications.dismiss(id)}
        onAcknowledge={id => void notifications.acknowledge(id)}
        selectedId={notifications.selectedId}
        onSelectedIdChange={notifications.setSelectedId}
      />
      <div id="yaade-notification-live" className="sr-only" aria-live="assertive" />
    </SystemSignalsContext.Provider>
  )
}

export function useSystemSignals(): NotificationCenterState {
  const value = useContext(SystemSignalsContext)
  if (!value) {
    throw new Error("useSystemSignals must be used inside SystemSignalsProvider")
  }
  return value
}
