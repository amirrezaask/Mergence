import {
  basename,
  canonicalizeFileUri,
  Emitter,
  fileUriToPath,
  isUntitledUri,
  languageIdFromPath,
  makeUntitledUri,
} from "@yaade/shared"
import type { PanelId, PanelView } from "@yaade/shared"
import type { YaadePanelTree } from "./panel-tree.js"
import type { WorkspaceFile, WorkspaceRoot } from "./types.js"
import { JumpStack } from "./jump-stack.js"
import { allocListId, ListDocumentStore, type ListDocument } from "./list-document.js"
import { TaskRunner } from "./task-runner.js"
import {
  activatePanelTab,
  findPanelWithTab,
  panelHasTab,
  panelTabIds,
  popPanelTab,
  pushPanelTab,
} from "./panel-tabs.js"
import {
  EXPLORER_TAB_ID,
  OUTPUT_TAB_ID,
  PROBLEMS_TAB_ID,
  TabRegistry,
  type TabDescriptor,
  type TabKind,
  type KnownTabKind,
} from "./tab-registry.js"
import {
  type ConfirmDiscardReloadFn,
  type WorkspaceFolder,
  WorkspaceFolderState,
  WorkspaceManager,
} from "./workspace-manager.js"

/** Tab kinds whose payload lives in the list store and should be disposed with the tab. */
const LIST_TAB_KINDS = new Set<string>([
  "search",
  "problems",
  "references",
  "definitions",
  "task-errors",
])

export type { ConfirmDiscardReloadFn, WorkspaceFolder }
export { WorkspaceManager, WorkspaceFolderState }

export class WorkspaceService {
  confirmDiscardReload: ConfirmDiscardReloadFn | null = null
  openBuffers: string[] = []
  private untitledFiles = new Map<string, WorkspaceFile>()
  /** Files opened outside any workspace folder (stdlib, module cache, etc.). */
  private externalFiles = new Map<string, WorkspaceFile>()
  private externalBaselines = new Map<string, string>()
  private untitledCounter = 1

  readonly jumpStack = new JumpStack()
  readonly tabRegistry = new TabRegistry()
  readonly listStore = new ListDocumentStore()
  readonly taskRunner = new TaskRunner()

  readonly onDidOpenFile = new Emitter<WorkspaceFile>()
  readonly onDidChangeDirty = new Emitter<{ uri: string; isDirty: boolean }>()
  readonly onDidChangeSavedBaseline = new Emitter<{ uri: string; content: string }>()
  readonly onDidOpenWorkspace = new Emitter<WorkspaceRoot>()
  readonly onFileReload = new Emitter<{ uri: string; content: string }>()
  readonly onDidChangeBuffers = new Emitter<void>()

  constructor(readonly manager: WorkspaceManager) {
    this.wireFolderEvents()
  }

  get root(): WorkspaceRoot | null {
    return this.manager.activeFolder?.root ?? null
  }

  get folders(): WorkspaceFolder[] {
    return this.manager.folders
  }

  private wireFolderEvents(): void {
    this.manager.onDidAddFolder.event(folder => {
      const state = this.manager.folderStateForId(folder.id)
      if (!state) return
      this.bindFolderState(state)
      this.onDidOpenWorkspace.fire(folder.root)
    })
  }

  private bindFolderState(state: WorkspaceFolderState): void {
    state.confirmDiscardReload = this.confirmDiscardReload
    state.onDidOpenFile.event(file => this.onDidOpenFile.fire(file))
    state.onDidChangeDirty.event(evt => {
      this.onDidChangeDirty.fire(evt)
      this.tabRegistry.update(evt.uri, { label: this.fileForUri(evt.uri)?.name ?? evt.uri })
    })
    state.onDidChangeSavedBaseline.event(evt => this.onDidChangeSavedBaseline.fire(evt))
    state.onFileReload.event(evt => this.onFileReload.fire(evt))
  }

