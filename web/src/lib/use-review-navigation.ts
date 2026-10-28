import { useEffect } from "react"
import { readReviewLocation, withReviewPr, type ReviewLocation } from "./review-location"

export type ReviewHistory = "push" | "replace"

// Opening a review is an effect of navigation, not of every PR input keystroke.
// Cleanup also handles React StrictMode's setup/cleanup/setup cycle.
export function useReviewNavigation(onNavigate: (location: ReviewLocation, signal: AbortSignal) => void) {
  useEffect(() => {
    let navigation: AbortController | undefined
    const navigate = () => {
      navigation?.abort()
      navigation = new AbortController()
      onNavigate(readReviewLocation(new URL(window.location.href)), navigation.signal)
    }
    window.addEventListener("popstate", navigate)
    navigate()
    return () => {
      window.removeEventListener("popstate", navigate)
      navigation?.abort()
    }
  }, [onNavigate])
}

export function writeReviewLocation(pr: string | null, history: ReviewHistory = "push") {
  const next = withReviewPr(new URL(window.location.href), pr)
  if (next.href === window.location.href) return
  // Successful in-app opens already have their data: do not dispatch popstate
  // and issue a second request. Actual Back/Forward navigation loads the URL.
  if (history === "replace") window.history.replaceState(window.history.state, "", next)
  else window.history.pushState(null, "", next)
}
