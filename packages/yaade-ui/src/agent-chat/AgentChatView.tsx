import * as React from "react"
import {
  AlertCircle,
  Bot,
  Check,
  ChevronDown,
  CircleStop,
  ExternalLink,
  LoaderCircle,
  Paperclip,
  Puzzle,
  Send,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from "lucide-react"
import type {
  AgentConnectionState,
  AgentActionResponse,
  AgentElicitationAction,
  AgentPendingAction,
  AgentPermissionAction,
  AgentThreadSnapshot,
  AgentTimelineItem,
} from "@yaade/agent-protocol"
import { Button } from "@/components/ui/button.js"
import { Bubble, BubbleContent } from "@/components/ui/bubble.js"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker.js"
import { Message, MessageContent, MessageHeader } from "@/components/ui/message.js"
import { MessageScroller } from "@/components/ui/message-scroller.js"
import { Textarea } from "@/components/ui/textarea.js"
import { cn } from "@/lib/utils.js"
import { useVirtualizer } from "@tanstack/react-virtual"

export type AgentChatCallbacks = {
  onSend?: (text: string, attachments: AgentComposerAttachment[]) => void
  onUploadAttachment?: (file: File) => Promise<AgentComposerAttachment>
  onInterrupt?: () => void
  onRespondToAction?: (actionId: string, response: AgentActionResponse) => Promise<void>
  onConfigurationChange?: (id: string, value: string | boolean | number) => Promise<void>
}

export type AgentComposerAttachment = {
  id: string
  name: string
  mediaType: string
  kind: "upload" | "workspace-resource"
}

export type AgentChatViewProps = AgentChatCallbacks & {
  snapshot: AgentThreadSnapshot | null
  connection: AgentConnectionState | null
  className?: string
}

export function AgentChatView({ snapshot, connection, className, ...callbacks }: AgentChatViewProps) {
  const state = snapshot?.state
  const items = state ? state.itemOrder.flatMap(id => {
    const item = state.itemsById[id]
    return item ? [item] : []
  }) : []
  const running = state?.turns.some(turn => turn.status === "running") ?? false

  return (
    <section className={cn("flex h-full min-h-0 flex-col bg-background", className)} aria-label="Agent chat">
      <Status connection={connection} running={running} />
      {state == null
        ? <MessageScroller className="px-3 py-4 sm:px-5"><EmptyChat connected={connection?.status === "connected"} /></MessageScroller>
        : <VirtualizedTimeline items={items} />}
      {state?.pendingActions.length ? (
        <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-border bg-muted/20 px-3 py-3" data-yaade-agent-action-dock="">
          <div className="mx-auto grid w-full max-w-3xl gap-2">
            {state.pendingActions.map(action => <PendingAction key={action.id} action={action} {...callbacks} />)}
          </div>
        </div>
      ) : null}
      {state?.configuration.length ? <div className="shrink-0 border-t border-border px-3 py-2"><div className="mx-auto max-w-3xl"><Configuration options={state.configuration} onChange={callbacks.onConfigurationChange} /></div></div> : null}
      <Composer
        disabled={!state || connection?.status !== "connected"}
        running={running}
        canAttach={Boolean(state && (
          state.capabilities.input.uploadedFiles === "native" ||
          state.capabilities.input.uploadedFiles === "emulated" ||
          state.capabilities.input.workspaceFiles === "native" ||
          state.capabilities.input.workspaceFiles === "emulated"
        ))}
        {...callbacks}
      />
    </section>
  )
}

function VirtualizedTimeline({ items }: { items: AgentTimelineItem[] }) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const followRef = React.useRef(true)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 88,
    overscan: 6,
  })
  const revisionKey = items.map(item => `${item.id}:${item.revision}`).join("|")

  React.useLayoutEffect(() => {
    if (items.length > 0 && followRef.current) {
      virtualizer.scrollToIndex(items.length - 1, { align: "end" })
    }
  }, [items.length, revisionKey, virtualizer])

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
      data-yaade-agent-timeline=""
      onScroll={event => {
        const node = event.currentTarget
        followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
      }}
    >
      {items.length === 0 ? <EmptyChat connected /> : (
        <div className="relative mx-auto w-full max-w-3xl" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map(row => {
            const item = items[row.index]
            if (!item) return null
            return (
              <div
                key={item.id}
                ref={virtualizer.measureElement}
                data-index={row.index}
                className="absolute left-0 top-0 w-full px-3 py-2 sm:px-5"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <TimelineItemRenderer item={item} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function Status({ connection, running }: { connection: AgentConnectionState | null; running: boolean }) {
  const status = connection?.status ?? "disconnected"
  const busy = running || status === "connecting" || status === "reconnecting"
  const label = running ? "Working" : status === "connected" ? "Ready" : status.replaceAll("-", " ")
  return <Marker variant="border" className="shrink-0 px-3 py-2 text-2xs"><MarkerIcon>{busy ? <LoaderCircle className="animate-spin" /> : <Sparkles />}</MarkerIcon><MarkerContent>{label}</MarkerContent></Marker>
}

function EmptyChat({ connected }: { connected: boolean }) {
  return <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-3 px-6 text-center"><div className="flex size-10 items-center justify-center rounded-md bg-muted text-muted-foreground"><Bot className="size-5" /></div><div><h2 className="text-sm font-medium">{connected ? "Start a task" : "Agent unavailable"}</h2><p className="mt-1 text-xs text-muted-foreground">{connected ? "Ask for a change, an explanation, or a focused investigation." : "Reconnect the agent to continue this conversation."}</p></div></div>
}

export function TimelineItemRenderer({ item }: { item: AgentTimelineItem }) {
  switch (item.type) {
    case "user-message": return <Turn role="user" content={item.content.map(part => part.type === "workspace-resource" ? part.label ?? part.uri : part.type === "terminal-artifact" ? part.label ?? part.terminalId : part.text).join("\n")} />
    case "assistant-message": return <Turn role="assistant" content={item.text} streaming={item.status === "streaming"} />
    case "reasoning": return <Reasoning text={item.text} streaming={item.status === "streaming"} />
    case "tool-call": return <Tool item={item} />
    case "plan": return <Plan item={item} />
    case "error": return <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"><div className="flex items-center gap-2 font-medium"><AlertCircle className="size-4" />{item.message}</div>{item.code ? <p className="mt-1 font-mono text-3xs">{item.code}</p> : null}</div>
    case "diff": return <Marker><MarkerIcon><Terminal /></MarkerIcon><MarkerContent>Proposed change: {item.uri}</MarkerContent></Marker>
    case "subagent": return <Marker><MarkerIcon><Bot /></MarkerIcon><MarkerContent>{item.title} · {item.status}</MarkerContent></Marker>
    case "artifact": return <Marker><MarkerIcon><Puzzle /></MarkerIcon><MarkerContent>{item.title}</MarkerContent></Marker>
    case "extension": return null
  }
}

export function Turn({ role, content, streaming = false }: { role: "user" | "assistant"; content: string; streaming?: boolean }) {
  const user = role === "user"
  return <Message align={user ? "end" : "start"} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 72px" }}><MessageContent><MessageHeader>{user ? "You" : "Agent"}</MessageHeader><Bubble align={user ? "end" : "start"} variant={user ? "default" : "ghost"}><BubbleContent className="whitespace-pre-wrap">{content || (streaming ? "" : "No response content.")}{streaming ? <span className="ml-1 inline-block size-1.5 animate-pulse rounded-full bg-current" aria-label="Streaming" /> : null}</BubbleContent></Bubble></MessageContent></Message>
}

export function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = React.useState(streaming)
  return <div style={{ contentVisibility: "auto", containIntrinsicSize: "auto 44px" }}><button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors duration-[var(--yaade-motion-fast)] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setOpen(value => !value)} aria-expanded={open}><ChevronDown className={cn("size-3.5 transition-transform duration-[var(--yaade-motion-fast)]", !open && "-rotate-90")} />Reasoning{streaming ? "…" : ""}</button>{open ? <pre className="mt-1 whitespace-pre-wrap rounded-md bg-muted/50 p-3 font-mono text-2xs leading-relaxed text-muted-foreground">{text}</pre> : null}</div>
}

export function Tool({ item }: { item: Extract<AgentTimelineItem, { type: "tool-call" }> }) {
  const active = item.status === "running" || item.status === "pending"
  return <div className="rounded-md border border-border bg-card p-3 text-xs" style={{ contentVisibility: "auto", containIntrinsicSize: "auto 56px" }}><div className="flex items-center gap-2"><Wrench className={cn("size-4 text-muted-foreground", active && "animate-pulse")} /><span className="font-medium">{item.title}</span><span className="ml-auto text-3xs text-muted-foreground">{item.status}</span></div>{item.description ? <p className="mt-1 text-muted-foreground">{item.description}</p> : null}{item.progress?.message ? <p className="mt-2 font-mono text-3xs text-muted-foreground">{item.progress.message}</p> : null}</div>
}

export function Plan({ item }: { item: Extract<AgentTimelineItem, { type: "plan" }> }) {
  return <div className="rounded-md border border-border p-3"><p className="text-xs font-medium">{item.title ?? "Plan"}</p><ol className="mt-2 space-y-1.5 text-xs">{item.entries.map(entry => <li key={entry.id} className="flex gap-2"><Check className={cn("mt-0.5 size-3.5 shrink-0", entry.status === "completed" ? "text-success" : "text-muted-foreground")} /><span className={cn(entry.status === "completed" && "text-muted-foreground line-through")}>{entry.text}</span></li>)}</ol></div>
}

function PendingAction(props: AgentChatCallbacks & { action: AgentPendingAction }) {
  const [submitting, setSubmitting] = React.useState(false)
  const submittingRef = React.useRef(false)
  const [error, setError] = React.useState<string | null>(null)
  const respond = async (response: AgentActionResponse): Promise<void> => {
    if (submittingRef.current || !props.onRespondToAction) return
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      await props.onRespondToAction(props.action.id, response)
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "Could not answer the agent.")
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }
  const errorMessage = error ? <p className="mt-2 text-xs text-destructive" role="alert">{error} Select an action to retry.</p> : null
  if (props.action.type === "permission") return <Permission action={props.action} submitting={submitting} error={errorMessage} onRespond={optionId => respond({ type: "permission", optionId })} />
  if (props.action.type === "elicitation") return <Elicitation action={props.action} submitting={submitting} error={errorMessage} onRespond={values => respond({ type: "elicitation", values })} />
  return <div className="rounded-md border border-warning/30 bg-warning/10 p-3 text-xs" aria-busy={submitting}><p className="font-medium">{props.action.title}</p>{props.action.description ? <p className="mt-1 text-muted-foreground">{props.action.description}</p> : null}<div className="mt-3 flex flex-wrap gap-2">{props.action.url ? <Button asChild size="sm" variant="outline"><a href={props.action.url} target="_blank" rel="noreferrer"><ExternalLink />Open sign-in</a></Button> : null}<Button size="sm" disabled={submitting} aria-busy={submitting} onClick={() => void respond({ type: "authentication", status: "completed" })}>{submitting ? "Submitting…" : "I’m signed in"}</Button><Button size="sm" variant="ghost" disabled={submitting} onClick={() => void respond({ type: "authentication", status: "cancelled" })}>Cancel</Button></div>{errorMessage}</div>
}

export function Permission({ action, submitting, error, onRespond }: { action: AgentPermissionAction; submitting: boolean; error: React.ReactNode; onRespond?: (optionId: string) => void }) {
  return <div className="rounded-md border border-warning/30 bg-warning/10 p-3" aria-busy={submitting}><p className="text-sm font-medium">{action.title}</p>{action.description ? <p className="mt-1 text-xs text-muted-foreground">{action.description}</p> : null}<div className="mt-3 flex flex-wrap gap-2">{action.options.map(option => <Button key={option.id} type="button" size="sm" disabled={submitting} aria-busy={submitting} variant={option.decision.startsWith("allow") ? "default" : "outline"} title={option.description} onClick={() => onRespond?.(option.id)}>{submitting ? "Submitting…" : option.label}</Button>)}</div>{error}</div>
}

export function Elicitation({ action, submitting, error, onRespond }: { action: AgentElicitationAction; submitting: boolean; error: React.ReactNode; onRespond?: (values: Record<string, unknown>) => void }) {
  const [values, setValues] = React.useState<Record<string, unknown>>({})
  return <form className="rounded-md border border-border bg-card p-3" aria-busy={submitting} onSubmit={event => { event.preventDefault(); if (!submitting) onRespond?.(values) }}><p className="text-sm font-medium">{action.title}</p>{action.description ? <p className="mt-1 text-xs text-muted-foreground">{action.description}</p> : null}<div className="mt-3 space-y-3">{action.fields.map(field => <label key={field.id} className="block text-xs font-medium">{field.label}{field.required ? " *" : ""}{field.description ? <span className="mt-0.5 block font-normal text-muted-foreground">{field.description}</span> : null}{field.input === "confirm" ? <input className="mt-2" type="checkbox" disabled={submitting} checked={values[field.id] === true} onChange={event => { const checked = event.currentTarget.checked; setValues(current => ({ ...current, [field.id]: checked })) }} /> : field.choices ? <select className="mt-2 flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs" disabled={submitting} multiple={field.input === "multi-select"} required={field.required} onChange={event => { const value = field.input === "multi-select" ? [...event.currentTarget.selectedOptions].map(option => option.value) : event.currentTarget.value; setValues(current => ({ ...current, [field.id]: value })) }}>{!field.required && field.input !== "multi-select" ? <option value="">Select…</option> : null}{field.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select> : <input className="mt-2 flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs" disabled={submitting} required={field.required} onChange={event => { const value = event.currentTarget.value; setValues(current => ({ ...current, [field.id]: value })) }} />}</label>)}</div><Button type="submit" size="sm" className="mt-3" disabled={submitting} aria-busy={submitting}>{submitting ? "Submitting…" : "Continue"}</Button>{error}</form>
}

function Configuration({ options, onChange }: { options: AgentThreadSnapshot["state"]["configuration"]; onChange?: AgentChatCallbacks["onConfigurationChange"] }) {
  const [submitting, setSubmitting] = React.useState<string | null>(null)
  const submittingRef = React.useRef(false)
  const [error, setError] = React.useState<string | null>(null)
  const update = async (id: string, value: string | boolean | number): Promise<void> => {
    if (submittingRef.current || !onChange) return
    submittingRef.current = true
    setSubmitting(id)
    setError(null)
    try { await onChange(id, value) } catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : "Could not change configuration.") } finally { submittingRef.current = false; setSubmitting(null) }
  }
  return <details className="rounded-md border border-border p-3 text-xs"><summary className="cursor-pointer font-medium">Configuration</summary><div className="mt-3 grid gap-2">{options.map(option => { const busy = submitting === option.id; return <label key={option.id} className="flex items-center justify-between gap-3"><span>{option.label}</span>{option.value.type === "boolean" ? <input type="checkbox" disabled={submitting !== null} aria-busy={busy} checked={option.value.current} onChange={event => void update(option.id, event.target.checked)} /> : option.value.type === "enum" ? <select value={option.value.current} disabled={submitting !== null} aria-busy={busy} className="h-7 rounded-md border border-input bg-background px-1.5" onChange={event => void update(option.id, event.target.value)}>{option.value.choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select> : <input type={option.value.type === "number" ? "number" : "text"} value={option.value.current} disabled={submitting !== null} aria-busy={busy} className="h-7 w-32 rounded-md border border-input bg-background px-1.5" min={option.value.type === "number" ? option.value.minimum : undefined} max={option.value.type === "number" ? option.value.maximum : undefined} onChange={event => void update(option.id, option.value.type === "number" ? Number(event.target.value) : event.target.value)} />}</label>})}</div>{error ? <p className="mt-2 text-xs text-destructive" role="alert">{error} Change the value to retry.</p> : null}</details>
}

export function Composer({ disabled, running, canAttach, onSend, onInterrupt, onUploadAttachment }: AgentChatCallbacks & { disabled: boolean; running: boolean; canAttach: boolean }) {
  const [text, setText] = React.useState("")
  const [attachments, setAttachments] = React.useState<AgentComposerAttachment[]>([])
  const [uploading, setUploading] = React.useState(false)
  const [uploadError, setUploadError] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const submit = () => {
    const value = text.trim()
    if ((!value && attachments.length === 0) || disabled || uploading) return
    onSend?.(value, attachments)
    setText("")
    setAttachments([])
  }
  const addFiles = async (files: File[]) => {
    if (!onUploadAttachment || files.length === 0) return
    setUploading(true)
    setUploadError(null)
    try {
      for (const file of files) {
        const uploaded = await onUploadAttachment(file)
        setAttachments(current => current.some(item => item.id === uploaded.id) ? current : [...current, uploaded])
      }
    } catch (cause) {
      setUploadError(cause instanceof Error && cause.message ? cause.message : "Could not upload attachment.")
    } finally {
      setUploading(false)
    }
  }
  const addWorkspaceUris = (textValue: string): boolean => {
    const uris = textValue.split(/\r?\n/).map(value => value.trim()).filter(value => value.startsWith("file:"))
    if (uris.length === 0) return false
    setAttachments(current => [...current, ...uris.filter(uri => !current.some(item => item.id === uri)).map(uri => ({ id: uri, name: decodeURIComponent(uri.split("/").at(-1) ?? uri), mediaType: "application/octet-stream", kind: "workspace-resource" as const }))])
    return true
  }
  return <form className="shrink-0 border-t border-border bg-background p-3" data-yaade-agent-drop-zone="" onDragOver={event => { if (canAttach) { event.preventDefault(); event.dataTransfer.dropEffect = "copy" } }} onDrop={event => { if (!canAttach) return; event.preventDefault(); event.stopPropagation(); const uriText = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain"); if (!addWorkspaceUris(uriText)) void addFiles([...event.dataTransfer.files]) }} onSubmit={event => { event.preventDefault(); submit() }}><div className="mx-auto max-w-3xl">{attachments.length ? <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Agent attachments">{attachments.map(item => <span key={item.id} className="inline-flex max-w-56 items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-2xs"><Paperclip className="size-3 shrink-0" /><span className="truncate">{item.name}</span><button type="button" className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Remove ${item.name}`} onClick={() => setAttachments(current => current.filter(candidate => candidate.id !== item.id))}><X className="size-3" /></button></span>)}</div> : null}{uploadError ? <p className="mb-2 text-xs text-destructive" role="alert">{uploadError}</p> : null}<div className="flex items-end gap-2">{canAttach ? <><input ref={inputRef} className="sr-only" type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp,text/plain,text/markdown,application/json" onChange={event => { void addFiles([...event.currentTarget.files ?? []]); event.currentTarget.value = "" }} /><Button type="button" size="icon" variant="ghost" disabled={disabled || uploading} aria-label="Attach files" onClick={() => inputRef.current?.click()}><Paperclip /></Button></> : null}<Textarea aria-label="Message agent" value={text} disabled={disabled} placeholder={disabled ? "Agent is not connected" : "Ask the agent…"} className="min-h-10 max-h-32 resize-y text-sm" onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit() } }} />{running ? <Button type="button" size="icon" variant="outline" aria-label="Interrupt agent" onClick={onInterrupt}><CircleStop /></Button> : <Button type="submit" size="icon" disabled={disabled || uploading || (text.trim().length === 0 && attachments.length === 0)} aria-label="Send message"><Send /></Button>}</div><p className="mt-1 text-3xs text-muted-foreground">{uploading ? "Uploading attachment…" : "Enter to send · Shift+Enter for a new line · Drop workspace files here"}</p></div></form>
}
