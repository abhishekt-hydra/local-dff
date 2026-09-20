import { fileURLToPath, URL } from "node:url"
import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL("..", import.meta.url)), "LOCAL_DIFFE_")
  const backend = `http://127.0.0.1:${env.LOCAL_DIFFE_PORT || "3333"}`
  const performanceOptIn = ["1", "true", "yes", "on"].includes((env.LOCAL_DIFFE_PERF || "").toLowerCase())
  const profilingBuild = mode === "profile" || performanceOptIn || ["1", "true", "yes", "on"].includes((env.LOCAL_DIFFE_PROFILE_BUILD || "").toLowerCase())
  return {
  plugins: [react(), tailwindcss()],
  worker: { format: "es" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // React 19 ships a production profiling entry. Keep it behind an
      // explicit profile/performance opt-in so regular production bundles stay lean.
      ...(profilingBuild ? { "react-dom/client": "react-dom/profiling" } : {}),
    },
  },
  define: {
    __LOCAL_DIFFE_PERF__: JSON.stringify(performanceOptIn),
    __LOCAL_DIFFE_PROFILE_BUILD__: JSON.stringify(profilingBuild),
  },
  server: { proxy: { "/api": backend, "/semanticdiff-view": backend, "/semanticdiff-assets": backend } },
  build: {
    outDir: profilingBuild ? "dist-profile" : "dist",
    sourcemap: profilingBuild,
    rollupOptions: {
      preserveEntrySignatures: "strict",
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        "semantic-viewer": fileURLToPath(new URL("./src/semantic-viewer.ts", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => chunk.name === "semantic-viewer" ? "assets/semantic-viewer.js" : "assets/[name]-[hash].js",
      },
    },
  },
  }
})
