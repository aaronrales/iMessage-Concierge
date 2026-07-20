import { scenario } from "../scenarioRunner"; import { seedUser, seedGroupThread, cleanupSeededData } from "../seed";
scenario({ name: "organizer-tiebreak", async seed() { const alice = await seedUser("Alice Organizer", "+15550004001"); const bob = await seedUser("Bob", "+15550004002"); const carol = await seedUser("Carol", "+15550004003"); const t = await seedGroupThread([alice, bob, carol], "Trip Planning"); return { threadId: t.id, users: { alice, bob, carol }, cleanup: () => cleanupSeededData({ userIds: [alice.id, bob.id, carol.id], threadIds: [t.id] }) }; }, turns: [
  { from: "alice", text: "Should we go to Nashville or Austin?", expect: [{ regex: /poll|vote|nashville|austin/i }] },
]});
