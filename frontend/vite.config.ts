/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    /**
     * SPEC 9 — the app shell is cached so it starts with no network at all.
     *
     * Without this the app still needed one online load, which is the one
     * moment it cannot ask for: a phone that has never opened the app in signal
     * is a phone in a livestock building with nothing on it.
     *
     * `globPatterns` deliberately includes the fonts. They are bundled rather
     * than fetched from Google (SPEC 9), and a precache that skipped them would
     * leave the first offline start rendering in a fallback face.
     */
    VitePWA({
      registerType: "prompt",
      manifest: false, // public/manifest.webmanifest is the source of truth.
      workbox: {
        globPatterns: ["**/*.{js,css,html,woff,woff2,png,svg,webmanifest}"],
        // The whole app is one bundle plus fonts; the default 2 MiB cap would
        // silently drop the largest of them from the precache.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Any navigation resolves to the shell, so a deep link opened offline
        // lands on the app rather than on the browser's error page.
        navigateFallback: "/index.html",
        // The API is never cached. A stale sync response is worse than no
        // response: the app is built to work from its own database offline.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  preview: {
    /**
     * Deploy only. Railway serves the built app with `vite preview`, and Vite 6
     * answers 403 to any Host header it was not told about. The platform hands
     * out a generated `*.up.railway.app` name, so there is no host to hardcode.
     * This server only ever returns the contents of `dist/`, which is public by
     * definition — there is nothing behind the check worth protecting.
     */
    allowedHosts: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Dev only. In production the app is served from the same origin as the
      // API, so no proxying and no cross-origin requests.
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
