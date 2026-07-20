import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const FIXTURES_DIR = join(__dirname, "fixtures");
const RECORD = process.env["SCENARIO_RECORD"] === "1";

export function cacheKey(scenario: string, input: unknown) { return createHash("sha256").update(JSON.stringify({scenario,input})).digest("hex").slice(0,16); }

export function getCached<T>(scenario: string, key: string): T | null {
  if (RECORD) return null;
  const p = join(FIXTURES_DIR, scenario, key + ".json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; }
}

export function saveResponse(scenario: string, key: string, val: unknown) {
  mkdirSync(join(FIXTURES_DIR, scenario), { recursive: true });
  writeFileSync(join(FIXTURES_DIR, scenario, key + ".json"), JSON.stringify(val, null, 2));
}

export const isRecordMode = () => RECORD;