  set confirmDiscardReloadFn(fn: ConfirmDiscardReloadFn | null) {
    this.confirmDiscardReload = fn
    for (const state of this.manager.allFolderStates()) {
      state.confirmDiscardReload = fn
    }
  }

  async openWorkspace(folderPath: string): Promise<void> {
    await this.manager.replaceAllFolders(folderPath)
    this.openBuffers = []
    this.untitledFiles.clear()
    this.onDidChangeBuffers.fire()
  }

  async addFolder(folderPath: string): Promise<WorkspaceFolder> {
    const folder = await this.manager.addFolder(folderPath)
    const state = this.manager.folderStateForId(folder.id)
    if (state) this.bindFolderState(state)
    return folder
  }

  async replaceAllFolders(folderPath: string): Promise<WorkspaceFolder> {
    await this.openWorkspace(folderPath)
    return this.manager.activeFolder!
  }

  removeFolder(id: string): boolean {
    return this.manager.removeFolder(id)
  }

  setActiveFolder(id: string): void {
    this.manager.setActiveFolder(id)
  }

  clearActiveFolder(): void {
    this.manager.clearActiveFolder()
  }

  folderStateForUri(uri: string): WorkspaceFolderState | undefined {
    if (isUntitledUri(uri)) return undefined
    return this.manager.folderStateForUri(uri)
  }

  resolveRootUriForFile(fileUri: string): string | null {
    if (isUntitledUri(fileUri)) {
      const folders = this.manager.folders
      if (folders.length === 1) return folders[0]!.root.uri
      return this.manager.activeFolder?.root.uri ?? null
    }
    return this.manager.folderStateForUri(fileUri)?.root.uri ?? null
  }

  hasDirtyFilesUnderFolder(folderId: string): boolean {
    return this.manager.folderStateForId(folderId)?.hasDirtyFiles() ?? false
  }

  urisUnderFolder(folderId: string): string[] {
    const state = this.manager.folderStateForId(folderId)
    if (!state) return []
    return [...state.allFiles()].map(f => f.uri)
  }

  fileForUri(uri: string): WorkspaceFile | undefined {
    if (isUntitledUri(uri)) return this.untitledFiles.get(uri)
    const canonical = canonicalizeFileUri(uri)
    return (
      this.manager.folderStateForUri(canonical)?.fileForUri(canonical) ??
      this.manager.folderStateForUri(uri)?.fileForUri(uri) ??
      this.externalFiles.get(canonical) ??
      this.externalFiles.get(uri)
    )
  }

  registerFile(file: WorkspaceFile): void {
    if (isUntitledUri(file.uri)) {
      this.untitledFiles.set(file.uri, file)
      return
    }
    const state = this.manager.folderStateForUri(file.uri)
    if (!state) {
      this.externalFiles.set(canonicalizeFileUri(file.uri), file)
      return
    }
    state.registerFile(file)
  }

  touchBuffer(uri: string): void {
    const path = fileUriToPath(uri)
    this.openBuffers = [uri, ...this.openBuffers.filter(u => fileUriToPath(u) !== path)]
    this.onDidChangeBuffers.fire()
  }

  closeBuffer(uri: string): void {
    const path = fileUriToPath(uri)
    const canonical = isUntitledUri(uri) ? uri : canonicalizeFileUri(uri)
    this.openBuffers = this.openBuffers.filter(u => fileUriToPath(u) !== path)
    if (isUntitledUri(uri)) {
      this.untitledFiles.delete(uri)
    } else {
      this.manager.folderStateForUri(uri)?.evictFile(uri)
      this.manager.folderStateForUri(canonical)?.evictFile(canonical)
      this.externalFiles.delete(uri)
      this.externalFiles.delete(canonical)
      this.externalBaselines.delete(uri)
      this.externalBaselines.delete(canonical)
    }
    this.onDidChangeBuffers.fire()
  }

