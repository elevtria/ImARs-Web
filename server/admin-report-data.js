const lessonIds = ["lesson_01", "lesson_02", "lesson_03", "lesson_04"];
const teacherFields = ["schoolId", "fullName", "name", "displayName", "section", "sections", "subject", "providedEmail", "email", "joined", "createdAt", "active", "status"];
const studentFields = ["teacherId", "adviserId", "teacher", "section", "gradeSection", "sectionName", "className"];
const resultFields = ["isPreTestCompleted", "preTestTotalQuestions", "preTestScore", "isPostTestCompleted", "postTestTotalQuestions", "postTestScore", "postTestHeatmap", "arTimeMinutes"];

// The three admin reports use the same Term 1 results. Keep their existing
// averages, name preferences, section fallbacks, and teacher attribution.
export function summarizeAdminReports(teacherDocs, students) {
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
    const assigned = data.teacherId || data.adviserId || data.teacher;
    const teacher = teachers.get(assigned) || teachers.values().next().value;
    if (teacher) teacher.students++;
    let sectionName = data.section || data.gradeSection || data.sectionName || data.className;
    if (!sectionName && teacher?.analyticsSections !== "General Science" && teacher?.analyticsSections) {
      sectionName = teacher.analyticsSections.split(",")[0].trim();
    }
    sectionName ||= "Grade 6 – Section A";
    if (!sections.has(sectionName)) sections.set(sectionName, { name: sectionName, students: 0, prePctSum: 0, preCount: 0, postPctSum: 0, postCount: 0 });
    const section = sections.get(sectionName);
    section.students++;
    for (const result of lessons) {
      if (result.isPreTestCompleted && result.preTestTotalQuestions > 0) {
        const percentage = result.preTestScore / result.preTestTotalQuestions * 100;
        prePctSum += percentage; preCount++;
        section.prePctSum += percentage; section.preCount++;
        if (teacher) { teacher.prePctSum += percentage; teacher.preCount++; }
      }
      if (result.isPostTestCompleted && result.postTestTotalQuestions > 0) {
        const score = result.postTestScore !== undefined ? result.postTestScore : (result.postTestHeatmap ? result.postTestHeatmap.filter(Boolean).length : 0);
        const percentage = score / result.postTestTotalQuestions * 100;
        postPctSum += percentage; postCount++;
        section.postPctSum += percentage; section.postCount++;
        if (teacher) { teacher.postPctSum += percentage; teacher.postCount++; }
      }
      if (result.arTimeMinutes) {
        arMinutes += result.arTimeMinutes;
        if (teacher) teacher.arMinutes += result.arTimeMinutes;
      }
    }
  }
  const pre = preCount ? Math.round(prePctSum / preCount) : 0;
  const post = postCount ? Math.round(postPctSum / postCount) : 0;
  return {
    totalStudents: students.length, pre, post, gain: Math.max(0, post - pre),
    hours: arMinutes >= 60 ? `${Math.round(arMinutes / 60)}h` : `${arMinutes}m`,
    teachers: [...teachers.values()].map(teacher => ({ ...teacher,
      pre: teacher.preCount ? Math.round(teacher.prePctSum / teacher.preCount) : 0,
      post: teacher.postCount ? Math.round(teacher.postPctSum / teacher.postCount) : 0,
      hours: teacher.arMinutes >= 60 ? `${Math.round(teacher.arMinutes / 60)}h` : `${teacher.arMinutes}m`
    })),
    sections: [...sections.values()]
  };
}

export async function loadAdminReports(store) {
  const roster = (role, fieldPaths) => store.query("users", { filters: [{ field: "role", op: "==", value: role }], fieldPaths });
  const [teachers, students] = await Promise.all([roster("teacher", teacherFields), roster("student", studentFields)]);
  const results = [];
  for (let offset = 0; offset < students.length; offset += 100) {
    const groups = [];
    for (let start = offset; start < Math.min(offset + 100, students.length); start += 25) {
      groups.push(students.slice(start, start + 25));
    }
    const batches = await Promise.all(groups.map(async group => {
      const paths = group.map(student => lessonIds.map(id => `users/${student.id}/test_results/term_01/lessons/${id}`));
      const records = await store.getAll(paths.flat(), { fieldPaths: resultFields });
      return group.map((student, index) => ({
        data: student.data,
        lessons: paths[index].map(path => records.get(path)?.data).filter(Boolean)
      }));
    }));
    for (const batch of batches) results.push(...batch);
  }
  return summarizeAdminReports(teachers.map(row => ({ id: row.id, data: row.wire || row.data })), results);
}
