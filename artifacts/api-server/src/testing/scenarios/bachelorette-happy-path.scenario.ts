import { scenario } from "../scenarioRunner"; import { seedUser, seedDirectThread, cleanupSeededData } from "../seed";
scenario({ name: "bachelorette-happy-path", async seed() { const alice = await seedUser("Alice", "+15550006001"); const bot = await seedUser("Concierge", "+15550000006"); const t = await seedDirectThread(alice, bot); return { threadId: t.id, users: { alice, bot }, cleanup: () => cleanupSeededData({ userIds: [alice.id, bot.id], threadIds: [t.id] }) }; }, turns: [
  { from: "alice", text: "I want to plan a bachelorette party for my friend Sarah next month in Nashville", expect: [{ regex: /sarah|party|bachelorette|plan/i }, { regex: /when|how many|guest|date/i }] },
  { from: "alice", text: "8 people, weekend of August 15th, $200 each", expect: [{ notContains: "how many" }, { regex: /nashville|bar|activity|venue|idea/i }] },
]});
