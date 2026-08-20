import type {
  TextFileReadResult,
  TextFileWriteOptions,
  TextFileWriteResult,
} from "@yaade/rpc"
import { readHostAuthToken } from "./web-transport.js"

const TEXT_FILE_ROUTE = "/api/v1/fs/text-file"

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

type HttpRequestOptions = {
  signal?: AbortSignal
  fetcher?: FetchLike
  baseUrl?: string
  authToken?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export class TextFileHttpError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details: Record<string, unknown>,
  ) {
    super(message)
    this.name = "TextFileHttpError"
  }
}

async function responseError(response: Response): Promise<TextFileHttpError> {
  const body = await response.text()
  let decoded: unknown
  try {
    decoded = JSON.parse(body)
  } catch {
    decoded = undefined
  }
  const envelope = isRecord(decoded) && isRecord(decoded.error) ? decoded.error : undefined
  const code = typeof envelope?.code === "string" ? envelope.code : "OPERATION_FAILED"
  const message =
    typeof envelope?.message === "string"
      ? envelope.message
      : body || `text file request failed (${response.status})`
  const details = isRecord(envelope?.details) ? envelope.details : {}
  return new TextFileHttpError(message, code, response.status, details)
}

function resultHeaders(response: Response): TextFileWriteResult {
  const version = response.headers.get("x-yaade-file-version")
  const sizeHeader = response.headers.get("x-yaade-file-size")
  const size = sizeHeader === null ? Number.NaN : Number(sizeHeader)
  if (!version || !Number.isSafeInteger(size) || size < 0) {
    throw new TextFileHttpError(
      "invalid text file response headers",
      "INVALID_RESPONSE",
      response.status,
      {},
    )
  }
  return { version, size }
}

function requestUrl(uri: string, writeOptions?: TextFileWriteOptions): string {
  const params = new URLSearchParams({ uri })
  if (writeOptions) {
    const hasExpected =
      "expectedVersion" in writeOptions &&
      typeof writeOptions.expectedVersion === "string"
    const create = "create" in writeOptions && writeOptions.create === true
    if (hasExpected === create) {
      throw new Error("text file write requires exactly one of expectedVersion or create")
    }
    if (hasExpected) params.set("expectedVersion", writeOptions.expectedVersion)
    if (create) params.set("create", "1")
  }
  return `${TEXT_FILE_ROUTE}?${params}`
}

function authHeaders(
  authToken: string | null | undefined,
  extra?: Record<string, string>,
): Record<string, string> {
  const token = authToken === undefined ? readHostAuthToken() : authToken
  return {
    ...extra,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}

export async function readTextFileHttp(
  uri: string,
  options: HttpRequestOptions = {},
): Promise<TextFileReadResult> {
  const fetcher = options.fetcher ?? fetch
  const baseUrl = options.baseUrl ?? ""
  const response = await fetcher(`${baseUrl}${requestUrl(uri)}`, {
    signal: options.signal,
    headers: authHeaders(options.authToken),
  })
  if (!response.ok) throw await responseError(response)
  const metadata = resultHeaders(response)
  return {
    content: await response.text(),
    version: metadata.version,
    size: metadata.size,
  }
}

export async function writeTextFileHttp(
  uri: string,
  content: string,
  writeOptions: TextFileWriteOptions,
  options: HttpRequestOptions = {},
): Promise<TextFileWriteResult> {
  const fetcher = options.fetcher ?? fetch
  const baseUrl = options.baseUrl ?? ""
  const response = await fetcher(`${baseUrl}${requestUrl(uri, writeOptions)}`, {
    method: "PUT",
    headers: authHeaders(options.authToken, { "content-type": "text/plain; charset=utf-8" }),
    body: content,
    signal: options.signal,
  })
  if (!response.ok) throw await responseError(response)
  const result = resultHeaders(response)
  // A successful atomic write has an empty body, but fetch resolves once the
  // headers arrive. Drain it so navigation/close does not report the completed
  // PUT as net::ERR_ABORTED and so the connection is reusable.
  await response.arrayBuffer()
  return result
}
