type SearchNvimSession = {
  readonly ptyId: string;
};

/** Auxiliary editor PTYs are owned by their Search ToolUse, not by React mounts. */
const sessions = new Map<string, SearchNvimSession>();

export function searchNvimSessionKey(
  toolUseId: string,
  checkoutPath: string,
): string {
  return `${toolUseId}:${checkoutPath}`;
}

export function searchNvimPtyId(key: string): string | undefined {
  return sessions.get(key)?.ptyId;
}

export function rememberSearchNvimSession(key: string, ptyId: string): void {
  sessions.set(key, { ptyId });
}

export function forgetSearchNvimSession(key: string): void {
  sessions.delete(key);
}

/** Dispose every auxiliary Neovim PTY owned by one Search ToolUse. */
export async function disposeSearchNvimSessions(
  toolUseId: string,
  disposePty = globalThis.window?.yaade?.terminal?.dispose,
): Promise<void> {
  const prefix = `${toolUseId}:`;
  const pending: Promise<unknown>[] = [];
  for (const [key, session] of sessions) {
    if (!key.startsWith(prefix)) continue;
    sessions.delete(key);
    if (disposePty) {
      pending.push(disposePty(session.ptyId).catch(() => undefined));
    }
  }
  await Promise.all(pending);
}