  markDirty(uri: string, isDirty: boolean): void {
    if (isUntitledUri(uri)) {
      const file = this.untitledFiles.get(uri)
      if (!file || file.isDirty === isDirty) return
      file.isDirty = isDirty
      this.onDidChangeDirty.fire({ uri, isDirty })
      this.tabRegistry.update(uri, { label: file.name })
      return
    }
    const state = this.manager.folderStateForUri(uri)
    if (state) {
      state.markDirty(uri, isDirty)
      return
    }
    const file = this.externalFiles.get(canonicalizeFileUri(uri)) ?? this.externalFiles.get(uri)
    if (!file || file.isDirty === isDirty) return
    file.isDirty = isDirty
    this.onDidChangeDirty.fire({ uri: file.uri, isDirty })
    this.tabRegistry.update(file.uri, { label: file.name })
  }

  setSavedBaseline(uri: string, content: string): void {
    if (isUntitledUri(uri)) return
    const state = this.manager.folderStateForUri(uri)
    if (state) {
      state.setSavedBaseline(uri, content)
      return
    }
    const canonical = canonicalizeFileUri(uri)
    this.externalBaselines.set(canonical, content)
    this.onDidChangeSavedBaseline.fire({ uri: canonical, content })
  }

  savedBaselineFor(uri: string): string | undefined {
    if (isUntitledUri(uri)) return undefined
    const state = this.manager.folderStateForUri(uri)
    if (state) return state.savedBaselineFor(uri)
    const canonical = canonicalizeFileUri(uri)
    return this.externalBaselines.get(canonical) ?? this.externalBaselines.get(uri)
  }

  syncDirtyFromDoc(uri: string, content: string): void {
    if (isUntitledUri(uri)) return
    this.manager.folderStateForUri(uri)?.syncDirtyFromDoc(uri, content)
  }

  clearDirtyState(uri: string): void {
    if (isUntitledUri(uri)) {
      const file = this.untitledFiles.get(uri)
      if (file) file.isDirty = false
      return
    }
    const state = this.manager.folderStateForUri(uri)
    if (state) {
      state.clearDirtyState(uri)
      return
    }
    const file = this.externalFiles.get(canonicalizeFileUri(uri)) ?? this.externalFiles.get(uri)
    if (file) file.isDirty = false
  }

  async readFile(uri: string): Promise<string> {
    const state = this.manager.folderStateForUri(uri)
    if (state) return state.readFile(uri)
    return this.manager.readFile(uri)
  }

  async writeFile(uri: string, content: string): Promise<void> {
    if (isUntitledUri(uri)) {
      throw new Error("Cannot write untitled URI — promote before saving")
    }
    const state = this.manager.folderStateForUri(uri)
    if (!state) throw new Error(`No workspace folder contains ${uri}`)
    await state.writeFile(uri, content)
  }

  async reloadFileFromDisk(uri: string, opts?: { force?: boolean }): Promise<string | null> {
    return this.manager.folderStateForUri(uri)?.reloadFileFromDisk(uri, opts) ?? null
  }

  async handleExternalFileChange(uri: string): Promise<void> {
    await this.manager.folderStateForUri(uri)?.handleExternalFileChange(uri)
  }

  async readDir(uri: string) {
    return this.manager.readDir(uri)
  }

  createWorkspaceFile(uri: string, path: string): WorkspaceFile {
    const canonical = canonicalizeFileUri(uri)
    const state = this.manager.folderStateForUri(canonical) ?? this.manager.folderStateForUri(uri)
    if (state) {
      return state.createWorkspaceFile(canonical, path, languageIdFromPath(path))
    }
    const existing = this.externalFiles.get(canonical) ?? this.externalFiles.get(uri)
    if (existing) return existing
    const file: WorkspaceFile = {
      uri: canonical,
      path,
      name: basename(path),
      languageId: languageIdFromPath(path),
      isDirty: false,
    }
    this.externalFiles.set(canonical, file)
    this.onDidOpenFile.fire(file)
    return file
  }

  registerTab(tab: TabDescriptor, listDoc?: ListDocument): void {
    this.tabRegistry.register(tab)
    if (listDoc && !this.listStore.get(listDoc.id)) {
      this.listStore.create(listDoc)
    }
  }

