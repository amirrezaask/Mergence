import * as React from "react"

function isDesktopShell(): boolean {
  return /Electron/i.test(navigator.userAgent)
}

function isCoarsePointer(): boolean {
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(() => {
    if (isDesktopShell()) return false
    return isCoarsePointer()
  })

  React.useEffect(() => {
    if (isDesktopShell()) {
      setIsMobile(false)
      return
    }
    const mql = window.matchMedia("(hover: none) and (pointer: coarse)")
    const onChange = () => {
      setIsMobile(mql.matches)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(mql.matches)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isMobile
}
