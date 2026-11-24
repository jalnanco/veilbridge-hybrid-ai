import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    outDir: "docs",
    sourcemap: false,
    target: "es2022",
  },
});
