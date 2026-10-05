import { defineConfig } from "vitest/config";

// Tests run in a simulated browser DOM (happy-dom). They live in tests/, outside src/, so the
// build's type check and bundle never see them.
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["tests/**/*.test.ts"],
  },
});
