import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { setLoadingState } from "../js/loading.js";
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
  const termPicker = element("editorTerm");
  termPicker.options = [...html.match(/<select[^>]*id="editorTerm"[^>]*>([\s\S]*?)<\/select>/)[1]
    .matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(([, value, textContent]) => ({ value, textContent }));
  const choice = new Element(), availability = new Element(); choice.value = "multiple-choice"; availability.value = "draft";
  const quizzes = new Map(), saves = [];
  const docs = rows => ({ docs: rows.map(([id,data])=>({id,data:()=>data})), size: rows.length });
  let authenticated, requested, results, showSlowMessage, pollJob, finishGeneration, confirmDelete = false;
  let job = { status: "none" };
  const context = {
    console, Blob, Date, Math, JSON, quizFileSizeError, questionTypeLabel, writtenQuestion, normalizeQuizQuestion, quizAssignmentScope, quizAssignedToSection, setLoadingState, revealContent: () => {},
    setTimeout: (callback, delay) => {
      if (delay === 5000) { pollJob = callback; return 2; }
      showSlowMessage = callback; return 1;
    },
    clearTimeout: id => { if (id === 1) showSlowMessage = null; else if (id === 2) pollJob = null; },
    initializeApp:()=>({}), getAuth:()=>({currentUser:{uid:"teacher-a"}}), getFirestore:()=>({}),
    collection:(_db,path)=>path, query:(path)=>path, where:()=>null, doc:(_db,_collection,id)=>id,
    getDocs:async path=>path==="users" ? docs([["TEACH1",{role:"teacher"}]]) : path==="classes" ? docs([["A",{SectionName:"Section A"}],["C",{SectionName:"Section C"}]]) : docs([...quizzes]),
    getDoc:async id=>({exists:()=>quizzes.has(id),data:()=>quizzes.get(id)}),
    setDoc:async (id,data)=>{quizzes.set(id,structuredClone(data));saves.push(structuredClone(data));},
    updateDoc:async (id,data)=>{assert.ok(!Object.hasOwn(data,"questions"));const updated={...quizzes.get(id),...data};quizzes.set(id,updated);saves.push(updated);}, deleteDoc:async id => { quizzes.delete(id); },
    confirmAction: async options => { assert.equal(options.title, "Delete quiz?"); return confirmDelete; },
    onAuthStateChanged:(_auth,callback)=>{authenticated=callback;}, showTeacherView:async ({load,render,painted})=>{render(await load());painted();},
    requestQuiz: payload => {
      requested = payload;
      return new Promise(resolve => { finishGeneration = resolve; });
    },
    readQuizJob: async () => job,
    discardQuizJob: async (_uid, id) => { assert.equal(id, job.id); job = { status: "none" }; },
    extractOfficeText:async()=>"Water freezes.", localStorage:{setItem(){}},
    closeQuizReview() {}, openQuizReview: (...args) => { results = args; },
    window:{scrollTo(){},addEventListener(){},confirm:()=>true},
    document:{getElementById:element,querySelectorAll:()=>[],querySelector:selector=>selector.includes("questionType") ? choice : availability}
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
  element("quizTerm").value = "term_02";
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
  assert.equal(requested.termId, "term_02");
  assert.equal(element("reviewStep").hidden,false);
  element("acceptAll").listeners.click();
  assert.equal(element("editorStep").hidden,false);
  assert.equal(element("quizAvailability").hidden,true);
  assert.equal(termPicker.value, "term_02");
  termPicker.value = "";
  await element("saveQuiz").listeners.click();
  assert.equal(saves.length, 0);
  assert.match(element("editorStatus").textContent, /Choose a term/);
  termPicker.value = "term_02";
  await element("saveQuiz").listeners.click();
  assert.equal(element("generateQuiz").disabled,true);
  assert.equal(saves[0].termId, "term_02");
  assert.match(element("quizLibraryList").innerHTML, /Term 2/);
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
  await element("quizLibraryList").listeners.click({ target: { closest: selector =>
    selector === "[data-edit-quiz]" ? { dataset: { editQuiz: saves[0].id } } : null } });
  await new Promise(setImmediate);
  const sectionPicker = element("editorSectionSelect");
  assert.equal(termPicker.value, "term_02");
  termPicker.value = "term_03";
  assert.equal(sectionPicker.hidden, false);
  assert.equal(sectionPicker.value, "A");
  assert.match(sectionPicker.innerHTML, /All my sections/);
  assert.match(sectionPicker.innerHTML, /Section A/);
  assert.match(sectionPicker.innerHTML, /Section C/);
  assert.doesNotMatch(sectionPicker.innerHTML, /Section B/);
  sectionPicker.value = "*";
  sectionPicker.listeners.change();
  availability.value = "now";
  await element("saveQuiz").listeners.click();
  assert.equal(saves.at(-1).id, saves[0].id);
  assert.equal(saves.at(-1).termId, "term_03");
  assert.equal(saves.at(-1).assignmentScope, "all");
  assert.equal(saves.at(-1).availability, "now");
  availability.value = "draft";
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
  element("quizTerm").value = "term_01";
  const queued = element("generateQuiz").listeners.click();
  await new Promise(setImmediate);
  job = { id: "05563121-1488-47bb-939b-b4e930eafcde", status: "queued" };
  finishGeneration(job);
  await queued;
  await new Promise(setImmediate);
  assert.equal(element("quizGenerationStatusCard").open, false);
  assert.match(element("quizJobMessage").textContent, /come back/);
  assert.equal(element("generateQuiz").disabled, true);
  job = { ...job, status: "complete", details: { title: "Water quiz", fileName: "water.pdf", questionType: "multiple-choice", difficulty: "Medium", termId: "term_01" },
    questions: [{ text: "Which material freezes into ice?", options: ["Water", "Milk", "Juice", "Oil"], correctIndex: 0 }] };
  pollJob();
  await new Promise(setImmediate);
  assert.equal(element("reviewStep").hidden, false);
  assert.equal(element("quizTitle").value, "Water quiz");
  element("acceptAll").listeners.click();
  assert.equal(termPicker.value, "term_01");
  await element("saveQuiz").listeners.click();
  assert.equal(job.status, "none");
  assert.equal(saves.at(-1).sourceFile, "water.pdf");
});
