import { beforeAll } from "vitest";
beforeAll(() => {
  if (!process.env["DATABASE_URL"] && !process.env["TEST_DATABASE_URL"]) {
    console.warn("\n[integration] No DATABASE_URL — integration tests skipped.\n");
    process.exit(0);
  }
  if (process.env["TEST_DATABASE_URL"]) process.env["DATABASE_URL"] = process.env["TEST_DATABASE_URL"];
});
