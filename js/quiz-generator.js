import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, collection, deleteDoc, doc, getDocs, query, setDoc, where } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBwH8D-mJSpjqu_C7Y7e7ljCjSZiO7FTm0",
  authDomain: "imars-db-a733b.firebaseapp.com",
  projectId: "imars-db-a733b",
  storageBucket: "imars-db-a733b.firebasestorage.app",
  messagingSenderId: "539058786779",
  appId: "1:539058786779:web:201076a476a471a0bdd7fe",
  measurementId: "G-TEERTREQF3"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const firestore = getFirestore(firebaseApp);

(() => {
  const sectionSelect = document.getElementById("quizSection");
  const fileInput = document.getElementById("quizFile");
  const dropzone = document.getElementById("quizDropzone");
  const selectedFileRow = document.getElementById("selectedFileRow");
  const setupStatus = document.getElementById("setupStatus");
  const editorStatus = document.getElementById("editorStatus");
  const suggestionList = document.getElementById("suggestionsList");
  const editorList = document.getElementById("questionEditorList");
  const libraryList = document.getElementById("quizLibraryList");
  const createView = document.getElementById("createView");
  const libraryView = document.getElementById("libraryView");
  const setupStep = document.getElementById("setupStep");
  const reviewStep = document.getElementById("reviewStep");
  const editorStep = document.getElementById("editorStep");
  let libraryStorageKey = "imars-generated-quizzes:anonymous";
  let selectedFile = null;
  let teacherProfileId = null;
  let quizCache = [];
  let difficulty = "Medium";
  let generatedQuestions = [];
  let editorQuestions = [];
  let editingQuizId = null;

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    })[character]);
  }

  function makeId() {
    return "quiz-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function loadSections() {
    sectionSelect.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Sign in to load your sections";
    sectionSelect.append(placeholder);
  }

  async function loadTeacherSections(user) {
    teacherProfileId = null;
    if (!user) {
      loadSections();
      showStatus(setupStatus, "Sign in with your teacher account to generate a quiz.", true);
      return;
    }

    try {
      const userSnapshot = await getDocs(query(collection(firestore, "users"), where("uid", "==", user.uid)));
      const teacherDocument = userSnapshot.docs.find((entry) => String(entry.data().role || "").toLowerCase() === "teacher");
      if (!teacherDocument) throw new Error("This account does not have a teacher profile.");
      teacherProfileId = teacherDocument.id;

      const classSnapshot = await getDocs(query(collection(firestore, "classes"), where("teacherId", "==", teacherProfileId)));
      sectionSelect.replaceChildren();
      classSnapshot.docs.forEach((classDocument) => {
        const data = classDocument.data();
        const option = document.createElement("option");
        option.value = classDocument.id;
        option.textContent = data.SectionName || classDocument.id;
        sectionSelect.append(option);
      });
      if (!classSnapshot.size) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No sections are assigned to your account";
        sectionSelect.append(option);
        showStatus(setupStatus, "Your teacher account has no assigned sections yet.", true);
      } else {
        showStatus(setupStatus, "", false);
      }
    } catch (error) {
      loadSections();
      showStatus(setupStatus, error.message || "Your teacher sections could not be loaded.", true);
    }
  }

  async function loadTeacherQuizzes(user) {
    try {
      const snapshot = await getDocs(query(collection(firestore, "generatedQuizzes"), where("teacherUid", "==", user.uid)));
      const quizzes = snapshot.docs.map((quizDocument) => ({ ...quizDocument.data(), id: quizDocument.id }));
      saveQuizzes(quizzes);
      renderLibrary();
    } catch (error) {
      console.error("Could not load this teacher's quizzes:", error);
      showStatus(document.getElementById("libraryStatus"), "Firebase could not load quizzes. Check the Firestore rules for the generatedQuizzes collection.", true);
    }
  }

  function selectedSectionName() {
    return sectionSelect.selectedOptions[0]?.textContent || "";
  }

  function fileExtension(file) {
    return file.name.split(".").pop().toLowerCase();
  }

  function base64FromBytes(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  async function readOfficeZipEntry(file, acceptedEntry) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let endRecord = -1;
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) {
        const commentLength = view.getUint16(offset + 20, true);
        if (offset + 22 + commentLength === bytes.length) {
          endRecord = offset;
          break;
        }
      }
    }
    if (endRecord < 0) throw new Error("This file is not a readable Office document. Save it as DOCX or PPTX and try again.");

    const entryCount = view.getUint16(endRecord + 10, true);
    if (entryCount > 2000) throw new Error("This Office file has too many parts to process.");
    let cursor = view.getUint32(endRecord + 16, true);
    const decoder = new TextDecoder();
    const entries = [];
    for (let index = 0; index < entryCount; index += 1) {
      if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("This Office file has an unsupported ZIP layout.");
      const method = view.getUint16(cursor + 10, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const expandedSize = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const nameStart = cursor + 46;
      const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
      cursor = nameStart + nameLength + extraLength + commentLength;
      if (!acceptedEntry(name)) continue;
      if (expandedSize > 12 * 1024 * 1024) throw new Error("This Office file has too much text to process. Try a smaller file.");

      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("This Office file could not be opened.");
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
      let expanded;
      if (method === 0) expanded = compressed;
      else if (method === 8 && typeof DecompressionStream !== "undefined") {
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        expanded = new Uint8Array(await new Response(stream).arrayBuffer());
      } else {
        throw new Error("This Office file uses a compression format this browser cannot read.");
      }
      entries.push({ name, text: decoder.decode(expanded) });
    }
    return entries;
  }

  async function extractOfficeText(file) {
    const extension = fileExtension(file);
    if (extension === "ppt") throw new Error("Older .ppt files are not supported yet. Open the presentation and save a copy as .pptx or PDF.");

    const entries = extension === "docx"
      ? await readOfficeZipEntry(file, (name) => name === "word/document.xml")
      : await readOfficeZipEntry(file, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    if (!entries.length) throw new Error("No readable text was found in this file.");

    const orderedEntries = entries.sort((left, right) => {
      const leftNumber = Number(left.name.match(/slide(\d+)\.xml$/)?.[1] || 0);
      const rightNumber = Number(right.name.match(/slide(\d+)\.xml$/)?.[1] || 0);
      return leftNumber - rightNumber;
    });
    const namespace = extension === "docx"
      ? "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
      : "http://schemas.openxmlformats.org/drawingml/2006/main";
    const text = orderedEntries.map((entry) => {
      const xml = new DOMParser().parseFromString(entry.text, "application/xml");
      if (xml.querySelector("parsererror")) throw new Error("Text in this Office file could not be read.");
      return Array.from(xml.getElementsByTagNameNS(namespace, "t"), (node) => node.textContent || "").join(" ");
    }).join("\n").trim();
    if (!text) throw new Error("No readable text was found in this file.");
    if (text.length > 120000) throw new Error("This file contains too much text. Try a shorter file or split it into parts.");
    return text;
  }

  async function prepareMaterial(file) {
    const extension = fileExtension(file);
    if (extension === "pdf") {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { fileMimeType: "application/pdf", fileBase64: base64FromBytes(bytes) };
    }
    return { fileMimeType: "text/plain", sourceText: await extractOfficeText(file) };
  }

  function loadQuizzes() {
    return quizCache.slice();
  }

  function saveQuizzes(quizzes) {
    quizCache = Array.isArray(quizzes) ? quizzes : [];
    try {
      localStorage.setItem(libraryStorageKey, JSON.stringify(quizCache));
      return true;
    } catch (error) {
      return true;
    }
  }

  function setView(view) {
    const showLibrary = view === "library";
    createView.hidden = showLibrary;
    libraryView.hidden = !showLibrary;
    document.getElementById("createTab").classList.toggle("active", !showLibrary);
    document.getElementById("libraryTab").classList.toggle("active", showLibrary);
    document.getElementById("createTab").setAttribute("aria-selected", String(!showLibrary));
    document.getElementById("libraryTab").setAttribute("aria-selected", String(showLibrary));
    if (showLibrary) renderLibrary();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setStep(step) {
    setupStep.hidden = step !== "setup";
    reviewStep.hidden = step !== "review";
    editorStep.hidden = step !== "editor";
    document.querySelectorAll("[data-step-indicator]").forEach((item) => {
      const order = ["setup", "review", "editor"];
      const currentIndex = order.indexOf(step);
      const itemIndex = order.indexOf(item.dataset.stepIndicator);
      item.classList.toggle("active", itemIndex === currentIndex);
      item.classList.toggle("done", itemIndex < currentIndex);
    });
    if (step === "review") renderSuggestions();
    if (step === "editor") renderEditor();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showStatus(element, message, isError) {
    element.textContent = message || "";
    element.classList.toggle("error", Boolean(isError));
  }

  function handleFile(file) {
    if (!file) return;
    const extension = fileExtension(file);
    const supported = ["pdf", "docx", "ppt", "pptx"];
    if (!supported.includes(extension)) {
      selectedFile = null;
      selectedFileRow.hidden = true;
      fileInput.value = "";
      showStatus(setupStatus, "Please select a PDF, DOCX, PPT, or PPTX file.", true);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      selectedFile = null;
      selectedFileRow.hidden = true;
      fileInput.value = "";
      showStatus(setupStatus, "Please choose a file smaller than 10 MB.", true);
      return;
    }
    selectedFile = file;
    document.getElementById("selectedFileName").textContent = file.name;
    document.getElementById("fileTypeBadge").textContent = extension.toUpperCase();
    selectedFileRow.hidden = false;
    showStatus(setupStatus, "", false);
    const titleInput = document.getElementById("quizTitle");
    if (!titleInput.value.trim()) titleInput.value = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
  }

  function validateSetup() {
    const title = document.getElementById("quizTitle").value.trim();
    const countInput = document.getElementById("questionCount");
    const count = Number(countInput.value);
    if (!selectedFile) return "Upload a PDF, DOCX, PPT, or PPTX file to continue.";
    if (!title) return "Add a title for this quiz.";
    if (!sectionSelect.value) return "Choose a section for this quiz.";
    if (!Number.isInteger(count) || count < 1 || count > 50) return "Choose between 1 and 50 questions.";
    return "";
  }

  async function startGeneration() {
    const error = validateSetup();
    if (error) {
      showStatus(setupStatus, error, true);
      return;
    }
    if (!auth.currentUser) {
      showStatus(setupStatus, "Sign in with your teacher account before generating a quiz.", true);
      return;
    }
    const button = document.getElementById("generateQuiz");
    const buttonText = button.querySelector("span");
    const loadingOverlay = document.getElementById("quizGenerationOverlay");
    const loadingTitle = document.getElementById("quizGenerationTitle");
    const loadingDetail = document.getElementById("quizGenerationDetail");
    const originalText = buttonText.textContent;
    button.disabled = true;
    buttonText.textContent = "Reading file…";
    loadingTitle.textContent = "Preparing your file";
    loadingDetail.textContent = "Please wait while we read your learning material.";
    loadingOverlay.hidden = false;
    loadingOverlay.setAttribute("aria-busy", "true");
    showStatus(setupStatus, "Preparing your learning material…", false);
    try {
      const material = await prepareMaterial(selectedFile);
      const user = auth.currentUser;
      if (!user) throw new Error("Your sign-in expired. Please sign in again.");
      buttonText.textContent = "Generating questions…";
      loadingTitle.textContent = "Generating your quiz";
      loadingDetail.textContent = "Please wait while we prepare your questions.";
      showStatus(setupStatus, "AI is reading the material and creating your questions…", false);

      const response = await fetch("/api/generate-quiz", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + await user.getIdToken()
        },
        body: JSON.stringify({
          ...material,
          firebaseApiKey: firebaseConfig.apiKey,
          fileName: selectedFile.name,
          sectionId: sectionSelect.value,
          questionCount: Number(document.getElementById("questionCount").value),
          difficulty,
          questionType: document.querySelector("input[name='questionType']:checked").value
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Quiz generation failed. Please try again.");
      if (!Array.isArray(result.questions) || result.questions.length === 0) throw new Error("The question generator returned no questions. Please try again.");

      generatedQuestions = result.questions.map((question) => ({
        ...question,
        id: makeId(),
        accepted: false,
        discarded: false
      }));
      document.getElementById("reviewSummary").dataset.requested = "";
      document.getElementById("demoNotice").hidden = false;
      showStatus(setupStatus, "", false);
      setStep("review");
    } catch (generationError) {
      showStatus(setupStatus, generationError.message || "Quiz generation failed. Please try again.", true);
    } finally {
      loadingOverlay.hidden = true;
      loadingOverlay.setAttribute("aria-busy", "false");
      button.disabled = false;
      buttonText.textContent = originalText;
    }
  }

  function updateReviewCount() {
    const available = generatedQuestions.filter((question) => !question.discarded).length;
    const accepted = generatedQuestions.filter((question) => question.accepted && !question.discarded).length;
    const requested = Number(document.getElementById("reviewSummary").dataset.requested || 0);
    document.getElementById("reviewSummary").innerHTML = "<span><strong>" + available + " AI suggestions</strong> for “" + escapeHtml(selectedFile ? selectedFile.name : "your file") + "”</span><span>" + escapeHtml(difficulty) + " · " + (document.querySelector("input[name='questionType']:checked").value === "multiple-choice" ? "Multiple choice" : "True or false") + "</span>";
    if (requested > available) {
      document.getElementById("reviewSummary").innerHTML += "<span>Requested " + requested + " questions.</span>";
    }
    document.getElementById("acceptedCount").textContent = accepted + " accepted";
    const button = document.getElementById("acceptAll");
    button.disabled = accepted === 0 && available === 0;
    button.innerHTML = accepted > 0 && accepted < available
      ? "Continue with selected (" + accepted + ") <span aria-hidden='true'>→</span>"
      : "Accept all (" + available + ") <span aria-hidden='true'>→</span>";
  }

  function renderSuggestions() {
    const type = document.querySelector("input[name='questionType']:checked").value;
    suggestionList.innerHTML = generatedQuestions.map((question, index) => {
      const answerMarkup = question.options.map((option, optionIndex) => {
        const label = type === "multiple-choice" ? String.fromCharCode(65 + optionIndex) : "";
        return "<div class='quiz-suggestion-answer " + (optionIndex === question.correctIndex ? "correct" : "") + "'><b>" + label + "</b>" + escapeHtml(option) + (optionIndex === question.correctIndex ? " · Correct answer" : "") + "</div>";
      }).join("");
      const cardClass = "quiz-suggestion-card" + (question.discarded ? " is-discarded" : "");
      const status = question.discarded ? "Discarded" : question.accepted ? "Accepted" : "New";
      const actionMarkup = question.discarded
        ? "<button class='restore' type='button' data-restore='" + question.id + "'>Restore</button>"
        : "<button class='accept' type='button' data-accept='" + question.id + "' aria-pressed='" + question.accepted + "'>" + (question.accepted ? "Accepted ✓" : "Accept") + "</button><button type='button' data-discard='" + question.id + "' aria-label='Discard question " + (index + 1) + "'>Discard</button>";
      return "<article class='" + cardClass + "' data-question-card='" + question.id + "'><div class='quiz-suggestion-top'><span class='quiz-question-number'>" + String(index + 1).padStart(2, "0") + "</span><span class='quiz-new-pill'>" + status + "</span><div class='quiz-suggestion-actions'>" + actionMarkup + "</div></div><div class='quiz-suggestion-content'><p class='quiz-suggestion-question'>" + escapeHtml(question.text) + "</p><div class='quiz-suggestion-answers'>" + answerMarkup + "</div></div></article>";
    }).join("");
    updateReviewCount();
  }

  function enterEditor(acceptedOnly) {
    const accepted = generatedQuestions.filter((question) => question.accepted && !question.discarded);
    if (!accepted.length) {
      generatedQuestions.forEach((question) => { question.accepted = !question.discarded; });
    }
    const ready = generatedQuestions.filter((question) => question.accepted && !question.discarded);
    if (!ready.length) {
      showStatus(setupStatus, "Accept at least one question before continuing.", true);
      return;
    }
    editorQuestions = ready.map((question) => ({ id: makeId(), text: question.text, options: question.options.slice(), correctIndex: question.correctIndex }));
    editingQuizId = null;
    document.getElementById("editorTitle").value = document.getElementById("quizTitle").value.trim();
    document.getElementById("editorSectionName").textContent = selectedSectionName();
    document.getElementById("editorMeta").textContent = editorQuestions.length + " questions · " + difficulty + " · " + (document.querySelector("input[name='questionType']:checked").value === "multiple-choice" ? "Multiple choice" : "True or false");
    document.getElementById("editorDemoNotice").hidden = false;
    document.getElementById("backToReview").hidden = false;
    document.querySelector("input[name='availability'][value='draft']").checked = true;
    updateReleaseSelection();
    setStep("editor");
  }

  function renderEditor() {
    const type = document.querySelector("input[name='questionType']:checked").value;
    editorList.innerHTML = editorQuestions.map((question, index) => {
      const controls = "<div class='quiz-question-controls'><button type='button' data-move='up' data-index='" + index + "' aria-label='Move question up' " + (index === 0 ? "disabled" : "") + ">↑</button><button type='button' data-move='down' data-index='" + index + "' aria-label='Move question down' " + (index === editorQuestions.length - 1 ? "disabled" : "") + ">↓</button><button class='delete' type='button' data-delete-question='" + index + "' aria-label='Delete question'>×</button></div>";
      let answers;
      if (type === "multiple-choice") {
        answers = question.options.map((option, optionIndex) => "<label class='quiz-option-row'><input type='radio' name='correct-" + question.id + "' data-correct-index='" + optionIndex + "' data-question-index='" + index + "' " + (question.correctIndex === optionIndex ? "checked" : "") + " aria-label='Mark option " + String.fromCharCode(65 + optionIndex) + " as correct' /><input class='quiz-option-input' type='text' maxlength='240' data-option-index='" + optionIndex + "' data-question-index='" + index + "' value='" + escapeHtml(option) + "' aria-label='Answer option " + String.fromCharCode(65 + optionIndex) + "' /></label>").join("");
      } else {
        answers = question.options.map((option, optionIndex) => "<label class='quiz-option-row'><input type='radio' name='correct-" + question.id + "' data-correct-index='" + optionIndex + "' data-question-index='" + index + "' " + (question.correctIndex === optionIndex ? "checked" : "") + " aria-label='Mark " + escapeHtml(option) + " as correct' /><span class='quiz-option-input'>" + escapeHtml(option) + "</span></label>").join("");
      }
      return "<article class='quiz-question-card'><div class='quiz-question-card-head'><strong>Question " + (index + 1) + "</strong><span class='quiz-q-badge'>" + (type === "multiple-choice" ? "Multiple choice" : "True or false") + "</span>" + controls + "</div><textarea class='quiz-question-input' rows='2' maxlength='500' data-question-text='" + index + "' aria-label='Question " + (index + 1) + " text'>" + escapeHtml(question.text) + "</textarea><div class='quiz-option-editor'>" + answers + "</div><p class='quiz-correct-hint'>Select the circle beside the correct answer.</p></article>";
    }).join("");
    document.getElementById("questionLimitText").textContent = editorQuestions.length + " / 50";
    document.getElementById("addQuestion").disabled = editorQuestions.length >= 50;
    document.getElementById("editorMeta").textContent = editorQuestions.length + " questions · " + difficulty + " · " + (type === "multiple-choice" ? "Multiple choice" : "True or false");
  }

  function updateReleaseSelection() {
    document.querySelectorAll(".quiz-release-option").forEach((label) => {
      const radio = label.querySelector("input");
      label.classList.toggle("selected", radio.checked);
    });
    const scheduleSelected = document.querySelector("input[name='availability']:checked").value === "scheduled";
    document.getElementById("scheduleFields").hidden = !scheduleSelected;
  }

  async function saveCurrentQuiz() {
    showStatus(editorStatus, "", false);
    const title = document.getElementById("editorTitle").value.trim();
    if (!title) {
      showStatus(editorStatus, "Add a title before saving this quiz.", true);
      document.getElementById("editorTitle").focus();
      return;
    }
    if (editorQuestions.length < 1 || editorQuestions.length > 50) {
      showStatus(editorStatus, "A quiz must have between 1 and 50 questions.", true);
      return;
    }
    const incompleteQuestion = editorQuestions.some((question) => !question.text.trim() || question.options.some((option) => !String(option).trim()));
    if (incompleteQuestion) {
      showStatus(editorStatus, "Complete every question and answer choice before saving.", true);
      return;
    }
    const availability = document.querySelector("input[name='availability']:checked").value;
    const availableAt = document.getElementById("availableAt").value;
    if (availability === "scheduled" && !availableAt) {
      showStatus(editorStatus, "Choose the date and time when the quiz should unlock.", true);
      document.getElementById("availableAt").focus();
      return;
    }
    if (availability === "scheduled" && new Date(availableAt).getTime() <= Date.now()) {
      showStatus(editorStatus, "Choose a future date and time for the quiz to unlock.", true);
      document.getElementById("availableAt").focus();
      return;
    }
    const signedInUser = auth.currentUser;
    if (!signedInUser || !teacherProfileId) {
      showStatus(editorStatus, "Sign in with a teacher account and choose one of your sections before saving.", true);
      return;
    }
    const quizzes = loadQuizzes();
    const oldQuiz = quizzes.find((quiz) => quiz.id === editingQuizId);
    const quiz = {
      id: editingQuizId || makeId(),
      title: title,
      section: selectedSectionName(),
      sectionId: sectionSelect.value,
      sourceFile: selectedFile ? selectedFile.name : (oldQuiz ? oldQuiz.sourceFile : "Uploaded source"),
      type: document.querySelector("input[name='questionType']:checked").value,
      difficulty: difficulty,
      questions: editorQuestions.map((question) => ({ id: question.id, text: question.text, options: question.options.slice(), correctIndex: question.correctIndex })),
      availability: availability,
      availableAt: availability === "scheduled" ? new Date(availableAt).toISOString() : "",
      createdAt: oldQuiz ? oldQuiz.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      demo: false
    };
    const saveButton = document.getElementById("saveQuiz");
    saveButton.disabled = true;
    try {
      await setDoc(doc(firestore, "generatedQuizzes", quiz.id), {
        ...quiz,
        teacherUid: signedInUser.uid,
        teacherProfileId
      });
    } catch (error) {
      console.error("Could not save quiz to Firestore:", error);
      showStatus(editorStatus, "Firebase blocked this save. The Firestore rules must allow teachers to save their own quizzes.", true);
      return;
    } finally {
      saveButton.disabled = false;
    }
    const existingIndex = quizzes.findIndex((item) => item.id === quiz.id);
    if (existingIndex >= 0) quizzes[existingIndex] = quiz;
    else quizzes.unshift(quiz);
    saveQuizzes(quizzes);
    renderLibrary();
    resetNewQuiz();
    setView("library");
    showStatus(document.getElementById("libraryStatus"), "Quiz saved to Firebase. " + availabilityText(quiz) + ".", false);
  }

  function availabilityText(quiz) {
    if (quiz.availability === "now") return "Marked available for " + quiz.section;
    if (quiz.availability === "scheduled") return "It is locked until " + formatDate(quiz.availableAt);
    return "It is saved as a locked draft";
  }

  function formatDate(value) {
    if (!value) return "a scheduled time";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "a scheduled time";
    return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  function toLocalDateTimeInput(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 16);
  }

  function currentAvailability(quiz) {
    if (quiz.availability === "scheduled" && quiz.availableAt && new Date(quiz.availableAt).getTime() <= Date.now()) return "now";
    return quiz.availability || "draft";
  }

  function renderLibrary() {
    const quizzes = loadQuizzes().sort((left, right) => new Date(right.updatedAt || right.createdAt) - new Date(left.updatedAt || left.createdAt));
    const count = String(quizzes.length);
    document.getElementById("libraryCount").textContent = count;
    document.getElementById("libraryTabCount").textContent = count;
    document.getElementById("emptyLibrary").hidden = quizzes.length > 0;
    libraryList.hidden = quizzes.length === 0;
    libraryList.innerHTML = quizzes.map((quiz) => {
      const status = currentAvailability(quiz);
      const statusLabel = status === "now" ? "Available" : status === "scheduled" ? "Scheduled · locked" : "Draft · locked";
      const statusClass = status === "now" ? "available" : status === "scheduled" ? "scheduled" : "";
      const availability = status === "scheduled" ? "Unlocks " + escapeHtml(formatDate(quiz.availableAt)) : status === "now" ? "Available now" : "Only visible to you";
      return "<article class='quiz-library-card'><div class='quiz-library-main'><div class='quiz-library-title-row'><h3>" + escapeHtml(quiz.title) + "</h3><span class='quiz-status-badge " + statusClass + "'>" + statusLabel + "</span></div><div class='quiz-library-details'><span>" + escapeHtml(quiz.section) + "</span><span>" + (quiz.questions || []).length + " questions</span><span>" + (quiz.type === "true-false" ? "True or false" : "Multiple choice") + "</span><span>" + availability + "</span></div></div><div class='quiz-library-actions'><button type='button' data-edit-quiz='" + escapeHtml(quiz.id) + "'>Edit</button><button class='delete' type='button' data-delete-quiz='" + escapeHtml(quiz.id) + "'>Delete</button></div></article>";
    }).join("");
  }

  function editQuiz(id) {
    const quiz = loadQuizzes().find((item) => item.id === id);
    if (!quiz) return;
    editingQuizId = quiz.id;
    editorQuestions = (quiz.questions || []).map((question) => ({
      id: question.id || makeId(),
      text: question.text || "",
      options: Array.isArray(question.options) ? question.options.slice() : ["", "", "", ""],
      correctIndex: Number.isInteger(question.correctIndex) ? question.correctIndex : 0
    }));
    selectedFile = null;
    fileInput.value = "";
    selectedFileRow.hidden = true;
    document.getElementById("editorTitle").value = quiz.title || "";
    document.getElementById("editorSectionName").textContent = quiz.section || "";
    document.getElementById("editorDemoNotice").hidden = !quiz.demo;
    document.getElementById("backToReview").hidden = true;
    document.getElementById("quizTitle").value = quiz.title || "";
    const matchingSection = Array.from(sectionSelect.options).some((option) => option.value === quiz.sectionId);
    if (matchingSection) sectionSelect.value = quiz.sectionId;
    difficulty = quiz.difficulty || "Medium";
    document.querySelectorAll("[data-difficulty]").forEach((button) => {
      const selected = button.dataset.difficulty === difficulty;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    document.querySelector("input[name='questionType'][value='" + (quiz.type || "multiple-choice") + "']").checked = true;
    const availability = currentAvailability(quiz);
    document.querySelector("input[name='availability'][value='" + availability + "']").checked = true;
    document.getElementById("availableAt").value = availability === "scheduled" ? toLocalDateTimeInput(quiz.availableAt) : "";
    updateReleaseSelection();
    document.getElementById("editorMeta").textContent = editorQuestions.length + " questions";
    setView("create");
    setStep("editor");
  }

  function resetNewQuiz() {
    selectedFile = null;
    generatedQuestions = [];
    editorQuestions = [];
    editingQuizId = null;
    fileInput.value = "";
    selectedFileRow.hidden = true;
    document.getElementById("quizTitle").value = "";
    document.getElementById("questionCount").value = "10";
    document.querySelector("input[name='questionType'][value='multiple-choice']").checked = true;
    document.querySelectorAll("[data-difficulty]").forEach((button) => {
      const selected = button.dataset.difficulty === "Medium";
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    difficulty = "Medium";
    document.querySelector("input[name='availability'][value='draft']").checked = true;
    document.getElementById("availableAt").value = "";
    updateReleaseSelection();
    showStatus(setupStatus, "", false);
    showStatus(editorStatus, "", false);
    setView("create");
    setStep("setup");
  }

  loadSections();
  renderLibrary();
  onAuthStateChanged(auth, async (user) => {
    libraryStorageKey = user ? "imars-generated-quizzes:" + user.uid : "imars-generated-quizzes:anonymous";
    quizCache = [];
    renderLibrary();
    await loadTeacherSections(user);
    if (user && teacherProfileId) await loadTeacherQuizzes(user);
  });

  fileInput.addEventListener("change", () => handleFile(fileInput.files[0]));
  document.getElementById("removeFile").addEventListener("click", (event) => {
    event.preventDefault();
    selectedFile = null;
    fileInput.value = "";
    selectedFileRow.hidden = true;
    showStatus(setupStatus, "", false);
  });
  dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("drag-over"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("drag-over");
    handleFile(event.dataTransfer.files[0]);
  });
  dropzone.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target === dropzone) {
      event.preventDefault();
      fileInput.click();
    }
  });
  document.getElementById("generateQuiz").addEventListener("click", startGeneration);
  document.getElementById("questionCount").addEventListener("change", (event) => {
    const input = event.target;
    const count = Math.min(50, Math.max(1, Number(input.value) || 1));
    input.value = String(count);
  });
  document.querySelectorAll("[data-count-change]").forEach((button) => button.addEventListener("click", () => {
    const input = document.getElementById("questionCount");
    input.value = String(Math.min(50, Math.max(1, Number(input.value) + Number(button.dataset.countChange))));
  }));
  document.querySelectorAll("[data-difficulty]").forEach((button) => button.addEventListener("click", () => {
    difficulty = button.dataset.difficulty;
    document.querySelectorAll("[data-difficulty]").forEach((choice) => {
      const selected = choice === button;
      choice.classList.toggle("selected", selected);
      choice.setAttribute("aria-pressed", String(selected));
    });
  }));
  document.querySelectorAll("input[name='questionType']").forEach((radio) => radio.addEventListener("change", () => {
    document.querySelectorAll(".quiz-type-option").forEach((label) => label.classList.toggle("selected", label.querySelector("input").checked));
  }));
  document.getElementById("suggestionsList").addEventListener("click", (event) => {
    const accept = event.target.closest("[data-accept]");
    const discard = event.target.closest("[data-discard]");
    const restore = event.target.closest("[data-restore]");
    const id = (accept && accept.dataset.accept) || (discard && discard.dataset.discard) || (restore && restore.dataset.restore);
    if (!id) return;
    const question = generatedQuestions.find((item) => item.id === id);
    if (!question) return;
    if (accept) { question.accepted = !question.accepted; question.discarded = false; }
    if (discard) { question.accepted = false; question.discarded = true; }
    if (restore) { question.discarded = false; question.accepted = false; }
    renderSuggestions();
  });
  document.getElementById("acceptAll").addEventListener("click", () => enterEditor(true));
  document.getElementById("discardAll").addEventListener("click", () => {
    if (!window.confirm("Discard all suggested questions and start over?")) return;
    generatedQuestions = [];
    setStep("setup");
  });
  document.getElementById("backToReview").addEventListener("click", () => setStep("review"));
  editorList.addEventListener("input", (event) => {
    const questionIndex = Number(event.target.dataset.questionText !== undefined ? event.target.dataset.questionText : event.target.dataset.questionIndex);
    const question = editorQuestions[questionIndex];
    if (!question) return;
    if (event.target.dataset.questionText !== undefined) question.text = event.target.value;
    if (event.target.dataset.optionIndex !== undefined) question.options[Number(event.target.dataset.optionIndex)] = event.target.value;
  });
  editorList.addEventListener("change", (event) => {
    if (event.target.dataset.correctIndex === undefined) return;
    const question = editorQuestions[Number(event.target.dataset.questionIndex)];
    if (question) question.correctIndex = Number(event.target.dataset.correctIndex);
  });
  editorList.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-delete-question]");
    if (remove) {
      editorQuestions.splice(Number(remove.dataset.deleteQuestion), 1);
      renderEditor();
      return;
    }
    const move = event.target.closest("[data-move]");
    if (move) {
      const index = Number(move.dataset.index);
      const destination = move.dataset.move === "up" ? index - 1 : index + 1;
      if (destination < 0 || destination >= editorQuestions.length) return;
      const [question] = editorQuestions.splice(index, 1);
      editorQuestions.splice(destination, 0, question);
      renderEditor();
    }
  });
  document.getElementById("addQuestion").addEventListener("click", () => {
    if (editorQuestions.length >= 50) return;
    const type = document.querySelector("input[name='questionType']:checked").value;
    editorQuestions.push({
      id: makeId(),
      text: "",
      options: type === "true-false" ? ["True", "False"] : ["", "", "", ""],
      correctIndex: 0
    });
    renderEditor();
    editorList.lastElementChild.querySelector("textarea").focus();
  });
  document.querySelectorAll("input[name='availability']").forEach((radio) => radio.addEventListener("change", updateReleaseSelection));
  document.getElementById("saveQuiz").addEventListener("click", saveCurrentQuiz);
  document.getElementById("createTab").addEventListener("click", () => setView("create"));
  document.getElementById("libraryTab").addEventListener("click", () => setView("library"));
  document.getElementById("openLibrary").addEventListener("click", () => setView("library"));
  document.getElementById("newQuizFromLibrary").addEventListener("click", resetNewQuiz);
  document.getElementById("emptyCreateQuiz").addEventListener("click", resetNewQuiz);
  libraryList.addEventListener("click", async (event) => {
    const edit = event.target.closest("[data-edit-quiz]");
    const remove = event.target.closest("[data-delete-quiz]");
    if (edit) editQuiz(edit.dataset.editQuiz);
    if (remove) {
      const id = remove.dataset.deleteQuiz;
      if (!window.confirm("Delete this quiz from your library?")) return;
      try {
        await deleteDoc(doc(firestore, "generatedQuizzes", id));
        saveQuizzes(loadQuizzes().filter((quiz) => quiz.id !== id));
        showStatus(document.getElementById("libraryStatus"), "Quiz deleted.", false);
        renderLibrary();
      } catch (error) {
        console.error("Could not delete quiz from Firestore:", error);
        showStatus(document.getElementById("libraryStatus"), "Firebase blocked the delete. Check the Firestore rules for the generatedQuizzes collection.", true);
      }
    }
  });

})();
