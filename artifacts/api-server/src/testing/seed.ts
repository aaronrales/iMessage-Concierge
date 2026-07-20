import { db, usersTable, threadsTable, threadParticipantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

let _phone = 9_000_000_000;
export function nextTestPhone() { return "+1" + String(++_phone); }

export interface SeededUser { id: number; phoneNumber: string; displayName: string; }
export interface SeededThread { id: number; isGroup: boolean; }

export async function seedUser(displayName: string, phone?: string): Promise<SeededUser> {
  const phoneNumber = phone ?? nextTestPhone();
  const [user] = await db.insert(usersTable).values({ phoneNumber, displayName, onboardingStatus: "completed" }).returning();
  return { id: user!.id, phoneNumber, displayName };
}

export async function seedDirectThread(a: SeededUser, b: SeededUser): Promise<SeededThread> {
  const [t] = await db.insert(threadsTable).values({ isGroup: false, primaryPhoneNumber: a.phoneNumber }).returning();
  await db.insert(threadParticipantsTable).values([{ threadId: t!.id, userId: a.id, role: "user" }, { threadId: t!.id, userId: b.id, role: "user" }]);
  return { id: t!.id, isGroup: false };
}

export async function seedGroupThread(members: SeededUser[], title?: string): Promise<SeededThread> {
  const [t] = await db.insert(threadsTable).values({ isGroup: true, title: title ?? "Test Group", primaryPhoneNumber: members[0]!.phoneNumber }).returning();
  for (const m of members) await db.insert(threadParticipantsTable).values({ threadId: t!.id, userId: m.id, role: "user" });
  return { id: t!.id, isGroup: true };
}

export async function cleanupSeededData(ids: { userIds?: number[]; threadIds?: number[] }): Promise<void> {
  for (const tid of ids.threadIds ?? []) {
    await db.delete(threadParticipantsTable).where(eq(threadParticipantsTable.threadId, tid));
    await db.delete(threadsTable).where(eq(threadsTable.id, tid));
  }
  for (const uid of ids.userIds ?? []) await db.delete(usersTable).where(eq(usersTable.id, uid));
}
