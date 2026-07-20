import { scenario } from "../scenarioRunner"; import { seedUser, seedDirectThread, cleanupSeededData } from "../seed";
scenario({ name: "lake-como-trip", async seed() { const alice = await seedUser("Alice", "+15550001001"); const bot = await seedUser("Concierge", "+15550000001"); const t = await seedDirectThread(alice, bot); return { threadId: t.id, users: { alice, bot }, cleanup: () => cleanupSeededData({ userIds: [alice.id, bot.id], threadIds: [t.id] }) }; }, turns: [
  { from: "alice", text: "Hey I want to plan a trip to Lake Como for me and 4 friends next summer", expect: [{ contains: "lake como" }, { regex: /when|date|headcount|how many|budget/i }] },
  { from: "alice", text: "July 2027, 5 people, about $3000 each", expect: [{ notContains: "how many" }, { regex: /hotel|villa|stay|venue|activity|idea/i }] },
  { from: "alice", text: "Can you find some hotel options?", expect: [{ regex: /hotel|option|$|booking|per night/i }, { notContains: "sure, i'll look" }] },
]});
