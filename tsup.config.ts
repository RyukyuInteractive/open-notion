import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["lib/index.ts", "lib/models.ts"],
  outDir: "build",
  format: ["esm"],
  clean: true,
  dts: true,
  splitting: false,
})
