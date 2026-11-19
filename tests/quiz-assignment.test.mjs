import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { setLoadingState } from "../js/loading.js";
import { clearQuizWorkspace, readQuizWorkspace, saveQuizWorkspace } from "../js/quiz-workspace.js";
import { quizFileSizeError, questionTypeLabel, writtenQuestion, normalizeQuizQuestion, quizAssignmentScope, quizAssignedToSection } from "../js/quiz-limits.js";

test("generation, review, unassigned draft and all-section release use the actual page flow", async () => {
  const html = readFileSync(new URL("../quiz-generator.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="quizSection"/);
  class Element {
    value = ""; textContent = ""; innerHTML = ""; hidden = false; disabled = false; checked = false; isConnected = true;
    dataset = {}; listeners = {}; children = new Map();
    classList = { toggle() {}, add() {}, remove() {} };
    addEventListener(name, action) { this.listeners[name] = action; }
    setAttribute() {}
    removeAttribute() {}
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    querySelector(selector) { if (!this.children.has(selector)) this.children.set(selector, new Element()); return this.children.get(selector); }
  }
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,new Element()]));
  const element = id => { assert.ok(elements.has(id), "Unknown page element: " + id); return elements.get(id); };
  assert.doesNotMatch(html, /id="(?:quizTerm|editorTerm|editorSectionSelect)"/);
  const choice = new Element(); choice.value = "multiple-choice";
  const browserEvents = {};
  const windowEvents = {};
  const workspaceValues = new Map();
  const workspaceStorage = { getItem: key => workspaceValues.get(key) || null, setItem: (key, value) => workspaceValues.set(key, value), removeItem: key => workspaceValues.delete(key) };
  const quizzes = new Map(), saves = [];
  const docs = rows => ({ docs: rows.map(([id,data])=>({id,data:()=>data})), size: rows.length });
  let authenticated, requested, transport, results, showSlowMessage, finishGeneration, confirmDelete = false, confirmDiscard = true;
  let job = { status: "none" };
  const context = {
    console, Blob, Date, Math, JSON, quizFileSizeError, questionTypeLabel, writtenQuestion, normalizeQuizQuestion, quizAssignmentScope, quizAssignedToSection, setLoadingState, revealContent: () => {},
    setTimeout: (callback, delay) => {
      if (delay === 5000) return 2;
      showSlowMessage = callback; return 1;
    },
    clearTimeout: id => { if (id === 1) showSlowMessage = null; },
    initializeApp:()=>({}), getAuth:()=>({currentUser:{uid:"teacher-a"}}), getFirestore:()=>({}),
    collection:(_db,path)=>path, query:(path)=>path, where:()=>null, doc:(_db,_collection,id)=>id,
    getDocs:async path=>path==="users" ? docs([["TEACH1",{role:"teacher"}]]) : path==="classes" ? docs([["A",{SectionName:"Section A"}],["C",{SectionName:"Section C"}]]) : docs([...quizzes]),
    getDoc:async id=>({exists:()=>quizzes.has(id),data:()=>quizzes.get(id)}),
    setDoc:async (id,data)=>{quizzes.set(id,structuredClone(data));saves.push(structuredClone(data));},
    updateDoc:async (id,data)=>{assert.ok(!Object.hasOwn(data,"questions"));const updated={...quizzes.get(id),...data};quizzes.set(id,updated);saves.push(updated);}, deleteDoc:async id => { quizzes.delete(id); },
    confirmAction: async options => { assert.ok(["Delete quiz?", "Start a new quiz?", "Open another quiz?", "Review the generated quiz?"].includes(options.title)); return options.title === "Delete quiz?" ? confirmDelete : confirmDiscard; },
    onAuthStateChanged:(_auth,callback)=>{authenticated=callback;}, showTeacherView:async ({load,render,painted})=>{render(await load());painted();},
    requestQuiz: (payload, _uid, options = { background: false }) => {
      requested = payload;
      transport = options;
      return new Promise(resolve => { finishGeneration = resolve; });
    },
    readQuizJob: async () => job,
    discardQuizJob: async (_uid, id) => { assert.equal(id, job.id); job = { status: "none" }; },
    extractOfficeText:async()=>"Water freezes.", localStorage:{setItem(){}},
    closeQuizReview() {}, openQuizReview: (...args) => { results = args; },
    saveQuizWorkspace: (uid, value) => saveQuizWorkspace(uid, value, workspaceStorage),
    readQuizWorkspace: (uid, id) => readQuizWorkspace(uid, id, workspaceStorage),
    clearQuizWorkspace: () => clearQuizWorkspace(workspaceStorage),
    window:{scrollTo(){},addEventListener: (event, callback) => { windowEvents[event] = callback; },
      removeEventListener: event => { delete windowEvents[event]; }, confirm:()=>true},
    document:{getElementById:element,querySelectorAll:()=>[],querySelector:()=>choice,
      addEventListener: (event, callback) => { browserEvents[event] = callback; }, visibilityState: "visible"}
  };
  vm.runInNewContext(readFileSync(new URL("../js/quiz-generator.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm,""),context);
  const loadingTeacher = authenticated({uid:"teacher-a"});
  assert.equal(element("generateQuiz").disabled,true);
  element("quizFile").files = [{ name: "oversized.pdf", size: 50_600_000 }];
  element("quizFile").listeners.change();
  await loadingTeacher;
  assert.match(element("quizFileError").textContent, /exceeds the 50 MB limit/);
  assert.equal(element("generateQuiz").disabled, true);
  assert.equal(requested, undefined);
  const file = Object.assign(new Blob(["PDF fixture"]),{name:"water.pdf"});
  element("quizFile").files=[file]; element("quizFile").listeners.change();
  assert.equal(element("quizFileError").textContent, "");
  assert.equal(element("generateQuiz").disabled,false);
  element("questionCount").value="1";
  const generation = element("generateQuiz").listeners.click();
  assert.equal(element("quizGenerationStatusCard").open, true);
  assert.match(element("quizGenerationStatus").textContent, /Preparing/);
  await new Promise(setImmediate);
  assert.match(element("quizGenerationStatus").textContent, /Uploading your PDF/);
  showSlowMessage();
  assert.match(element("quizGenerationHint").textContent, /taking longer/);
  finishGeneration([{text:"Which material freezes into ice?",options:["Water","Milk","Juice","Oil"],correctIndex:0}]);
  await generation;
  assert.equal(element("quizGenerationStatusCard").open, false);
  assert.equal(showSlowMessage, null);
  assert.equal(requested.sectionId,undefined);
  assert.equal(requested.termId, undefined);
  assert.equal(transport.background, true);
  assert.equal(element("reviewStep").hidden,false);
  element("acceptAll").listeners.click();
  assert.equal(element("editorStep").hidden,false);
  element("editorTitle").value = "Edited Water Quiz";
  confirmDiscard = false;
  await element("newQuizFromLibrary").listeners.click();
  assert.equal(element("editorStep").hidden, false);
  assert.equal(element("editorTitle").value, "Edited Water Quiz");
  confirmDiscard = true;
  element("questionEditorList").listeners.input({ target: { dataset: { questionText: "0" }, value: "Which substance freezes into ice?" } });
  let warned = false;
  windowEvents.beforeunload({ preventDefault() { warned = true; } });
  assert.equal(warned, true);
  assert.equal(readQuizWorkspace("teacher-a", "TEACH1", workspaceStorage).editorTitle, "Edited Water Quiz");
  const preservedId = readQuizWorkspace("teacher-a", "TEACH1", workspaceStorage).draftId;
  await authenticated({ uid: "teacher-a" });
  assert.equal(element("editorStep").hidden, false);
  assert.equal(element("editorTitle").value, "Edited Water Quiz");
  assert.match(element("questionEditorList").innerHTML, /Which substance freezes into ice/);
  await element("saveQuiz").listeners.click();
  assert.equal(saves[0].id, preservedId);
  assert.equal(readQuizWorkspace("teacher-a", "TEACH1", workspaceStorage), null);
  assert.equal(windowEvents.beforeunload, undefined);
  assert.equal(element("generateQuiz").disabled,true);
  assert.equal(saves[0].termId, undefined);
  assert.equal(saves[0].assignmentScope,"unassigned"); assert.equal(saves[0].sectionId,""); assert.equal(saves[0].availability,"draft");
  assert.match(element("quizLibraryList").innerHTML,/All my sections/);
  assert.doesNotMatch(element("quizLibraryList").innerHTML,/View results/);
  const form = new Element(); form.dataset.scheduleForm=saves[0].id;
  form.elements={sectionId:{value:"*"},termId:{value:"term_02"},availability:{value:"now"},availableAt:{value:""}};
  element("quizLibraryList").listeners.submit({preventDefault(){},target:{closest:()=>form}});
  await new Promise(setImmediate);
  assert.equal(saves.at(-1).assignmentScope,"all"); assert.equal(saves.at(-1).sectionId,""); assert.equal(saves.at(-1).availability,"now");
  assert.equal(saves.at(-1).termId, "term_02");
  assert.match(element("libraryStatus").textContent,/Release saved/);
  for(const section of ["A","C"]) {
    element("librarySectionFilter").value=section; element("librarySectionFilter").listeners.change();
    assert.match(element("quizLibraryList").innerHTML,/Water|water/);
  }
  assert.match(element("quizLibraryList").innerHTML,/View results/);
  await element("quizLibraryList").listeners.click({ target: { closest: selector =>
    selector === "[data-results-quiz]" ? { dataset: { resultsQuiz: saves[0].id } } : null } });
  assert.equal(results[1].id, saves[0].id);
  assert.equal(results[3], "C");
  element("gradingTab").listeners.click();
  assert.equal(element("gradingView").hidden, false);
  assert.equal(element("createView").hidden, true);
  assert.equal(element("libraryView").hidden, true);
  element("gradingTermFilter").value = "term_03";
  element("gradingTermFilter").listeners.change();
  assert.equal(element("gradingQuizList").innerHTML, "");
  element("gradingTermFilter").value = saves.at(-1).termId;
  element("gradingSectionFilter").value = "A";
  element("gradingSectionFilter").listeners.change();
  assert.match(element("gradingQuizList").innerHTML, /View submissions \/ grade/);
  element("gradingQuizList").listeners.click({ target: { closest: () => ({ dataset: { gradeQuiz: saves[0].id } }) } });
  assert.equal(results[1].id, saves[0].id);
  assert.equal(results[3], "A", "grading uses its own section filter");
  element("libraryTab").listeners.click();
  await element("quizLibraryList").listeners.click({ target: { closest: selector =>
    selector === "[data-schedule-quiz]" ? { dataset: { scheduleQuiz: saves[0].id } } : null } });
  assert.match(element("quizLibraryList").innerHTML, /name="sectionId"/);
  form.elements={sectionId:{value:"A"},termId:{value:"term_02"},availability:{value:"scheduled"},availableAt:{value:"2099-10-20T09:30"}};
  element("quizLibraryList").listeners.submit({preventDefault(){},target:{closest:()=>form}});
  await new Promise(setImmediate);
  assert.equal(saves.at(-1).sectionId, "A");
  assert.equal(saves.at(-1).availableAt, new Date("2099-10-20T09:30").toISOString());
  assert.equal(element("librarySectionFilter").value, "A");
  assert.match(element("quizLibraryList").innerHTML, /Scheduled · locked/);
  element("gradingTermFilter").value = "term_02";
  element("gradingTermFilter").listeners.change();
  assert.match(element("gradingQuizList").innerHTML, /data-grade-quiz/, "locked scheduled quizzes retain a grading entry point");
  await element("quizLibraryList").listeners.click({ target: { closest: selector =>
    selector === "[data-edit-quiz]" ? { dataset: { editQuiz: saves[0].id } } : null } });
  await new Promise(setImmediate);
  await element("saveQuiz").listeners.click();
  assert.equal(saves.at(-1).id, saves[0].id);
  assert.equal(saves.at(-1).termId, "term_02");
  assert.equal(saves.at(-1).sectionId, "A");
  assert.equal(saves.at(-1).availability, "scheduled");
  const deleteClick = { target: { closest: selector =>
    selector === "[data-delete-quiz]" ? { dataset: { deleteQuiz: saves[0].id } } : null } };
  await element("quizLibraryList").listeners.click(deleteClick);
  assert.equal(quizzes.has(saves[0].id), true);
  confirmDelete = true;
  await element("quizLibraryList").listeners.click(deleteClick);
  assert.equal(quizzes.has(saves[0].id), false);

  element("newQuizFromLibrary").listeners.click();
  element("quizFile").files = [file];
  element("quizFile").listeners.change();
  job = { id: "05563121-1488-47bb-939b-b4e930eafcde", status: "queued" };
  const pending = element("generateQuiz").listeners.click();
  await new Promise(setImmediate);
  context.document.visibilityState = "hidden";
  browserEvents.visibilitychange();
  finishGeneration(job);
  await pending;
  await new Promise(setImmediate);
  assert.equal(element("quizGenerationStatusCard").open, false);
  assert.match(element("quizJobMessage").textContent, /come back/);
  assert.equal(element("generateQuiz").disabled, true);
  job = { ...job, status: "complete", details: { title: "Water quiz", fileName: "water.pdf", questionType: "multiple-choice", difficulty: "Medium", termId: "term_01" },
    questions: [{ text: "Which material freezes into ice?", options: ["Water", "Milk", "Juice", "Oil"], correctIndex: 0 }] };
  context.document.visibilityState = "visible";
  browserEvents.visibilitychange();
  await new Promise(setImmediate);
  assert.equal(element("reviewStep").hidden, false);
  assert.equal(element("quizTitle").value, "Water quiz");
  element("acceptAll").listeners.click();
  await element("saveQuiz").listeners.click();
  assert.equal(job.status, "none");
  assert.equal(saves.at(-1).sourceFile, "water.pdf");

  element("newQuizFromLibrary").listeners.click();
  element("quizFile").files = [file];
  element("quizFile").listeners.change();
  const interrupted = element("generateQuiz").listeners.click();
  await new Promise(setImmediate);
  assert.equal(transport.background, true);
  job = { id: "6f9f2c8a-5303-465c-8005-81e51e6d5463", status: "queued" };
  finishGeneration(job);
  await interrupted;
  await new Promise(setImmediate);
  job = { ...job, status: "failed", errorCode: "JOB_DELIVERY_FAILED", error: "Interrupted." };
  browserEvents.visibilitychange();
  await new Promise(setImmediate);
  assert.equal(transport.background, false);
  finishGeneration([{ text: "Which material freezes into ice?", options: ["Water", "Milk", "Juice", "Oil"], correctIndex: 0 }]);
  await new Promise(setImmediate);
  assert.equal(element("reviewStep").hidden, false);

  job = { id: "05563121-1488-47bb-939b-b4e930eafcde", status: "failed", errorCode: "JOB_DELIVERY_FAILED",
    error: "The background quiz job was interrupted." };
  await authenticated({ uid: "teacher-a" });
  await element("newQuizFromLibrary").listeners.click();
  element("quizFile").files = [file];
  element("quizFile").listeners.change();
  const retry = element("generateQuiz").listeners.click();
  await new Promise(setImmediate);
  assert.equal(transport.background, false);
  finishGeneration([{ text: "Which material freezes into ice?", options: ["Water", "Milk", "Juice", "Oil"], correctIndex: 0 }]);
  await retry;
  assert.equal(element("reviewStep").hidden, false);
  assert.equal(element("quizJobStatus").hidden, true);
  assert.equal(element("quizGenerationStatusCard").open, false);
});
