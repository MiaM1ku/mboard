import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:8790",
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env.MBOARD_CHROMIUM || undefined,
      args: ["--no-sandbox"],
    },
    trace: "retain-on-failure",
  },
  reporter: [["list"]],
  webServer: {
    command:
      "MBOARD_PORT=8790 MBOARD_DATA_DIR=$(mktemp -d /tmp/mboard-e2e.XXXXXX) bun src/server/server.ts",
    url: "http://127.0.0.1:8790/api/v1/auth/status",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
