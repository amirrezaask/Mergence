import { Effect, Stream } from "effect";
import { GitToolOutput, type ToolUse, type ToolUseInput } from "@yaade/rpc";
import type { ToolDriver, ToolRuntimeEvent } from "./model.js";

/** Runtime adapter for the interactive Git history/review surface. */
export class GitToolDriver implements ToolDriver {
  readonly kind = "git" as const;

  create(_toolUse: ToolUse, _input: ToolUseInput) {
    return Effect.succeed(GitToolOutput.make({ kind: "git" }));
  }

  restart(toolUse: ToolUse) {
    return Effect.succeed(
      toolUse.output.kind === "git"
        ? toolUse.output
        : GitToolOutput.make({ kind: "git" }),
    );
  }

  cancel(toolUse: ToolUse) {
    return Effect.succeed(
      toolUse.output.kind === "git"
        ? toolUse.output
        : GitToolOutput.make({ kind: "git" }),
    );
  }

  attach(toolUse: ToolUse): Stream.Stream<ToolRuntimeEvent> {
    return Stream.succeed({ _tag: "OutputChanged", toolUse });
  }

  close(_toolUse: ToolUse) {
    return Effect.void;
  }
}
