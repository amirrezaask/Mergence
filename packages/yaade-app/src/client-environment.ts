const TAURI_APP_HOSTNAME = "tauri.localhost"
const LOCAL_HOST_URL = "http://127.0.0.1:4747"

type ClientLocation = Pick<Location, "hostname" | "origin" | "protocol">

export function isDesktopClient(location: ClientLocation): boolean {
  return location.protocol === "tauri:" || location.hostname === TAURI_APP_HOSTNAME
}

export function resolveCurrentHostUrl(location: ClientLocation): string {
  if (isDesktopClient(location)) {
    return LOCAL_HOST_URL
  }
  return location.origin
}
