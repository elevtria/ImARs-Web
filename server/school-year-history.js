import { appStore, supabaseWebData } from "./supabase-app-store.js";
import { requireStaff, readJson, stateCall } from "./web-auth.js";
import { confirmAdministratorPassword } from "./admin-security.js";
import { loadAdminReports } from "./admin-report-data.js";
import { decodeFields } from "./firestore-admin.js";
import { invalidateSchoolYearCache } from "./web-data.js";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const metadata = "id,start_year,next_year,closed_at,closed_by,counts";
const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const number = value => Number.isFinite(value) && value >= 0 ? value : "";
const score = (data, prefix) => data[`is${prefix === "preTest" ? "Pre" : "Post"}TestCompleted`] === false ? "" : number(data[prefix + "Score"]);

export function archivedSchoolReport(archive) {
  const docs = new Map((archive.documents || []).map(row => [row.path, decodeFields(row.fields)]));
  const students = [...docs].filter(([path, data]) => /^users\/[^/]+$/.test(path) && data.role === "student");
  const columns = ["School year", "Record type", "Student ID", "Student name", "Section", "Teacher", "Term", "Lesson / quiz", "Pre-test score", "Pre-test total", "Post-test score", "Post-test total", "Activity score", "Activity total", "Quiz score", "Quiz total", "AR minutes", "Module minutes", "Status"];
  const rows = [], label = `${archive.start_year}–${archive.start_year + 1}`;
  const base = (id, data, kind) => {
    const section = docs.get("classes/" + data.classCode) || {};
    const teacher = docs.get("users/" + (section.teacherId || data.teacherId)) || {};
    return [label, kind, id, data.displayName || data.fullName || data.name || [data.firstName, data.middleName, data.lastName].filter(Boolean).join(" "),
      section.SectionName || section.sectionName || data.section || "", teacher.fullName || teacher.displayName || teacher.name || ""];
  };
  for (const [path, student] of students) {
    const id = path.split("/")[1];
    rows.push([...base(id, student, "Roster"), "", "", "", "", "", "", "", "", "", "", "", "", student.active === false ? "Archived / inactive" : "Active at year close"]);
    for (const [resultPath, data] of docs) {
      if (!resultPath.startsWith(path + "/")) continue;
      const parts = resultPath.split("/");
      if (parts[2] === "test_results" && parts.length === 6) {
        const lesson = docs.get(`terms/${parts[3]}/lessons/${parts[5]}`) || {};
        rows.push([...base(id, student, "Lesson"), parts[3], lesson.title || lesson.name || parts[5], score(data, "preTest"), number(data.preTestTotalQuestions),
          score(data, "postTest"), number(data.postTestTotalQuestions), number(data.activityRawScore ?? data.activityScore), number(data.activityRawMaximum ?? data.activityTotalQuestions ?? data.activityTotalPoints),
          "", "", number(data.arTimeMinutes ?? data.arNavigationTimeMinutes), number(data.lessonTimeMinutes), "Recorded"]);
      } else if (parts[2] === "generated_quiz_attempts" && parts.length === 4) {
        const quiz = docs.get("generatedQuizzes/" + data.quizId) || {};
        const result = data.review || data.receipt || {};
        rows.push([...base(id, student, "Generated quiz"), quiz.termId || "", quiz.title || data.quizId || "", "", "", "", "", "", "",
          number(result.score), number(result.maximum), "", "", data.status || "Submitted"]);
      }
    }
    for (const run of archive.mobile_runs || []) {
      const data = run.item;
      if (!data || data.studentId !== id || run.uid !== student.uid) continue;
      rows.push([...base(id, student, "AR activity"), data.termId || "", data.title || data.activityId || "", "", "", "", "",
        number(data.rawScore ?? data.score), number(data.rawMaximum ?? data.maximum), "", "", "", "", data.status || ""]);
    }
  }
  return { startYear: archive.start_year, closedAt: archive.closed_at, columns, rows };
}

export async function schoolYearHistory({ request, env }, { store, authenticate = requireStaff, callState = stateCall } = {}) {
  try {
    if (request.method !== "POST") throw fail("Use POST.", 405);
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) throw fail("Use JSON.", 415);
    store ??= appStore(env);
    const actor = await authenticate(request, env, store);
    if (actor.role !== "admin") throw fail("Administrator access is required.", 403);
    if (!supabaseWebData(env) || typeof store.request !== "function") throw fail("School-year archives require the Supabase backend.", 503);
    const body = await readJson(request, 8192);
    if (!body || !["overview", "report", "close"].includes(body.action)) throw fail("Choose a school-year action.");
    if (body.action === "overview") {
      await store.begin();
      const [year, report, response] = await Promise.all([store.get("webSettings/schoolYear"), loadAdminReports(store),
        store.request("imars_school_year_archives", "GET", { dataset_id: "eq." + store.dataset, select: metadata, order: "start_year.desc", limit: "101" })]);
      const archives = await response.json();
      if (archives.length > 100) throw fail("Contact school support to access older archives.", 409);
      return json({ currentYear: year?.data.startYear ?? 2026, revision: store.revision, archives,
        counts: { students: report.totalStudents, teachers: report.teachers.length, sections: report.sectionDirectory.length,
          recordedTests: report.preCount + report.postCount }, storageReady: true });
    }
    if (body.action === "report") {
      if (!uuid(body.archiveId)) throw fail("Choose a saved school year.");
      const response = await store.request("imars_school_year_archives", "GET", { dataset_id: "eq." + store.dataset,
        id: "eq." + body.archiveId, select: "start_year,closed_at,documents,mobile_runs", limit: "1" });
      const [archive] = await response.json();
      if (!archive) throw fail("That school year was not found.", 404);
      return json(archivedSchoolReport(archive));
    }
    if (!Number.isInteger(body.startYear) || body.startYear < 2000 || body.startYear > 2099 || !uuid(body.revision) ||
        body.confirmation !== `CLOSE ${body.startYear}-${body.startYear + 1}`) throw fail("Review the year and type its exact confirmation phrase.");
    await confirmAdministratorPassword(env, store, actor, body.password, callState);
    const current = await authenticate(request, env, store);
    if (current.role !== "admin" || current.uid !== actor.uid) throw fail("Administrator access is required.", 403);
    const response = await store.request("rpc/imars_close_school_year", "POST", {}, {
      p_dataset: store.dataset, p_revision: body.revision, p_start_year: body.startYear, p_admin_id: actor.id
    });
    const result = await response.json();
    invalidateSchoolYearCache(store);
    try {
      const teachers = await store.query("users", { filters: [{ field: "role", op: "==", value: "teacher" }], fieldPaths: ["uid"] });
      await Promise.allSettled(teachers.filter(row => row.data.uid).map(row => callState(env, "dashboard:" + row.data.uid, "dashboard-dirty", { ids: ["_school_year_close"] })));
    } catch { console.warn("School-year archive committed; dashboard refresh will retry."); }
    return json({ ...result, message: `SY ${body.startYear}–${body.startYear + 1} was archived. Import a new student roster for SY ${body.startYear + 1}–${body.startYear + 2}.` });
  } catch (error) {
    const status = [400, 401, 403, 404, 405, 409, 413, 415, 429].includes(error.status) ? error.status : 503;
    return json({ error: status === 503 ? "School-year archives are not ready or could not be reached. The Supabase school-year migration must be installed before closing a year. No successful close has been confirmed; refresh the history before retrying." : error.message,
      code: status === 403 ? "permission-denied" : status === 401 ? "unauthenticated" : status === 409 ? "aborted" : "unavailable" }, status);
  }
}
