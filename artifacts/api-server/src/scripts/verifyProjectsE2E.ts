/**
 * One-shot dev-DB verification for the projects layer (Task: project entity
 * above plans). Creates a throwaway group thread, exercises the real helpers
 * against the real database, prints PASS/FAIL per check, and leaves the data
 * in place for dashboard inspection (clean up with --cleanup <threadId>).
 *
 * Run: pnpm --filter @workspace/api-server exec tsx src/scripts/verifyProjectsE2E.ts
 */
import { db, plansTable, projectsTable, threadParticipantsTable, threadsTable, usersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  chooseActivePlanForReuse,
  createPlanInProject,
  getActivePlansForThread,
  getConfirmedPlansForWeatherCheck,
  getOrCreateActivePlan,
} from "../lib/agent/plans";
import { createProjectForThread, getActiveProject, getProjectChildPlans } from "../lib/agent/projects";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}${ok ? "" : ` :: ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

async function cleanup(threadId: number): Promise<void> {
  const users = await db
    .select({ userId: threadParticipantsTable.userId })
    .from(threadParticipantsTable)
    .where(eq(threadParticipantsTable.threadId, threadId));
  await db.delete(threadsTable).where(eq(threadsTable.id, threadId)); // cascades plans/projects/participants/messages
  const userIds = users.map((u) => u.userId);
  if (userIds.length > 0) {
    // Only remove the throwaway +1555000900x users this script created.
    const rows = await db.select().from(usersTable).where(inArray(usersTable.id, userIds));
    const testIds = rows.filter((r) => r.phoneNumber.startsWith("+1555000900")).map((r) => r.id);
    if (testIds.length > 0) await db.delete(usersTable).where(inArray(usersTable.id, testIds));
  }
  console.log(`Cleaned up thread ${threadId}`);
}

async function main(): Promise<void> {
  const cleanupArgIndex = process.argv.indexOf("--cleanup");
  if (cleanupArgIndex !== -1) {
    const threadId = Number(process.argv[cleanupArgIndex + 1]);
    if (!Number.isInteger(threadId)) throw new Error("--cleanup requires a thread id");
    await cleanup(threadId);
    return;
  }

  // ── Setup: throwaway group thread with 3 members ──────────────────────────
  const phones = ["+15550009001", "+15550009002", "+15550009003"];
  const users = [];
  for (const phone of phones) {
    const [user] = await db
      .insert(usersTable)
      .values({ phoneNumber: phone, displayName: phone === phones[0] ? "Maya" : phone === phones[1] ? "Sarah" : "Jess" })
      .onConflictDoUpdate({ target: usersTable.phoneNumber, set: { phoneNumber: phone } })
      .returning();
    users.push(user!);
  }
  const [thread] = await db
    .insert(threadsTable)
    .values({ isGroup: true, sendblueGroupId: `test_projects_e2e_${Date.now()}`, title: "Bach Test Crew" })
    .returning();
  if (!thread) throw new Error("thread insert failed");
  for (const user of users) {
    await db.insert(threadParticipantsTable).values({ threadId: thread.id, userId: user!.id, role: "member" });
  }
  console.log(`Test thread: ${thread.id}`);

  // ── 1. Standalone plan first (classic behavior) ───────────────────────────
  const standalone = await getOrCreateActivePlan(thread.id, "Dinner somewhere fun");
  check("standalone plan created with null projectId", standalone.projectId === null, standalone);
  const standaloneAgain = await getOrCreateActivePlan(thread.id, "Different title");
  check("standalone one-active rule: reuse, no duplicate", standaloneAgain.id === standalone.id, standaloneAgain);

  // ── 2. Project creation adopts the in-flight standalone plan ──────────────
  const { project, created } = await createProjectForThread({
    threadId: thread.id,
    type: "bachelorette",
    honoree: "Sarah",
    honoreeUserId: users[1]!.id,
    dateRangeStart: new Date("2026-09-04T00:00:00Z"),
    dateRangeEnd: new Date("2026-09-07T00:00:00Z"),
  });
  check("project created", created && project.type === "bachelorette", project);
  const activeProject = await getActiveProject(thread.id);
  check("getActiveProject resolves it", activeProject?.id === project.id, activeProject);
  const adopted = await getActivePlansForThread(thread.id);
  check("existing standalone plan adopted as first child", adopted.length === 1 && adopted[0]!.projectId === project.id, adopted);

  // ── 3. Reuse resolves to the project child now ─────────────────────────────
  const reused = await getOrCreateActivePlan(thread.id, "Ignored title");
  check("getOrCreateActivePlan reuses the child", reused.id === standalone.id && reused.projectId === project.id, reused);

  // ── 4. Multi-active coexistence inside the project ─────────────────────────
  const spaDay = await createPlanInProject(project.id, thread.id, "Spa day");
  const actives = await getActivePlansForThread(thread.id);
  check("two active plans coexist under the project", actives.length === 2 && actives.every((p) => p.projectId === project.id), actives);
  check("attendees anchored on new child plan", spaDay.attendeeUserIds.length === 3, spaDay);
  const children = await getProjectChildPlans(project.id);
  check("getProjectChildPlans returns both", children.length === 2, children);

  // ── 5. Idempotent re-create merges instead of duplicating ──────────────────
  const second = await createProjectForThread({
    threadId: thread.id,
    type: "trip",
    honoree: null,
    honoreeUserId: null,
    dateRangeStart: null,
    dateRangeEnd: null,
  });
  check("second create merges into existing project (no dup, type kept)", !second.created && second.project.id === project.id && second.project.type === "bachelorette", second);
  const allProjects = await db.select().from(projectsTable).where(eq(projectsTable.threadId, thread.id));
  check("exactly one project row for the thread", allProjects.length === 1, allProjects);

  // ── 6. Per-plan lifecycle scans see project children (weather rescue) ──────
  const tomorrow = new Date(Date.now() + 20 * 60 * 60 * 1000);
  await db.update(plansTable).set({ status: "confirmed", scheduledFor: tomorrow }).where(inArray(plansTable.id, [standalone.id, spaDay.id]));
  const weatherCandidates = await getConfirmedPlansForWeatherCheck(48 * 60 * 60 * 1000);
  const candidateIds = new Set(weatherCandidates.map((p) => p.id));
  check("weather-rescue scan picks up BOTH confirmed project children", candidateIds.has(standalone.id) && candidateIds.has(spaDay.id), weatherCandidates.length);

  // ── 7. Standalone regression on a separate 1:1 thread ──────────────────────
  const [dmThread] = await db
    .insert(threadsTable)
    .values({ isGroup: false, primaryPhoneNumber: "+15550009004" })
    .returning();
  const dmPlanA = await getOrCreateActivePlan(dmThread!.id, "Solo dinner");
  const dmPlanB = await getOrCreateActivePlan(dmThread!.id, "Another");
  check("no-project thread unchanged: one active plan, reused", dmPlanA.id === dmPlanB.id && dmPlanA.projectId === null, { dmPlanA, dmPlanB });
  await db.delete(threadsTable).where(eq(threadsTable.id, dmThread!.id));

  // ── 8. Pure chooser sanity against real rows ───────────────────────────────
  const chooserResult = chooseActivePlanForReuse(await getActivePlansForThread(thread.id), activeProject);
  check("chooser picks a child of the active project", chooserResult.plan?.projectId === project.id && !chooserResult.needsAdoption, chooserResult);

  console.log(failures === 0 ? `\nALL CHECKS PASSED — thread ${thread.id} left in place for dashboard inspection` : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
