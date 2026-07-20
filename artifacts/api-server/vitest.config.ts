import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/tests/**/*.test.ts"],
          exclude: ["src/tests/**/*.integration.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["src/tests/**/*.integration.test.ts", "src/testing/**/*.scenario.ts"],
          setupFiles: ["src/testing/integrationSetup.ts"],
        },
      },
    ],
  },
});
