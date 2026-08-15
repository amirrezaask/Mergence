import {
  Braces,
  Coffee,
  Database,
  File,
  FileCode,
  FileImage,
  FileJson,
  FileLock2,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  Folder,
  Hash,
  Package,
  Settings,
} from "lucide-react"
import type { ComponentType, SVGProps } from "react"
import { cn } from "@/lib/utils.js"

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

interface IconSpec {
  Icon: IconComponent
  className: string
}

const DEFAULT: IconSpec = { Icon: File, className: "text-muted-foreground" }
const FOLDER: IconSpec = { Icon: Folder, className: "text-sky-500" }

interface FileIconMap {
  [name: string]: IconSpec
}

const BY_NAME: FileIconMap = {
  "package.json": { Icon: Package, className: "text-red-500" },
  "package-lock.json": { Icon: FileLock2, className: "text-red-400" },
  "pnpm-lock.yaml": { Icon: FileLock2, className: "text-amber-500" },
  "pnpm-workspace.yaml": { Icon: Package, className: "text-amber-500" },
  "yarn.lock": { Icon: FileLock2, className: "text-sky-500" },
  "bun.lockb": { Icon: FileLock2, className: "text-pink-400" },
  "cargo.toml": { Icon: Package, className: "text-orange-600" },
  "cargo.lock": { Icon: FileLock2, className: "text-orange-500" },
  "go.mod": { Icon: Package, className: "text-cyan-500" },
  "go.sum": { Icon: FileLock2, className: "text-cyan-400" },
  "dockerfile": { Icon: Package, className: "text-blue-400" },
  "makefile": { Icon: Settings, className: "text-yellow-600" },
  ".gitignore": { Icon: FileText, className: "text-orange-500" },
  ".gitattributes": { Icon: FileText, className: "text-orange-500" },
  ".env": { Icon: Settings, className: "text-yellow-500" },
  "readme.md": { Icon: FileText, className: "text-sky-400" },
  "tsconfig.json": { Icon: Settings, className: "text-blue-500" },
  "vite.config.ts": { Icon: Settings, className: "text-purple-500" },
  "vite.config.js": { Icon: Settings, className: "text-purple-500" },
  "turbo.json": { Icon: Settings, className: "text-red-400" },
}

