import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      PORTAL_TEST_MODE: "1",
      AUTH_SECRET: "test-secret-please-do-not-use-in-prod-0123456789",
      NODE_ENV: "test",
      PORTAL_PUBLIC_URL: "http://portal.test",
    },
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 120000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
});
