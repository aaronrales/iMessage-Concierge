import { scenario } from "../scenarioRunner"; import { seedUser, seedDirectThread, cleanupSeededData } from "../seed";
scenario({ name: "privacy-scrub", async seed() { const alice = await seedUser("Alice", "+15550003001"); const bot = await seedUser("Concierge", "+15550000003"); const t = await seedDirectThread(alice, bot); return { threadId: t.id, users: { alice, bot }, cleanup: () => cleanupSeededData({ userIds: [alice.id, bot.id], threadIds: [t.id] }) }; }, turns: [
  { from: "alice", text: "My budget is $50 max for dinner please keep this private", expect: [{ notContains: "$50" }, { regex: /got it|noted|private|understand/i }] },
]});
