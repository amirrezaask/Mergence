import type { ReactElement } from "react";
import { KeyBindingKbd } from "@yaade/ui";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@yaade/ui/primitives";

export function ShortcutTooltip(props: {
  readonly label: string;
  readonly shortcut?: string;
  readonly side?: "top" | "bottom";
  readonly children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{props.children}</TooltipTrigger>
      <TooltipContent side={props.side ?? "top"}>
        <span className="flex items-center gap-1.5">
          <span>{props.label}</span>
          {props.shortcut ? <KeyBindingKbd binding={props.shortcut} /> : null}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
