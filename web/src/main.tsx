import { Profiler, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import { PERFORMANCE_BUILD_ENABLED, onRender } from "./lib/performance"
import "./index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {PERFORMANCE_BUILD_ENABLED ? <Profiler id="App" onRender={onRender}><App /></Profiler> : <App />}
  </StrictMode>,
)
