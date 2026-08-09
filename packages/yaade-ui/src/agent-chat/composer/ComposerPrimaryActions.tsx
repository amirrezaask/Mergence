import { memo, type PointerEventHandler } from "react"
import { cn } from "./lib/cn.js"
import { Spinner } from "./ui/spinner.js"

interface ComposerPrimaryActionsProps {
  compact: boolean
  isRunning: boolean
  promptHasText: boolean
  isSendBusy: boolean
  sendDisabledReason: string | null
  isConnecting: boolean
  hasSendableContent: boolean
  preserveComposerFocusOnPointerDown?: boolean
  onInterrupt: () => void
}

const preventPointerFocus: PointerEventHandler<HTMLElement> = event => {
  event.preventDefault()
}

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  isRunning,
  promptHasText: _promptHasText,
  isSendBusy,
  sendDisabledReason,
  isConnecting,
  hasSendableContent,
  preserveComposerFocusOnPointerDown = false,
  onInterrupt,
}: ComposerPrimaryActionsProps) {
  void compact
  void _promptHasText
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined
  const isSendDisabled = sendDisabledReason !== null

  if (isRunning) {
    return (
      <button
        type="button"
        className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-[0_1px_--theme(--color-white/16%)] transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none sm:h-8 sm:w-8"
        {...pointerFocusProps}
        onClick={onInterrupt}
        aria-label="Stop generation"
        data-chat-composer-stop=""
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </button>
    )
  }

  return (
    <button
      type="submit"
      className={cn(
        "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full text-primary-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8",
        "bg-primary/90 enabled:shadow-primary/24 hover:bg-primary",
      )}
      {...pointerFocusProps}
      disabled={isSendBusy || isSendDisabled || isConnecting || !hasSendableContent}
      aria-label={
        sendDisabledReason
          ? sendDisabledReason
          : isConnecting
            ? "Connecting"
            : isSendBusy
              ? "Sending"
              : "Send message"
      }
      data-chat-composer-send=""
    >
      {isConnecting || isSendBusy ? (
        <Spinner className="size-3.5" aria-hidden="true" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  )
})
