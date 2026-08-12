import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@kibo-cms-clone-tool/shared": path.resolve(__dirname, "src/shared/index.ts"),
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
