import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import type { YaadeServerDefinition } from "@yaade/shared"
import {
  decodeStoredServerDefinitions,
  loadStoredServerDefinitions,
  saveStoredServerDefinitions,
  type MultiServerHostClient,
  type MultiServerSnapshot,
  type ServerTestResult,
} from "@yaade/host-client"

export type ServerConnectionsContextValue = {
  readonly manager: MultiServerHostClient
  readonly snapshot: MultiServerSnapshot
  readonly servers: readonly YaadeServerDefinition[]
  readonly updateServers: (servers: readonly YaadeServerDefinition[]) => void
  readonly testServer: (server: YaadeServerDefinition) => Promise<ServerTestResult>
}

const ServerConnectionsContext = createContext<ServerConnectionsContextValue | null>(null)

async function loadClientServerDefinitions(): Promise<YaadeServerDefinition[]> {
  const load = window.yaadeDesktop?.loadServerDefinitions
  if (load) {
    try {
      return decodeStoredServerDefinitions(await load())
    } catch {
      return []
    }
  }
  return loadStoredServerDefinitions()
}

function saveClientServerDefinitions(
  servers: readonly YaadeServerDefinition[],
): Promise<void> {
  const save = window.yaadeDesktop?.saveServerDefinitions
  if (save) {
    return save(servers).then(() => undefined).catch(() => undefined)
  }
  saveStoredServerDefinitions(servers)
  return Promise.resolve()
}

export function ServerConnectionsProvider(props: {
  readonly manager: MultiServerHostClient
  readonly children: ReactNode
}) {
  const snapshot = useSyncExternalStore(
    props.manager.subscribe,
    props.manager.getSnapshot,
    props.manager.getSnapshot,
  )
  const userChangedServers = useRef(false)
  const [servers, setServers] = useState<readonly YaadeServerDefinition[]>(() =>
    props.manager.getServerDefinitions(),
  )

  useEffect(() => {
    if (!window.yaadeDesktop) return
    let cancelled = false
    void loadClientServerDefinitions().then(next => {
      if (!cancelled && !userChangedServers.current) {
        props.manager.setServers(next)
        setServers(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [props.manager])

  const updateServers = useCallback(
    (next: readonly YaadeServerDefinition[]) => {
      userChangedServers.current = true
      setServers([...next])
      props.manager.setServers(next)
      void saveClientServerDefinitions(next)
    },
    [props.manager],
  )
  const testServer = useCallback(
    (server: YaadeServerDefinition) => props.manager.testServer(server),
    [props.manager],
  )
  const value = useMemo<ServerConnectionsContextValue>(
    () => ({ manager: props.manager, snapshot, servers, updateServers, testServer }),
    [props.manager, servers, snapshot, testServer, updateServers],
  )

  return (
    <ServerConnectionsContext.Provider value={value}>
      {props.children}
    </ServerConnectionsContext.Provider>
  )
}

export function useServerConnections(): ServerConnectionsContextValue {
  const value = useContext(ServerConnectionsContext)
  if (!value) throw new Error("Server connections are unavailable")
  return value
}
