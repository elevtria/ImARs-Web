import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
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
    focus() {}
    querySelector(selector) { if (!this.children.has(selector)) this.children.set(selector, new Element()); return this.children.get(selector); }
  }
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,new Element()]));
  const element = id => { assert.ok(elements.has(id), "Unknown page element: " + id); return elements.get(id); };
  const choice = new Element(), availability = new Element(); choice.value = "multiple-choice"; availability.value = "draft";
  const quizzes = new Map(), saves = [];
  const docs = rows => ({ docs: rows.map(([id,data])=>({id,data:()=>data})), size: rows.length });
  let authenticated, requested;
  const context = {
    console, Blob, Date, Math, JSON, quizFileSizeError, questionTypeLabel, writtenQuestion, normalizeQuizQuestion, quizAssignmentScope, quizAssignedToSection,
    initializeApp:()=>({}), getAuth:()=>({currentUser:{uid:"teacher-a"}}), getFirestore:()=>({}),
    collection:(_db,path)=>path, query:(path)=>path, where:()=>null, doc:(_db,_collection,id)=>id,
    getDocs:async path=>path==="users" ? docs([["TEACH1",{role:"teacher"}]]) : path==="classes" ? docs([["A",{SectionName:"Section A"}],["C",{SectionName:"Section C"}]]) : docs([...quizzes]),
    getDoc:async id=>({exists:()=>quizzes.has(id),data:()=>quizzes.get(id)}),
    setDoc:async (id,data)=>{quizzes.set(id,structuredClone(data));saves.push(structuredClone(data));}, deleteDoc:async()=>{},
    onAuthStateChanged:(_auth,callback)=>{authenticated=callback;}, openQuizReview(){}, closeQuizReview(){},
    requestQuiz:async payload=>{requested=payload;return [{text:"Which material freezes into ice?",options:["Water","Milk","Juice","Oil"],correctIndex:0}];},
    extractOfficeText:async()=>"Water freezes.", localStorage:{setItem(){}},
    window:{scrollTo(){},confirm:()=>true},
    document:{getElementById:element,querySelectorAll:()=>[],querySelector:selector=>selector.includes("questionType") ? choice : availability}
  };
  vm.runInNewContext(readFileSync(new URL("../js/quiz-generator.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm,""),context);
  await authenticated({uid:"teacher-a"});
  const file = Object.assign(new Blob(["PDF fixture"]),{name:"water.pdf"});
  element("quizFile").files=[file]; element("quizFile").listeners.change();
  element("questionCount").value="1";
  await element("generateQuiz").listeners.click();
  assert.equal(requested.sectionId,undefined);
  assert.equal(element("reviewStep").hidden,false);
  element("acceptAll").listeners.click();
  assert.equal(element("editorStep").hidden,false);
  assert.equal(element("quizAvailability").hidden,true);
  await element("saveQuiz").listeners.click();
  assert.equal(saves[0].assignmentScope,"unassigned"); assert.equal(saves[0].sectionId,""); assert.equal(saves[0].availability,"draft");
  assert.match(element("quizLibraryList").innerHTML,/All my sections/);
  const form = new Element(); form.dataset.scheduleForm=saves[0].id;
  form.elements={sectionId:{value:"*"},availability:{value:"now"},availableAt:{value:""}};
  element("quizLibraryList").listeners.submit({preventDefault(){},target:{closest:()=>form}});
  await new Promise(setImmediate);
  assert.equal(saves.at(-1).assignmentScope,"all"); assert.equal(saves.at(-1).sectionId,""); assert.equal(saves.at(-1).availability,"now");
  assert.match(element("libraryStatus").textContent,/Release saved/);
  for(const section of ["A","C"]) {
    element("librarySectionFilter").value=section; element("librarySectionFilter").listeners.change();
    assert.match(element("quizLibraryList").innerHTML,/Water|water/);
  }
});
