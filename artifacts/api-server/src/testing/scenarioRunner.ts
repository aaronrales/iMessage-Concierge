import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { runEmulatorTurn } from "../lib/agent/runEmulatorTurn";
import { advanceClock, setTestClock } from "../lib/agent/clock";

export interface ScenarioUser { id: number; phoneNumber: string; displayName: string; }
export interface SeedResult { threadId: number; users: Record<string, ScenarioUser>; cleanup: () => Promise<void>; }
export interface TurnAssertion {
  contains?: string; notContains?: string; regex?: RegExp;
  sentToThread?: (primaryThread: number, users: Record<string, ScenarioUser>) => number;
  dbExpect?: (args: { threadId: number; users: Record<string, ScenarioUser> }) => Promise<void>;
  advanceClockMs?: number;
}
export interface ScenarioTurn { from: string; text: string; expect?: TurnAssertion[]; }
export interface ScenarioFixture { name: string; seed: () => Promise<SeedResult>; turns: ScenarioTurn[]; }

export function scenario(fixture: ScenarioFixture): void {
  describe("Scenario: " + fixture.name, () => {
    let seed: SeedResult;
    beforeAll(async () => { seed = await fixture.seed(); });
    afterAll(async () => { setTestClock(); await seed.cleanup(); });
    for (let i = 0; i < fixture.turns.length; i++) {
      const turn = fixture.turns[i]!;
      it("Turn " + (i + 1) + ": " + turn.from + " -> \"" + turn.text.slice(0, 50) + "\"", async () => {
        const sender = seed.users[turn.from];
        if (!sender) throw new Error("Unknown user '" + turn.from + "'");
        const result = await runEmulatorTurn(seed.threadId, sender.phoneNumber, turn.text);
        const body = result.messages.map((m) => m.content).join("\n").toLowerCase();
        for (const a of turn.expect ?? []) {
          if (a.contains) expect(body, 'should contain "' + a.contains + '"').toContain(a.contains.toLowerCase());
          if (a.notContains) expect(body, 'should NOT contain "' + a.notContains + '"').not.toContain(a.notContains.toLowerCase());
          if (a.regex) expect(result.messages.map((m) => m.content).join("\n")).toMatch(a.regex);
          if (a.sentToThread) { const tid = a.sentToThread(seed.threadId, seed.users); expect(result.messages.some((m) => m.threadId === tid)).toBe(true); }
          if (a.dbExpect) await a.dbExpect({ threadId: seed.threadId, users: seed.users });
          if (a.advanceClockMs) advanceClock(a.advanceClockMs);
        }
      });
    }
  });
}
