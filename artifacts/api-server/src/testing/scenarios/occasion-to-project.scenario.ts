import { scenario } from "../scenarioRunner"; import { seedUser, seedDirectThread, cleanupSeededData } from "../seed";
scenario({ name: "occasion-to-project", async seed() { const alice = await seedUser("Alice", "+15550007001"); const bot = await seedUser("Concierge", "+15550000007"); const t = await seedDirectThread(alice, bot); return { threadId: t.id, users: { alice, bot }, cleanup: () => cleanupSeededData({ userIds: [alice.id, bot.id], threadIds: [t.id] }) }; }, turns: [
  { from: "alice", text: "Yes let's plan something for Jake's birthday!", expect: [{ regex: /jake|birthday|plan|when|idea/i }] },
]});