const BY_EXT: FileIconMap = {
  ts: { Icon: FileCode, className: "text-blue-500" },
  tsx: { Icon: FileCode, className: "text-blue-400" },
  js: { Icon: FileCode, className: "text-yellow-400" },
  jsx: { Icon: FileCode, className: "text-yellow-300" },
  mjs: { Icon: FileCode, className: "text-yellow-400" },
  cjs: { Icon: FileCode, className: "text-yellow-400" },
  json: { Icon: FileJson, className: "text-amber-500" },
  jsonc: { Icon: FileJson, className: "text-amber-500" },
  yaml: { Icon: Braces, className: "text-red-400" },
  yml: { Icon: Braces, className: "text-red-400" },
  toml: { Icon: Braces, className: "text-orange-500" },
  xml: { Icon: FileCode, className: "text-orange-400" },
  html: { Icon: FileCode, className: "text-orange-500" },
  htm: { Icon: FileCode, className: "text-orange-500" },
  css: { Icon: FileCode, className: "text-sky-400" },
  scss: { Icon: FileCode, className: "text-pink-400" },
  sass: { Icon: FileCode, className: "text-pink-400" },
  less: { Icon: FileCode, className: "text-indigo-400" },
  md: { Icon: FileText, className: "text-sky-400" },
  mdx: { Icon: FileText, className: "text-sky-500" },
  txt: { Icon: FileText, className: "text-muted-foreground" },
  rs: { Icon: FileCode, className: "text-orange-600" },
  go: { Icon: FileCode, className: "text-cyan-500" },
  py: { Icon: FileCode, className: "text-yellow-500" },
  rb: { Icon: FileCode, className: "text-red-500" },
  java: { Icon: Coffee, className: "text-amber-600" },
  kt: { Icon: FileCode, className: "text-purple-500" },
  swift: { Icon: FileCode, className: "text-orange-500" },
  c: { Icon: FileCode, className: "text-blue-500" },
  h: { Icon: FileCode, className: "text-blue-400" },
  cpp: { Icon: FileCode, className: "text-blue-500" },
  cc: { Icon: FileCode, className: "text-blue-500" },
  hpp: { Icon: FileCode, className: "text-blue-400" },
  cs: { Icon: Hash, className: "text-green-500" },
  php: { Icon: FileCode, className: "text-indigo-400" },
  lua: { Icon: FileCode, className: "text-blue-400" },
  vim: { Icon: FileCode, className: "text-green-500" },
  ex: { Icon: FileCode, className: "text-purple-500" },
  exs: { Icon: FileCode, className: "text-purple-500" },
  erl: { Icon: FileCode, className: "text-red-500" },
  hs: { Icon: FileCode, className: "text-purple-500" },
  clj: { Icon: FileCode, className: "text-green-500" },
  scala: { Icon: FileCode, className: "text-red-500" },
  dart: { Icon: FileCode, className: "text-cyan-400" },
  vue: { Icon: FileCode, className: "text-emerald-500" },
  svelte: { Icon: FileCode, className: "text-orange-500" },
  astro: { Icon: FileCode, className: "text-orange-400" },
  sh: { Icon: FileTerminal, className: "text-green-500" },
  bash: { Icon: FileTerminal, className: "text-green-500" },
  zsh: { Icon: FileTerminal, className: "text-green-500" },
  fish: { Icon: FileTerminal, className: "text-green-500" },
  ps1: { Icon: FileTerminal, className: "text-blue-400" },
  sql: { Icon: Database, className: "text-sky-400" },
  db: { Icon: Database, className: "text-sky-500" },
  sqlite: { Icon: Database, className: "text-sky-500" },
  png: { Icon: FileImage, className: "text-purple-400" },
  jpg: { Icon: FileImage, className: "text-purple-400" },
  jpeg: { Icon: FileImage, className: "text-purple-400" },
  gif: { Icon: FileImage, className: "text-purple-400" },
  svg: { Icon: FileImage, className: "text-emerald-400" },
  webp: { Icon: FileImage, className: "text-purple-400" },
  ico: { Icon: FileImage, className: "text-purple-400" },
  pdf: { Icon: FileText, className: "text-red-500" },
  csv: { Icon: FileSpreadsheet, className: "text-green-500" },
  tsv: { Icon: FileSpreadsheet, className: "text-green-500" },
  xls: { Icon: FileSpreadsheet, className: "text-green-600" },
  xlsx: { Icon: FileSpreadsheet, className: "text-green-600" },
  ttf: { Icon: FileType, className: "text-muted-foreground" },
  otf: { Icon: FileType, className: "text-muted-foreground" },
  woff: { Icon: FileType, className: "text-muted-foreground" },
  woff2: { Icon: FileType, className: "text-muted-foreground" },
  lock: { Icon: FileLock2, className: "text-muted-foreground" },
  log: { Icon: FileText, className: "text-muted-foreground" },
  env: { Icon: Settings, className: "text-yellow-500" },
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash >= 0 ? path.slice(slash + 1) : path
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return ""
  return name.slice(dot + 1).toLowerCase()
}

export function getFileIconSpec(pathOrName: string, isDirectory = false): IconSpec {
  if (isDirectory) return FOLDER
  const name = basename(pathOrName).toLowerCase()
  const byName = BY_NAME[name]
  if (byName) return byName
  const ext = extOf(name)
  return BY_EXT[ext] ?? DEFAULT
}

export interface FileIconProps {
  path: string
  isDirectory?: boolean
  className?: string
}

export function FileIcon({ path, isDirectory, className }: FileIconProps) {
  const { Icon, className: colorClass } = getFileIconSpec(path, isDirectory)
  return <Icon className={cn("size-3.5 shrink-0", colorClass, className)} />
}
