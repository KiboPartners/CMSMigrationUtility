import { defineConfig } from "vitest/config";
import path from "path";

// Resolve the workspace package to its TS source so tests run without a build.
export default defineConfig({
  resolve: {
    alias: {
      "@kibo-cms-clone-tool/shared": path.resolve(__dirname, "shared/src/index.ts"),
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