  disposeTab(tabId: string): void {
    const kind = this.tabRegistry.kindFor(tabId)
    this.tabRegistry.dispose(tabId)
    if (kind && LIST_TAB_KINDS.has(kind)) {
      this.listStore.dispose(tabId)
    }
  }

  openTabInPanel(
    tree: YaadePanelTree,
    panelId: PanelId,
    tab: TabDescriptor,
    listDoc?: ListDocument,
    opts?: { replaceTabId?: string },
  ): string {
    this.registerTab(tab, listDoc)
    if (tab.kind === "editor") {
      const path = isUntitledUri(tab.id) ? "" : fileUriToPath(tab.id)
      const file =
        this.fileForUri(tab.id) ??
        (isUntitledUri(tab.id)
          ? this.registerUntitledFile(tab.id, tab.label)
          : this.createWorkspaceFile(tab.id, path))
      this.touchBuffer(tab.id)
      this.onDidOpenFile.fire(file)
    }
    const current = tree.getView(panelId)
    tree.setView(panelId, pushPanelTab(current, tab.id, opts?.replaceTabId))
    return tab.id
  }

  private registerUntitledFile(uri: string, label: string): WorkspaceFile {
    const file: WorkspaceFile = {
      uri,
      path: "",
      name: label,
      languageId: "plaintext",
      isDirty: false,
    }
    this.untitledFiles.set(uri, file)
    return file
  }

  focusTabInPanel(tree: YaadePanelTree, panelId: PanelId, tabId: string): void {
    const view = tree.getView(panelId)
    if (view?.kind !== "tabs") return
    tree.setView(panelId, activatePanelTab(view, tabId))
  }

  openOrFocusTab(
    tree: YaadePanelTree,
    panelId: PanelId,
    tab: TabDescriptor,
    listDoc?: ListDocument,
  ): { panelId: PanelId; tabId: string } {
    const existingPanel = findPanelWithTab(tree, tab.id)
    if (existingPanel) {
      this.registerTab(tab, listDoc)
      this.focusTabInPanel(tree, existingPanel, tab.id)
      return { panelId: existingPanel, tabId: tab.id }
    }
    const tabId = this.openTabInPanel(tree, panelId, tab, listDoc)
    return { panelId, tabId }
  }

  closeTabInPanel(tree: YaadePanelTree, panelId: PanelId, tabId: string): void {
    const view = tree.getView(panelId)
    if (view?.kind !== "tabs") return
    tree.setView(panelId, popPanelTab(view, tabId))
  }

  assignEditorPanel(
    tree: YaadePanelTree,
    panelId: PanelId,
    uri: string,
    path: string,
    opts?: { replaceUri?: string },
  ): void {
    let file = this.fileForUri(uri)
    if (!file) file = this.createWorkspaceFile(uri, path)
    const current = tree.getView(panelId)
    if (current?.kind === "tabs") {
      const existingTabId = panelTabIds(current).find(id => fileUriToPath(id) === fileUriToPath(uri))
      if (existingTabId) {
        this.registerTab({ id: existingTabId, kind: "editor", label: file.name })
        this.touchBuffer(existingTabId)
        tree.setView(panelId, activatePanelTab(current, existingTabId))
        return
      }
    }
    this.openTabInPanel(
      tree,
      panelId,
      { id: uri, kind: "editor", label: file.name },
      undefined,
      { replaceTabId: opts?.replaceUri },
    )
  }

  popPanelBuffer(tree: YaadePanelTree, panelId: PanelId, uri: string): void {
    const view = tree.getView(panelId)
    if (view?.kind !== "tabs") return
    const tabId =
      panelTabIds(view).find(id => fileUriToPath(id) === fileUriToPath(uri)) ?? uri
    this.closeTabInPanel(tree, panelId, tabId)
  }

