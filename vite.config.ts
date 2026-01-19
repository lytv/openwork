import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import comlink from "vite-plugin-comlink";

export default defineConfig({
  plugins: [solid(), comlink()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "esnext",
  },
  worker: {
    plugins: () => [comlink()],
  },
});
