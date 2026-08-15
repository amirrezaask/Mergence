import { useDraggable } from "@dnd-kit/core";
import { GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/lib/utils.js";
import { sessionDndId, type SessionDragData } from "./tab-dnd-types.js";

export type DockSourceHandleProps = {
  readonly tabId: string;
  readonly label: string;
  readonly className?: string;
};

/** Drag a resident sidebar/tab item into a PanelDock without moving its source. */
export function DockSourceHandle(props: DockSourceHandleProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: sessionDndId(props.tabId),
    data: {
      type: "session",
      tabId: props.tabId,
      label: props.label,
    } satisfies SessionDragData,
  });

  return (
    <Button
      ref={setNodeRef}
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={`Drag ${props.label} into workspace`}
      title="Drag into workspace"
      data-yaade-dock-source={props.tabId}
      data-dragging={isDragging ? "" : undefined}
      className={cn(
        "shrink-0 touch-none cursor-grab text-muted-foreground opacity-0 active:cursor-grabbing group-hover:opacity-70 group-focus-within:opacity-70 focus-visible:opacity-100 data-[dragging]:opacity-40",
        props.className,
      )}
      onClick={(event) => event.stopPropagation()}
      {...attributes}
      {...listeners}
    >
      <GripVertical />
    </Button>
  );
}
