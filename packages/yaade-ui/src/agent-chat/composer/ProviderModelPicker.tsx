import { memo, useEffect, useMemo, useState } from "react"
import type { VariantProps } from "class-variance-authority"
import type { ProviderDriverKind, ProviderInstanceId } from "./contracts/types.js"
import { buttonVariants } from "./ui/button.js"
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover.js"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.js"
import { cn } from "./lib/cn.js"
import { ModelPickerContent } from "./ModelPickerContent.js"
import { ProviderInstanceIcon } from "./ProviderInstanceIcon.js"
import {
  type ModelEsque,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
} from "./providerIconUtils.js"
import type { ProviderInstanceEntry } from "./providerInstances.js"
import { ComposerControl, ComposerControlChevron } from "./ComposerControl.js"

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  activeInstanceId: ProviderInstanceId
  model: string
  lockedProvider: ProviderDriverKind | null
  lockedContinuationGroupKey?: string | null
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>
  activeProviderIconClassName?: string
  compact?: boolean
  disabled?: boolean
  terminalOpen?: boolean
  open?: boolean
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"]
  triggerClassName?: string
  triggerAriaLabel?: string
  onOpenChange?: (open: boolean) => void
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void
}) {
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false)
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen

  const activeEntry = useMemo(() => {
    return (
      props.instanceEntries.find(entry => entry.instanceId === props.activeInstanceId) ?? null
    )
  }, [props.activeInstanceId, props.instanceEntries])

  const activeInstanceId = props.activeInstanceId
  const selectedInstanceOptions = props.modelOptionsByInstance.get(activeInstanceId) ?? []
  const selectedModel =
    selectedInstanceOptions.find(option => option.slug === props.model) ??
    selectedInstanceOptions[0]
  const triggerTitle = selectedModel ? getTriggerDisplayModelName(selectedModel) : props.model
  const triggerLabel = selectedModel ? getTriggerDisplayModelLabel(selectedModel) : props.model
  const duplicateDriverCount = props.instanceEntries.filter(
    entry => activeEntry !== null && entry.driverKind === activeEntry.driverKind,
  ).length
  const showInstanceBadge = Boolean(activeEntry?.accentColor) || duplicateDriverCount > 1

  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open)
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open)
    }
  }

  useEffect(() => {
    if (!isMenuOpen) return
    const { documentElement, body } = document
    const previousDocumentOverscrollBehavior = documentElement.style.overscrollBehavior
    const previousBodyOverflow = body.style.overflow
    const previousBodyPaddingRight = body.style.paddingRight
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth

    documentElement.style.overscrollBehavior = "contain"
    body.style.overflow = "hidden"
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`
    }

    const shouldAllowOverlayScroll = (target: EventTarget | null) =>
      target instanceof Element && target.closest("[data-model-picker-content]")
    const preventBackgroundWheel = (event: WheelEvent) => {
      if (shouldAllowOverlayScroll(event.target)) return
      event.preventDefault()
    }
    const preventBackgroundTouchMove = (event: TouchEvent) => {
      if (shouldAllowOverlayScroll(event.target)) return
      event.preventDefault()
    }

    document.addEventListener("wheel", preventBackgroundWheel, { capture: true, passive: false })
    document.addEventListener("touchmove", preventBackgroundTouchMove, {
      capture: true,
      passive: false,
    })

    return () => {
      document.removeEventListener("wheel", preventBackgroundWheel, { capture: true })
      document.removeEventListener("touchmove", preventBackgroundTouchMove, { capture: true })
      documentElement.style.overscrollBehavior = previousDocumentOverscrollBehavior
      body.style.overflow = previousBodyOverflow
      body.style.paddingRight = previousBodyPaddingRight
    }
  }, [isMenuOpen])

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return
    props.onInstanceModelChange(instanceId, model)
    setIsMenuOpen(false)
  }

  return (
    <Popover
      open={isMenuOpen}
      onOpenChange={open => {
        if (props.disabled) {
          setIsMenuOpen(false)
          return
        }
        setIsMenuOpen(open)
      }}
    >
      <PopoverTrigger
        render={
          <ComposerControl
            aria-label={props.triggerAriaLabel ?? "Select model"}
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 justify-between whitespace-nowrap",
              props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {activeEntry ? (
            <ProviderInstanceIcon
              driverKind={activeEntry.driverKind}
              displayName={activeEntry.displayName}
              accentColor={activeEntry.accentColor}
              showBadge={showInstanceBadge}
              className="size-4"
              iconClassName={cn("size-4", props.activeProviderIconClassName)}
              indicatorBackground="var(--input)"
              badgeClassName={cn(
                "right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3",
                "px-0.5 text-[7px]",
              )}
            />
          ) : null}
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 overflow-hidden truncate" />}>
              {triggerTitle}
            </TooltipTrigger>
            <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
          </Tooltip>
        </span>
        <span aria-hidden="true" className="flex items-center">
          <ComposerControlChevron />
        </span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="border-0 bg-transparent p-0 shadow-none before:hidden [-webkit-backdrop-filter:none]! [--viewport-inline-padding:0] [backdrop-filter:none]!"
        viewportClassName="rounded-lg !overflow-hidden p-0"
      >
        <ModelPickerContent
          activeInstanceId={activeInstanceId}
          model={props.model}
          lockedProvider={props.lockedProvider}
          lockedContinuationGroupKey={props.lockedContinuationGroupKey ?? null}
          instanceEntries={props.instanceEntries}
          modelOptionsByInstance={props.modelOptionsByInstance}
          terminalOpen={props.terminalOpen ?? false}
          onRequestClose={() => setIsMenuOpen(false)}
          {...(props.getModelDisabledReason
            ? { getModelDisabledReason: props.getModelDisabledReason }
            : {})}
          onInstanceModelChange={handleInstanceModelChange}
        />
      </PopoverPopup>
    </Popover>
  )
})
