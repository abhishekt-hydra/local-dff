import { useSyncExternalStore } from "react"

const mobileLayout = window.matchMedia("(max-width: 1023px)")

function subscribe(onChange: () => void) {
  mobileLayout.addEventListener("change", onChange)
  return () => mobileLayout.removeEventListener("change", onChange)
}

export function useMobileLayout() {
  return useSyncExternalStore(subscribe, () => mobileLayout.matches)
}
