import { collection, query, where } from "./firebase-data.js";
import { summarizeAssessments } from "./activity-score.js";
import { showAdminView } from "./admin-view.js";
import { getAuth } from "./firebase-auth.js";
import { reportContext } from "./teacher-report-data.js";
import { webRequest } from "./web-login.js";

export async function loadStaffDirectory() {
  const teachers = [], sections = []; let teacherCursor, sectionCursor, totalStudents = 0;
  do {
    const page = await webRequest("/api/web-data", { action: "staff-directory", teacherCursor, sectionCursor });
    teachers.push(...page.teachers); sections.push(...page.sections);
    if (page.totalStudents !== undefined) totalStudents = page.totalStudents;
    teacherCursor = page.teacherCursor; sectionCursor = page.sectionCursor;
  } while (teacherCursor || sectionCursor);
  return { teachers, sections, totalStudents };
}

export function summarizeAdminReports(teacherDocs, students, classDocs) {
  const classes = new Map((classDocs || []).map(row => [row.id, row.data]));
  const teachers = new Map(teacherDocs.map(({id,data}) => {
    const sections = classDocs ? classDocs.filter(row => row.data.teacherId === id).map(row => row.data.SectionName || row.id) : data.sections || (data.section ? [data.section] : []);
    return [id, {id,schoolId:data.schoolId || id,name:data.fullName || data.name || data.displayName || "Teacher",analyticsName:data.displayName || data.fullName || data.name || "Teacher",
      meta:data.subject || "Science",email:data.providedEmail || data.email || "No email",subject:data.subject || "Science",joined:data.createdAt?.toDate?.().toLocaleDateString("en-US") || data.joined || "Recently",
      sections,analyticsSections:sections.join(", ") || "No sections assigned",active:data.active !== false && data.status !== "inactive",students:0,arMinutes:0,results:[]}];
  }));
  const sections = new Map(), allResults = []; let totalStudents = 0, arMinutes = 0;
  for (const {data,lessons} of students) {
    if (data.active === false) continue;
    totalStudents++;
    const classroom = classes.get(data.classCode), teacher = teachers.get(classroom?.teacherId || data.teacherId || data.adviserId || data.teacher);
    const sectionName = classroom?.SectionName || data.section || data.gradeSection || data.sectionName || data.className || data.classCode || "Unassigned section";
    const sectionId = data.classCode || sectionName;
    if (!sections.has(sectionId)) sections.set(sectionId,{id:sectionId,name:sectionName,teacherName:teacher?.name || "",students:0,results:[]});
    const section = sections.get(sectionId); section.students++; section.results.push(...lessons); allResults.push(...lessons);
    if (teacher) { teacher.students++; teacher.results.push(...lessons); }
    for (const lesson of lessons) {
      const minutes = lesson.arTimeMinutes || lesson.arNavigationTimeMinutes || 0;
      if (typeof minutes === "number" && minutes > 0) { arMinutes += minutes; if (teacher) teacher.arMinutes += minutes; }
    }
  }
  const hours = minutes => minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes)}m`;
  const summarize = ({results,...row}) => ({...row,...summarizeAssessments(results),...(row.arMinutes !== undefined ? {hours:hours(row.arMinutes)} : {})});
  return {...summarizeAssessments(allResults),totalStudents,hours:hours(arMinutes),teachers:[...teachers.values()].map(summarize),sections:[...sections.values()].map(summarize)};
}

export async function loadAdminReports(db, read, termId = "term_01") {
  if (!/^term_0[1-3]$/.test(termId)) throw new Error("Choose one report term.");
  const [teachers,students,directory] = await Promise.all([
    read(query(collection(db,"users"),where("role","==","teacher"))),
    read(query(collection(db,"users"),where("role","==","student"))),
    loadStaffDirectory()
  ]);
  const results = await Promise.all(students.docs.filter(row => row.data().active !== false).map(async student => {
    const lessons = await read(collection(db,"users",student.id,"test_results",termId,"lessons"));
    return {data:student.data(),lessons:lessons.docs.map(row => row.data())};
  }));
  return {...summarizeAdminReports(teachers.docs.map(row=>({id:row.id,data:row.data()})),results,directory.sections),termId};
}

export async function showAdminTermReport({app,user,db,render,timing}) {
  const control = document.getElementById("adminReportTerm");
  control.value = reportContext(app,user).termId;
  const open = async () => {
    const termId = control.value;
    const content = document.getElementById("adminReportContent"), status = document.getElementById("adminReportStatus");
    if (content) content.hidden = true;
    if (status) status.textContent = "Loading Term " + termId.slice(-1) + " results…";
    reportContext(app,user,{termId});
    await showAdminView({app,user,page:"reports:v2:"+termId,watchKey:"admin:report",
      load:({read})=>timing.data(()=>loadAdminReports(db,read,termId)),
      render:report=>{if(control.value===termId && getAuth(app).currentUser?.uid===user.uid)timing.render(()=>{render(report);if(content)content.hidden=false;if(status)status.textContent="";});},
      painted:cacheHit=>timing.finish("loaded",{cacheHit})});
  };
  control.onchange = () => { void open().catch(error=>console.error("Report update failed:",error)); };
  await open();
}
