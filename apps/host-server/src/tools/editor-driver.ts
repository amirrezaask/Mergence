import { Effect, Stream } from "effect";
import { EditorToolOutput, type ToolUse, type ToolUseInput } from "@yaade/rpc";
import type { ToolDriver, ToolRuntimeEvent } from "./model.js";

/** Runtime adapter for the always-available code editor surface. */
export class EditorToolDriver implements ToolDriver {
  readonly kind = "editor" as const;

  create(_toolUse: ToolUse, _input: ToolUseInput) {
    return Effect.succeed(EditorToolOutput.make({ kind: "editor" }));
  }

  restart(toolUse: ToolUse) {
    return Effect.succeed(
      toolUse.output.kind === "editor"
        ? toolUse.output
        : EditorToolOutput.make({ kind: "editor" }),
    );
  }

  cancel(toolUse: ToolUse) {
    return Effect.succeed(
      toolUse.output.kind === "editor"
        ? toolUse.output
        : EditorToolOutput.make({ kind: "editor" }),
    );
  }

  attach(toolUse: ToolUse): Stream.Stream<ToolRuntimeEvent> {
    return Stream.succeed({ _tag: "OutputChanged", toolUse });
  }

  close(_toolUse: ToolUse) {
    return Effect.void;
  }
}
