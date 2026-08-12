import { SquareTerminal } from "lucide-react"
import {
  ClaudeAI,
  CursorIcon,
  GrokIcon,
  OpenAI,
  OpenCodeIcon,
  PiIcon,
  type Icon,
} from "./provider-icons.js"
import { cn } from "@/lib/utils.js"

export function AgentProviderIcon({
  agent,
  className,
}: {
  agent: string
  className?: string
}) {
  const cls = cn("size-3.5 shrink-0", className)
  const id = agent.toLowerCase()
  if (id === "terminal" || id === "shell") {
    return <SquareTerminal className={cn(cls, "text-muted-foreground")} aria-hidden />
  }
  const IconComp: Icon | null =
    id === "claude"
      ? ClaudeAI
      : id === "cursor"
        ? CursorIcon
        : id === "codex"
          ? OpenAI
          : id === "opencode"
            ? OpenCodeIcon
            : id === "pi"
              ? PiIcon
              : id === "grok"
                ? GrokIcon
                : null
  return IconComp ? (
    <IconComp className={cls} aria-hidden />
  ) : (
    <SquareTerminal className={cn(cls, "text-muted-foreground")} aria-hidden />
  )
}
