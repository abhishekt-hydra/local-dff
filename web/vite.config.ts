import { fileURLToPath, URL } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { proxy: { "/api": "http://127.0.0.1:4317", "/semanticdiff-view": "http://127.0.0.1:4317", "/semanticdiff-assets": "http://127.0.0.1:4317" } },
  build: {
    rollupOptions: {
      preserveEntrySignatures: "strict",
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
      },
      output: {
        entryFileNames: "assets/[name]-[hash].js",
      },
    },
  },
})
