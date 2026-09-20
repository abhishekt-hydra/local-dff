import { parseDiff } from "./lib/diff"

self.onmessage = (event: MessageEvent<string>) => {
  try {
    self.postMessage({ result: parseDiff(event.data) })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "Could not parse diff." })
  }
}
