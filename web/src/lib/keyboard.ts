// Keyboard-first review: single-letter commands are live by default and the
// choice is persisted. The help overlay (?), the mode toggle (-), and the
// command palette (Cmd/Ctrl+K) are always available, even when single-letter
// commands are switched off, so a user can always discover how to re-enable
// them. Pure helpers here are unit-tested; App.tsx wires them to the UI.

export const KEYBOARD_MODE_STORAGE_KEY = "local-diffe:keyboard-mode"

export function preferredKeyboardMode(): boolean {
  try {
    return localStorage.getItem(KEYBOARD_MODE_STORAGE_KEY) !== "off"
  } catch {
    return true
  }
}

export function rememberKeyboardMode(enabled: boolean) {
  try {
    localStorage.setItem(KEYBOARD_MODE_STORAGE_KEY, enabled ? "on" : "off")
  } catch {
    // Keyboard shortcuts keep working in memory when storage is unavailable.
  }
}

// Every single-letter command, in help-overlay order. `when` explains the
// context that changes the meaning (e.g. J/K scroll in the diff region).
export const KEYBOARD_COMMANDS = [
  { key: "j", label: "Next", detail: "Next file, or scroll the diff when it is focused" },
  { key: "k", label: "Previous", detail: "Previous file, or scroll the diff when it is focused" },
  { key: "n", label: "Next unviewed", detail: "Jump to the next file not marked viewed" },
  { key: "m", label: "Mark viewed", detail: "Toggle the viewed mark on the selected file" },
  { key: "u", label: "Undo viewed", detail: "Remove the viewed mark from the selected file" },
  { key: "f", label: "Files", detail: "Focus the changed-file sidebar" },
  { key: "d", label: "Diff panel", detail: "Focus the diff panel" },
  { key: "v", label: "Toggle overview", detail: "Switch between minimal review and full controls" },
  { key: "e", label: "Toggle sidebar", detail: "Open or close the sidebar in minimal view" },
  {
    key: "[",
    label: "Previous commit",
    detail: "Step to the previous commit (first exits to all changes)",
  },
  { key: "]", label: "Next commit", detail: "Step to the next commit" },
  { key: "{", label: "Previous stacked PR", detail: "Step to the PR below in the stack" },
  { key: "}", label: "Next stacked PR", detail: "Step to the PR above in the stack" },
  { key: "/", label: "Filter files", detail: "Focus the file filter in the sidebar" },
  { key: "t", label: "Toggle diff mode", detail: "Switch between Semantic and Text diff" },
  {
    key: "x",
    label: "Expand / collapse folders",
    detail: "Expand all file-tree folders, or collapse them all",
  },
  { key: "o", label: "Open on GitHub", detail: "Open the current pull request in a new tab" },
] as const

export type KeyboardCommandKey = (typeof KEYBOARD_COMMANDS)[number]["key"]

export const OVERLAY_KEYS: readonly string[] = KEYBOARD_COMMANDS.map((command) => command.key)

// The command palette chord: Cmd+K on macOS, Ctrl+K elsewhere. It is a
// chord, not a single-letter command, so it works in either keyboard mode.
export function isPaletteShortcut(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k"
}

// Normalize a raw KeyboardEvent.key into a command key, or null when the
// press must not be treated as a command: modifier chords (Cmd/Ctrl/Alt+…
// belong to the browser or the palette), bare modifier keys, and multi-char
// keys (Enter, arrows, …) which keep their native meaning.
export function commandKeyFor(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  if (event.key.length !== 1 || event.key.trim() === "") return null
  return event.key.toLowerCase()
}

// `x` toggles the file tree: collapse only when everything is already open.
export function nextTreeExpanded(allExpanded: boolean): boolean {
  return !allExpanded
}
