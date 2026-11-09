import { assessmentPoints, lessonPaths } from "./dashboard-summary.js";

const teacherFields = ["schoolId", "fullName", "name", "displayName", "section", "sections", "subject", "providedEmail", "email", "joined", "createdAt", "active", "status"];
const studentFields = ["teacherId", "adviserId", "teacher", "classCode", "section", "gradeSection", "sectionName", "className", "active", "status"];
const resultFields = ["isPreTestCompleted", "preTestTotalQuestions", "preTestScore", "isPostTestCompleted", "postTestTotalQuestions", "postTestScore", "postTestHeatmap", "arTimeMinutes", "arNavigationTimeMinutes"];

function averages({ prePctSum, preCount, postPctSum, postCount }) {
  const pre = preCount ? Math.round(prePctSum / preCount) : null;
  const post = postCount ? Math.round(postPctSum / postCount) : null;
  return { pre, post, gain: pre === null || post === null ? null : post - pre };
}

function duration(minutes) {
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60), rest = rounded % 60;
  return hours ? (rest ? `${hours} h ${rest} min` : `${hours} h`) : `${rest} min`;
}

export function summarizeAdminReports(teacherDocs, students, classes = []) {
  const sectionsById = new Map(classes.map(row => [row.id, row.data]));
  const teachers = new Map(teacherDocs.map(({ id, data }) => {
    let joined = data.joined || "Recently";
    if (data.createdAt?.$type === "timestamp" && Number.isFinite(Date.parse(data.createdAt.value))) {
      joined = new Date(data.createdAt.value).toLocaleDateString("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" });
    }
    return [id, {
      id, schoolId: data.schoolId || id,
      name: data.fullName || data.name || data.displayName || "Teacher",
      analyticsName: data.displayName || data.fullName || data.name || "Teacher",
      meta: data.section ? `${data.subject || "Science"} · ${data.section}` : (data.subject || "Science / AR"),
      email: data.providedEmail || data.email || "No email", subject: data.subject || "Science",
      joined, sections: Array.isArray(data.sections) ? data.sections : data.section ? [data.section] : [],
      analyticsSections: Array.isArray(data.sections) && data.sections.length ? data.sections.join(", ") : (data.section || "General Science"),
      active: data.active !== false && data.status !== "inactive",
      students: 0, prePctSum: 0, preCount: 0, postPctSum: 0, postCount: 0, arMinutes: 0
    }];
  }));
  const sections = new Map();
  let prePctSum = 0, preCount = 0, postPctSum = 0, postCount = 0, arMinutes = 0;
  for (const { data, lessons } of students) {
    const classData = sectionsById.get(data.classCode);
    const assigned = classData?.teacherId || data.teacherId || data.adviserId || data.teacher;
    const teacher = teachers.get(assigned);
    if (teacher) teacher.students++;
    let sectionName = classData?.SectionName || classData?.sectionName || data.section || data.gradeSection || data.sectionName || data.className;
    if (!sectionName && teacher?.analyticsSections !== "General Science" && teacher?.analyticsSections) {
      sectionName = teacher.analyticsSections.split(",")[0].trim();
    }
    sectionName ||= "Unassigned";
    if (!sections.has(sectionName)) sections.set(sectionName, { name: sectionName, students: 0, prePctSum: 0, preCount: 0, postPctSum: 0, postCount: 0 });
    const section = sections.get(sectionName);
    section.students++;
    for (const result of lessons) {
      const pre = assessmentPoints(result, "pre", 100);
      const post = assessmentPoints(result, "post", 100);
      if (pre !== null) {
        prePctSum += pre; preCount++;
        section.prePctSum += pre; section.preCount++;
        if (teacher) { teacher.prePctSum += pre; teacher.preCount++; }
      }
      if (post !== null) {
        postPctSum += post; postCount++;
        section.postPctSum += post; section.postCount++;
        if (teacher) { teacher.postPctSum += post; teacher.postCount++; }
      }
      const minutes = [result.arTimeMinutes, result.arNavigationTimeMinutes].find(value => Number.isFinite(value) && value > 0) || 0;
      arMinutes += minutes;
      if (teacher) teacher.arMinutes += minutes;
    }
  }
  return {
    totalStudents: students.length, ...averages({ prePctSum, preCount, postPctSum, postCount }), hours: duration(arMinutes),
    teachers: [...teachers.values()].map(teacher => ({ ...teacher, ...averages(teacher), hours: duration(teacher.arMinutes) })),
    sections: [...sections.values()].map(section => ({ ...section, ...averages(section) }))
  };
}

export async function loadAdminReports(store) {
  const roster = (role, fieldPaths) => store.query("users", { filters: [{ field: "role", op: "==", value: role }], fieldPaths });
  const [teachers, rosterRows, classes, rows] = await Promise.all([
    roster("teacher", teacherFields), roster("student", studentFields),
    store.query("classes", { fieldPaths: ["SectionName", "sectionName", "teacherId"] }),
    store.adminLessonResults?.(resultFields)
  ]);
  const students = new Map(rosterRows.filter(({ data }) => data.active !== false &&
    !["inactive", "disabled", "deleted", "archived"].includes(String(data.status || "").toLowerCase()))
    .map(({ id, data }) => [id, { data, lessons: [] }]));
  if (rows) {
    for (const row of rows) students.get(row.path.split("/")[1])?.lessons.push(row.data);
  } else {
    const paths = [...students.keys()].flatMap(lessonPaths);
    for (let offset = 0; offset < paths.length; offset += 400) {
      const batches = [];
      for (let start = offset; start < Math.min(offset + 400, paths.length); start += 100) {
        batches.push(store.getAll(paths.slice(start, start + 100), { fieldPaths: resultFields }));
      }
      for (const batch of await Promise.all(batches)) {
        for (const [path, row] of batch) if (row) students.get(path.split("/")[1]).lessons.push(row.data);
      }
    }
  }
  return summarizeAdminReports(teachers.map(row => ({ id: row.id, data: row.wire || row.data })), [...students.values()], classes);
}
