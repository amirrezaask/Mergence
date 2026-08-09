import { memo, useMemo, useState } from "react"
import { CircleAlertIcon } from "lucide-react"
import type { ProviderOptionSelection, ServerProviderModel } from "./contracts/types.js"
import { getCatalogModels } from "./contracts/models-catalog.js"
import { cn } from "./lib/cn.js"
import { Button } from "./ui/button.js"
import { Separator } from "./ui/separator.js"
import { ComposerPromptEditor } from "./ComposerPromptEditor.js"
import { ProviderModelPicker } from "./ProviderModelPicker.js"
import { shouldRenderTraitsControls, TraitsPicker } from "./TraitsPicker.js"
import { ComposerPrimaryActions } from "./ComposerPrimaryActions.js"
import type { ProviderInstanceEntry } from "./providerInstances.js"
import type { ModelEsque } from "./providerIconUtils.js"

export type ChatComposerSubmitPayload = {
  text: string
  instanceId: string
  yaadeDriverId: string
  providerId: string
  driverKind: string
  model: string
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined
}

export type ChatComposerProps = {
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>
  modelOptionsByInstance: ReadonlyMap<string, ReadonlyArray<ModelEsque & Partial<ServerProviderModel>>>
  activeInstanceId: string
  model: string
  modelOptions?: ReadonlyArray<ProviderOptionSelection>
  onInstanceModelChange: (instanceId: string, model: string) => void
  onModelOptionsChange: (next: ReadonlyArray<ProviderOptionSelection> | undefined) => void
  isRunning?: boolean
  isConnecting?: boolean
  isSendBusy?: boolean
  sendDisabledReason?: string | null
  onSubmit: (payload: ChatComposerSubmitPayload) => void | Promise<void>
  onInterrupt?: () => void
  className?: string
  placeholder?: string
}

export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const [prompt, setPrompt] = useState("")
  const [pickerOpen, setPickerOpen] = useState(false)

  const activeEntry =
    props.instanceEntries.find(entry => entry.instanceId === props.activeInstanceId) ?? null
  const noProviderAvailable =
    props.instanceEntries.length === 0 || props.instanceEntries.every(entry => !entry.available)

  const catalogModels: ReadonlyArray<ServerProviderModel> = useMemo(() => {
    if (!activeEntry) return []
    return getCatalogModels(activeEntry.driverKind)
  }, [activeEntry])

  const traitsVisible =
    activeEntry !== null &&
    shouldRenderTraitsControls({
      provider: activeEntry.driverKind,
      models: catalogModels,
      model: props.model,
      prompt,
      modelOptions: props.modelOptions,
    })

  const hasSendableContent = prompt.trim().length > 0
  const sendDisabledReason =
    props.sendDisabledReason ??
    (noProviderAvailable
      ? "No provider available"
      : activeEntry && !activeEntry.available
        ? activeEntry.unavailableReason ?? "Provider unavailable"
        : null)

  const submit = () => {
    if (!activeEntry || !hasSendableContent || sendDisabledReason || props.isSendBusy) return
    const text = prompt.trim()
    void Promise.resolve(
      props.onSubmit({
        text,
        instanceId: activeEntry.instanceId,
        yaadeDriverId: activeEntry.yaadeDriverId,
        providerId: activeEntry.providerId,
        driverKind: activeEntry.driverKind,
        model: props.model,
        modelOptions: props.modelOptions,
      }),
    ).then(() => {
      setPrompt("")
    })
  }

  return (
    <form
      className={cn("w-full", props.className)}
      data-yaade-agent-composer=""
      data-chat-composer=""
      onSubmit={event => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="chat-composer-glass-shell relative mx-auto w-full max-w-3xl">
        <div className="chat-composer-glass-host relative z-10 w-full rounded-[22px]">
          <div className="relative z-10 flex flex-col">
            <ComposerPromptEditor
              value={prompt}
              onChange={setPrompt}
              onSubmit={submit}
              disabled={Boolean(props.isConnecting) || noProviderAvailable}
              placeholder={
                props.placeholder ??
                (noProviderAvailable
                  ? "Enable a provider to send a message"
                  : "Ask anything, @tag files/folders, $use skills, or / for commands")
              }
            />

            <div
              data-chat-composer-footer="true"
              className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4"
            >
              <div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {noProviderAvailable ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled
                    data-chat-provider-unavailable="true"
                    className="shrink-0 gap-2 px-2 text-muted-foreground/70 sm:px-3"
                  >
                    <CircleAlertIcon className="size-4" />
                    No provider available
                  </Button>
                ) : (
                  <ProviderModelPicker
                    activeInstanceId={props.activeInstanceId}
                    model={props.model}
                    lockedProvider={null}
                    instanceEntries={props.instanceEntries}
                    modelOptionsByInstance={props.modelOptionsByInstance}
                    triggerClassName="-ms-px ps-0"
                    open={pickerOpen}
                    onOpenChange={setPickerOpen}
                    onInstanceModelChange={props.onInstanceModelChange}
                    getModelDisabledReason={(instanceId, _model) => {
                      const entry = props.instanceEntries.find(item => item.instanceId === instanceId)
                      if (!entry) return "Unknown provider"
                      if (!entry.available) return entry.unavailableReason ?? "Unavailable"
                      return null
                    }}
                  />
                )}

                {traitsVisible && activeEntry ? (
                  <>
                    <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
                    <TraitsPicker
                      provider={activeEntry.driverKind}
                      instanceId={activeEntry.instanceId}
                      models={catalogModels}
                      model={props.model}
                      prompt={prompt}
                      onPromptChange={setPrompt}
                      modelOptions={props.modelOptions}
                      onModelOptionsChange={props.onModelOptionsChange}
                    />
                  </>
                ) : null}
              </div>

              <div
                data-chat-composer-actions="right"
                className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
              >
                <ComposerPrimaryActions
                  compact={false}
                  isRunning={Boolean(props.isRunning)}
                  promptHasText={prompt.trim().length > 0}
                  isSendBusy={Boolean(props.isSendBusy)}
                  sendDisabledReason={sendDisabledReason}
                  isConnecting={Boolean(props.isConnecting)}
                  hasSendableContent={hasSendableContent}
                  onInterrupt={() => props.onInterrupt?.()}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </form>
  )
})
