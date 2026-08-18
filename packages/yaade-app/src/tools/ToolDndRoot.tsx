import type { ReactNode } from "react";
import { TabDndRoot, type TabDndHandlers } from "@yaade/ui/session";

export type ToolDndRootProps = {
  readonly handlers: TabDndHandlers;
  readonly children: ReactNode;
};

export default function ToolDndRoot(props: ToolDndRootProps) {
  return <TabDndRoot handlers={props.handlers}>{props.children}</TabDndRoot>;
}
