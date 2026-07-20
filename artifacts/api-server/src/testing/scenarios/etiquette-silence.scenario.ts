import { scenario } from "../scenarioRunner"; import { seedUser, seedGroupThread, cleanupSeededData } from "../seed";
scenario({ name: "etiquette-silence", async seed() { const alice = await seedUser("Alice", "+15550002001"); const bob = await seedUser("Bob", "+15550002002"); const t = await seedGroupThread([alice, bob], "Weekend Chat"); return { threadId: t.id, users: { alice, bob }, cleanup: () => cleanupSeededData({ userIds: [alice.id, bob.id], threadIds: [t.id] }) }; }, turns: [
  { from: "alice", text: "lol did you see the game last night", expect: [] },
  { from: "bob", text: "omg yes insane ending!!", expect: [] },
]});
