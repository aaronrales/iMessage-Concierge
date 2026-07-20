import { scenario } from "../scenarioRunner"; import { seedUser, seedGroupThread, cleanupSeededData } from "../seed";
scenario({ name: "project-closeout", async seed() { const alice = await seedUser("Alice Organizer", "+15550005001"); const t = await seedGroupThread([alice], "Past Trip"); return { threadId: t.id, users: { alice }, cleanup: () => cleanupSeededData({ userIds: [alice.id], threadIds: [t.id] }) }; }, turns: [
  { from: "alice", text: "close it out", expect: [{ regex: /wrap|done|close|settled|great/i }] },
]});
