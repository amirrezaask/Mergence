import * as React from "react"

function isCoarsePointer(): boolean {
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(isCoarsePointer)

  React.useEffect(() => {
    const mql = window.matchMedia("(hover: none) and (pointer: coarse)")
    const onChange = () => setIsMobile(mql.matches)
    mql.addEventListener("change", onChange)
    setIsMobile(mql.matches)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isMobile
}