  openUntitledInPanel(
    tree: YaadePanelTree,
    panelId: PanelId,
    opts?: { label?: string; languageId?: string },
  ): string {
    const n = this.untitledCounter++
    const uri = makeUntitledUri(n)
    const label = opts?.label ?? `Untitled-${n}`
    const languageId = opts?.languageId ?? (opts?.label ? languageIdFromPath(opts.label) : "plaintext")
    const file: WorkspaceFile = {
      uri,
      path: "",
      name: label,
      languageId,
      isDirty: false,
    }
    this.untitledFiles.set(uri, file)
    this.openTabInPanel(tree, panelId, { id: uri, kind: "editor", label })
    return uri
  }

  promoteUntitled(oldUri: string, fileUri: string, path: string): void {
    const file = this.untitledFiles.get(oldUri)
    if (!file) return
    this.untitledFiles.delete(oldUri)
    const promoted = this.createWorkspaceFile(fileUri, path)
    const idx = this.openBuffers.indexOf(oldUri)
    if (idx >= 0) this.openBuffers[idx] = fileUri
    else this.touchBuffer(fileUri)
    this.tabRegistry.dispose(oldUri)
    this.tabRegistry.register({ id: fileUri, kind: "editor", label: promoted.name })
    this.onDidChangeBuffers.fire()
  }

  showPanelView(tree: YaadePanelTree, panelId: PanelId, view: PanelView): void {
    tree.setView(panelId, view)
  }

  explorerTab(): TabDescriptor {
    return { id: EXPLORER_TAB_ID, kind: "explorer", label: "Explorer" }
  }

  outputTab(): TabDescriptor {
    return { id: OUTPUT_TAB_ID, kind: "output", label: "Output" }
  }

  ensureProblemsList(): ListDocument {
    const id = PROBLEMS_TAB_ID
    const existing = this.listStore.get(id)
    if (existing) return existing
    const doc: ListDocument = {
      id,
      title: "Problems",
      feed: "problems",
      items: [],
    }
    this.listStore.create(doc)
    this.tabRegistry.register({ id, kind: "problems", label: "Problems" })
    return doc
  }

  createSearchList(): ListDocument {
    const id = allocListId()
    const doc: ListDocument = {
      id,
      title: "Search",
      feed: "search",
      items: [],
      searchQuery: "",
      searchCaseSensitive: false,
      searchRegex: false,
      searchFuzzy: false,
      searchLoading: false,
      searchError: null,
    }
    this.listStore.create(doc)
    this.tabRegistry.register({ id, kind: "search", label: "Search" })
    return doc
  }

  createReferencesList(title: string, items: ListDocument["items"]): ListDocument {
    const id = allocListId()
    const doc: ListDocument = { id, title, feed: "references", items }
    this.listStore.create(doc)
    this.tabRegistry.register({ id, kind: "references", label: title })
    return doc
  }

  createDefinitionsList(title: string, items: ListDocument["items"]): ListDocument {
    const id = allocListId()
    const doc: ListDocument = { id, title, feed: "definitions", items }
    this.listStore.create(doc)
    this.tabRegistry.register({ id, kind: "definitions", label: title })
    return doc
  }

  createTaskErrorsList(
    title: string,
    items: ListDocument["items"],
    taskLabel: string,
    taskStatus: ListDocument["taskStatus"],
  ): ListDocument {
    const id = allocListId()
    const doc: ListDocument = {
      id,
      title,
      feed: "task-errors",
      items,
      taskLabel,
      taskStatus,
    }
    this.listStore.create(doc)
    this.tabRegistry.register({ id, kind: "task-errors", label: title })
    return doc
  }

  panelHasExplorerTab(tree: YaadePanelTree, panel: PanelId): boolean {
    return panelHasTab(tree.getView(panel), EXPLORER_TAB_ID)
  }

  mountExplorerTab(tree: YaadePanelTree, panelId: PanelId): void {
    this.openTabInPanel(tree, panelId, this.explorerTab())
  }
}

export { EXPLORER_TAB_ID, OUTPUT_TAB_ID, PROBLEMS_TAB_ID }
export type { TabDescriptor, TabKind, KnownTabKind }
