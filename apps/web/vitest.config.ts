import { defineConfig } from "vitest/config";

// Next keeps JSX for its compiler; Vitest needs a JSX transform for component tests.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
});
