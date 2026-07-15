import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@workspace/db/schema";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

async function main() {
  const [alice] = await db.insert(schema.usersTable).values({
    phoneNumber: "+14155550101",
    displayName: "Alice Chen",
    onboardingStatus: "completed",
  }).returning();
  const [ben] = await db.insert(schema.usersTable).values({
    phoneNumber: "+14155550102",
    displayName: "Ben Torres",
    onboardingStatus: "completed",
  }).returning();
  const [dana] = await db.insert(schema.usersTable).values({
    phoneNumber: "+14155550103",
    displayName: "Dana Whitfield",
    onboardingStatus: "in_progress",
  }).returning();
  const [omar] = await db.insert(schema.usersTable).values({
    phoneNumber: "+14155550104",
    displayName: null,
    onboardingStatus: "not_started",
  }).returning();

  await db.insert(schema.profilesTable).values([
    {
      userId: alice.id,
      budget: "$$ (mid-range)",
      dietaryNeeds: "Vegetarian",
      preferences: ["Italian", "quiet spots", "outdoor seating"],
      pastChoices: ["Flour + Water", "Rich Table"],
      notes: "Prefers reservations after 7pm.",
    },
    {
      userId: ben.id,
      budget: "$$$ (upscale)",
      dietaryNeeds: null,
      preferences: ["Steakhouses", "cocktail bars"],
      pastChoices: ["House of Prime Rib"],
      notes: null,
    },
    {
      userId: dana.id,
      budget: "$ (casual)",
      dietaryNeeds: "Gluten-free",
      preferences: ["Brunch", "coffee shops"],
      pastChoices: [],
      notes: "Still onboarding -- confirm allergy list next chat.",
    },
  ]);

  const [directThread] = await db.insert(schema.threadsTable).values({
    primaryPhoneNumber: alice.phoneNumber,
    isGroup: false,
    title: null,
  }).returning();

  const [groupThread] = await db.insert(schema.threadsTable).values({
    sendblueGroupId: "grp_dinner_crew",
    isGroup: true,
    title: "Friday Dinner Crew",
  }).returning();

  await db.insert(schema.threadParticipantsTable).values([
    { threadId: directThread.id, userId: alice.id, role: "member" },
    { threadId: groupThread.id, userId: alice.id, role: "organizer" },
    { threadId: groupThread.id, userId: ben.id, role: "member" },
    { threadId: groupThread.id, userId: dana.id, role: "member" },
  ]);

  await db.insert(schema.messagesTable).values([
    { threadId: directThread.id, userId: alice.id, direction: "inbound", role: "user", content: "Can you book us a table for Friday at 7:30?" },
    { threadId: directThread.id, userId: null, direction: "outbound", role: "assistant", content: "On it! Checking a few spots that match your vegetarian preference near you." },
    { threadId: directThread.id, userId: null, direction: "outbound", role: "assistant", content: "Found a table for 2 at Rich Table, Friday 7:30pm. Want me to confirm?" },
    { threadId: directThread.id, userId: alice.id, direction: "inbound", role: "user", content: "Yes please, confirm it." },
  ]);

  await db.insert(schema.messagesTable).values([
    { threadId: groupThread.id, userId: alice.id, direction: "inbound", role: "user", content: "Where should we eat Friday?" },
    { threadId: groupThread.id, userId: null, direction: "outbound", role: "assistant", content: "I put together a quick poll -- vote below!" },
    { threadId: groupThread.id, userId: null, direction: "outbound", role: "system", content: "Poll created: \"Where should we eat Friday?\"" },
    { threadId: groupThread.id, userId: ben.id, direction: "inbound", role: "user", content: "Steakhouse please" },
    { threadId: groupThread.id, userId: dana.id, direction: "inbound", role: "user", content: "I'm in for ramen" },
  ]);

  const [poll] = await db.insert(schema.pollsTable).values({
    threadId: groupThread.id,
    question: "Where should we eat Friday?",
    status: "open",
  }).returning();

  const [optRamen, optSteak, optTacos] = await db.insert(schema.pollOptionsTable).values([
    { pollId: poll.id, label: "Ramen bar", position: 0 },
    { pollId: poll.id, label: "Steakhouse", position: 1 },
    { pollId: poll.id, label: "Taco truck pop-up", position: 2 },
  ]).returning();

  await db.insert(schema.pollVotesTable).values([
    { pollId: poll.id, optionId: optRamen.id, userId: dana.id },
    { pollId: poll.id, optionId: optSteak.id, userId: ben.id },
    { pollId: poll.id, optionId: optRamen.id, userId: alice.id },
  ]);

  await db.insert(schema.bookingsTable).values([
    {
      threadId: directThread.id,
      createdByUserId: alice.id,
      approverUserId: alice.id,
      title: "Rich Table -- Friday 7:30pm, party of 2",
      details: { venue: "Rich Table", date: "2026-07-17", time: "19:30", partySize: 2, notes: "Vegetarian menu requested" },
      status: "pending_approval",
    },
    {
      threadId: groupThread.id,
      createdByUserId: ben.id,
      approverUserId: alice.id,
      title: "House of Prime Rib -- Saturday 8pm, party of 6",
      details: { venue: "House of Prime Rib", date: "2026-07-18", time: "20:00", partySize: 6 },
      status: "pending_approval",
    },
    {
      threadId: directThread.id,
      createdByUserId: alice.id,
      approverUserId: alice.id,
      approverPhoneNumber: alice.phoneNumber,
      title: "Flour + Water -- Tuesday 6:45pm, party of 2",
      details: { venue: "Flour + Water", date: "2026-07-14", time: "18:45", partySize: 2 },
      status: "confirmed",
      provider: "opentable",
      providerBookingId: "OT-88213",
      decidedAt: new Date("2026-07-13T20:00:00Z"),
    },
    {
      threadId: groupThread.id,
      createdByUserId: dana.id,
      approverUserId: alice.id,
      title: "Late-night karaoke bus rental",
      details: { venue: "SF Party Bus Co.", date: "2026-07-19", time: "23:00", partySize: 10, notes: "Over budget for the group" },
      status: "rejected",
      decidedAt: new Date("2026-07-12T15:00:00Z"),
    },
  ]);

  console.log("Seed complete.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
