import type {
  TextFileReadResult,
  TextFileWriteOptions,
  TextFileWriteResult,
} from "@yaade/rpc";

/** Platform-neutral bridge between the renderer and the Yaade host process. */
export interface YaadeHostTransport {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
  /** Optional per-request cancellation used by intent-driven cold-path queries. */
  invokeWithSignal?<T>(
    channel: string,
    args: unknown[],
    signal: AbortSignal,
  ): Promise<T>;
  readTextFile?(uri: string): Promise<TextFileReadResult>;
  writeTextFile?(
    uri: string,
    content: string,
    options: TextFileWriteOptions,
  ): Promise<TextFileWriteResult>;
  /** Observable realtime invoke. Resolves only after the host applies the command. */
  invokeRealtime?<T>(channel: string, ...args: unknown[]): Promise<T> | null;
  /** Legacy fire-and-forget send for callers that do not need delivery status. */
  sendRealtime?(channel: string, ...args: unknown[]): boolean;
  on(channel: string, listener: (...args: unknown[]) => void): () => void;
}
