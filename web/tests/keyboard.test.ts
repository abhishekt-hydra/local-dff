import assert from "node:assert/strict"
import { test } from "node:test"
import {
  KEYBOARD_COMMANDS,
  OVERLAY_KEYS,
  commandKeyFor,
  isPaletteShortcut,
  nextTreeExpanded,
} from "../src/lib/keyboard.ts"

const plain = (key: string) => ({ key, ctrlKey: false, metaKey: false, altKey: false })

test("single-letter commands include the original overlay keys and the new ones", () => {
  for (const key of ["e", "f", "d", "v", "j", "k", "[", "]", "{", "}", "n", "m"]) {
    assert.ok(OVERLAY_KEYS.includes(key), `missing original key ${key}`)
  }
  for (const key of ["/", "t", "u", "x", "o"]) {
    assert.ok(OVERLAY_KEYS.includes(key), `missing new key ${key}`)
  }
  assert.equal(new Set(OVERLAY_KEYS).size, OVERLAY_KEYS.length, "command keys must be unique")
  for (const command of KEYBOARD_COMMANDS) {
    assert.equal(command.key.length, 1)
    assert.ok(command.label.length > 0 && command.detail.length > 0)
  }
})

test("commandKeyFor normalizes letters and keeps punctuation commands", () => {
  assert.equal(commandKeyFor(plain("J")), "j")
  assert.equal(commandKeyFor(plain("m")), "m")
  assert.equal(commandKeyFor(plain("[")), "[")
  assert.equal(commandKeyFor(plain("{")), "{")
  assert.equal(commandKeyFor(plain("/")), "/")
  assert.equal(commandKeyFor(plain("-")), "-")
  assert.equal(commandKeyFor(plain("?")), "?")
})

test("commandKeyFor never hijacks browser chords or non-character keys", () => {
  assert.equal(commandKeyFor({ key: "k", ctrlKey: true, metaKey: false, altKey: false }), null)
  assert.equal(commandKeyFor({ key: "m", ctrlKey: false, metaKey: true, altKey: false }), null)
  assert.equal(commandKeyFor({ key: "j", ctrlKey: false, metaKey: false, altKey: true }), null)
  for (const key of ["Enter", "Escape", "ArrowDown", "Shift", "F5", " "]) {
    assert.equal(commandKeyFor(plain(key)), null, `${key} must keep its native meaning`)
  }
})

test("isPaletteShortcut accepts Cmd/Ctrl+K only", () => {
  assert.equal(isPaletteShortcut({ key: "k", ctrlKey: true, metaKey: false, altKey: false }), true)
  assert.equal(isPaletteShortcut({ key: "K", ctrlKey: false, metaKey: true, altKey: false }), true)
  assert.equal(isPaletteShortcut(plain("k")), false)
  assert.equal(isPaletteShortcut({ key: "k", ctrlKey: true, metaKey: false, altKey: true }), false)
  assert.equal(isPaletteShortcut({ key: "p", ctrlKey: true, metaKey: false, altKey: false }), false)
})

test("nextTreeExpanded toggles folder expansion", () => {
  assert.equal(nextTreeExpanded(true), false)
  assert.equal(nextTreeExpanded(false), true)
})
