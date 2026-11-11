import { initializeApp } from "./firebase-auth.js";
import { getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { closeQuizReview, openQuizReview } from "./quiz-review.js";
import { getFirestore, collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from "./firebase-data.js";
import { discardQuizJob, readQuizJob, requestQuiz } from "./quiz-request.js";
import { setLoadingState, revealContent } from "./loading.js";
import { quizFileSizeError, questionTypeLabel, writtenQuestion, normalizeQuizQuestion, quizAssignmentScope, quizAssignedToSection } from "./quiz-limits.js";
import { extractOfficeText } from "./quiz-office.js";
import { showTeacherView } from "./teacher-view.js";
import { confirmAction } from "./confirm-action.js";

const firebaseApp = initializeApp();
const auth = getAuth(firebaseApp);
const firestore = getFirestore(firebaseApp);

(() => {
  const fileInput = document.getElementById("quizFile");
  const generateButton = document.getElementById("generateQuiz");
  const generationDialog = document.getElementById("quizGenerationStatusCard");
  generationDialog.addEventListener("cancel", event => event.preventDefault());
  const dropzone = document.getElementById("quizDropzone");
  const selectedFileRow = document.getElementById("selectedFileRow");
  const fileError = document.getElementById("quizFileError");
  const setupStatus = document.getElementById("setupStatus");
  const editorStatus = document.getElementById("editorStatus");
  const suggestionList = document.getElementById("suggestionsList");
  const editorList = document.getElementById("questionEditorList");
  const libraryList = document.getElementById("quizLibraryList");
  const librarySectionFilter = document.getElementById("librarySectionFilter");
  const createView = document.getElementById("createView");
  const libraryView = document.getElementById("libraryView");
  const setupStep = document.getElementById("setupStep");
  const reviewStep = document.getElementById("reviewStep");
  const editorStep = document.getElementById("editorStep");
  let selectedFile = null;
  let teacherProfileId = null;
  let teacherSections = [];
  let quizCache = [];
  let difficulty = "Medium";
  let generatedQuestions = [];
  let editorQuestions = [];
  let editingQuiz = null;
  let editRequest = 0;
  let expandedScheduleQuizId = null;
  let scheduleBusy = false;
  let generating = false;
  let backgroundJob;
  let reviewedJob;
  let jobTimer;
  let jobCheck = 0;
  const activeJob = () => ["queued", "running"].includes(backgroundJob?.status);
  const updateGenerateButton = () => { generateButton.disabled = generating || activeJob() || backgroundJob?.status === "complete" || !selectedFile; };
  const jobStatus = document.getElementById("quizJobStatus");
  const jobMessage = document.getElementById("quizJobMessage");
  const reviewJob = document.getElementById("reviewQuizJob");

  function renderJob() {
    const status = backgroundJob?.status;
    jobStatus.hidden = !status || status === "none" || (status === "complete" && reviewedJob?.id === backgroundJob.id);
    reviewJob.hidden = status !== "complete";
    jobMessage.textContent = status === "complete" ? "Your quiz is ready to review."
      : status === "failed" ? backgroundJob.error : "Your quiz is generating. You can visit another page and come back here.";
    updateGenerateButton();
  }

  async function refreshJob(user) {
    clearTimeout(jobTimer);
    const check = ++jobCheck;
    try {
      const result = await readQuizJob(user.uid);
      if (check !== jobCheck || auth.currentUser?.uid !== user.uid) return;
      backgroundJob = result;
      renderJob();
    } catch {
      if (check !== jobCheck || auth.currentUser?.uid !== user.uid) return;
      if (activeJob()) jobMessage.textContent = "Reconnecting to check quiz progress…";
    }
    if (activeJob()) jobTimer = setTimeout(() => { void refreshJob(user); }, 5000);
  }

  function openQuestions(questions) {
    generatedQuestions = questions.map(question => ({ ...question, id: makeId(), accepted: false, discarded: false }));
    document.getElementById("reviewSummary").dataset.requested = "";
    document.getElementById("demoNotice").hidden = false;
    showStatus(setupStatus, "", false);
    setStep("review");
  }

  reviewJob.addEventListener("click", () => {
    if (backgroundJob?.status !== "complete" || !Array.isArray(backgroundJob.questions)) return;
    const { title, questionType, difficulty: level } = backgroundJob.details;
    resetNewQuiz();
    reviewedJob = backgroundJob;
    document.getElementById("quizTitle").value = title;
    const type = document.querySelector(`input[name='questionType'][value='${questionType}']`);
    if (type) type.checked = true;
    difficulty = level;
    updateTypeSelection();
    renderJob();
    openQuestions(backgroundJob.questions);
  });
  window.addEventListener("pagehide", () => {
    ++jobCheck;
    clearTimeout(jobTimer);
  });

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    })[character]);
  }

  function makeId() {
    return "quiz-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function loadSections() {
    teacherSections = [];
    renderSectionFilter();
  }

  function renderSectionFilter() {
    const selected = librarySectionFilter.value;
    librarySectionFilter.innerHTML = '<option value="">All sections</option>' + teacherSections.map(section => `<option value="${escapeHtml(section.id)}">${escapeHtml(section.name)}</option>`).join("");
    librarySectionFilter.value = teacherSections.some(section => section.id === selected) ? selected : "";
    librarySectionFilter.disabled = teacherSections.length === 0 || scheduleBusy;
  }

  async function loadTeacherSections(user) {
    teacherProfileId = null;
    if (!user) {
      loadSections();
      showStatus(setupStatus, "Sign in with your teacher account to generate a quiz.", true);
      return;
    }

    try {
      teacherProfileId = user.role === "teacher" ? user.id : null;
      if (!teacherProfileId) {
        const userSnapshot = await getDocs(query(collection(firestore, "users"), where("uid", "==", user.uid)));
        const teacherDocument = userSnapshot.docs.find((entry) => String(entry.data().role || "").toLowerCase() === "teacher");
        if (!teacherDocument) throw new Error("This account does not have a teacher profile.");
        teacherProfileId = teacherDocument.id;
      }

      const classSnapshot = await getDocs(query(collection(firestore, "classes"), where("teacherId", "==", teacherProfileId)));
      teacherSections = classSnapshot.docs.map(classDocument => ({ id: classDocument.id, name: classDocument.data().SectionName || classDocument.id }));
      renderSectionFilter();
      if (!classSnapshot.size) {
        showStatus(setupStatus, "You can save a draft now. Assign a section before releasing it.", false);
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
      await showTeacherView({ app: firebaseApp, user, page: "quiz-library-metadata", freshForMs: 300_000, refreshIntervalMs: 300_000,
        load: async () => {
          const snapshot = await getDocs(query(collection(firestore, "generatedQuizzes"), where("teacherUid", "==", user.uid)));
          return quizSummaries(snapshot.docs.map(row => ({ ...row.data(), id: row.id })));
        }, render: quizzes => {
          saveQuizzes(quizzes);
          if (!expandedScheduleQuizId) renderLibrary();
        }, painted: () => revealContent("quiz-library") });
    } catch (error) {
      console.error("Could not load this teacher's quizzes:", error);
      showStatus(document.getElementById("libraryStatus"), "Could not load quizzes. Please try again.", true);
      revealContent("quiz-library");
    }
  }

  function assignmentLabel(quiz) {
    const scope = quizAssignmentScope(quiz);
    return scope === "all" ? "All my sections" : scope === "section" ? quiz.section : "Not assigned";
  }

  function fileExtension(file) {
    return file.name.split(".").pop().toLowerCase();
  }

  async function prepareMaterial(file) {
    const extension = fileExtension(file);
    if (extension === "pdf") {
      return { fileMimeType: "application/pdf", pdfFile: file };
    }
    return { fileMimeType: "text/plain", sourceText: await extractOfficeText(file) };
  }

  function loadQuizzes() {
    return quizCache.slice();
  }

  function quizSummaries(quizzes) {
    return quizzes.map(({ id, title, section, sectionId, assignmentScope, type, availability, availableAt, questionCount, questions }) => ({
      id, title, section, sectionId, assignmentScope, type, availability, availableAt,
      questionCount: Number.isInteger(questionCount) ? questionCount : (questions?.length || 0)
    }));
  }
  function saveQuizzes(quizzes) { quizCache = quizSummaries(quizzes); }

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
    if (!file || generating) return;
    const extension = fileExtension(file);
    const error = ["pdf", "docx", "ppt", "pptx"].includes(extension)
      ? quizFileSizeError(file.size) : "Please select a PDF, DOCX, PPT, or PPTX file.";
    fileError.textContent = error;
    fileInput.setAttribute("aria-invalid", String(Boolean(error)));
    showStatus(setupStatus, "", false);
    if (error) {
      selectedFile = null;
      updateGenerateButton();
      selectedFileRow.hidden = true;
      fileInput.value = "";
      return;
    }
    selectedFile = file;
    updateGenerateButton();
    document.getElementById("selectedFileName").textContent = file.name;
    document.getElementById("fileTypeBadge").textContent = extension.toUpperCase();
    selectedFileRow.hidden = false;
    const titleInput = document.getElementById("quizTitle");
    if (!titleInput.value.trim()) titleInput.value = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
  }

  function validateSetup() {
    const title = document.getElementById("quizTitle").value.trim();
    const countInput = document.getElementById("questionCount");
    const count = Number(countInput.value);
    if (!selectedFile) return "Upload a PDF, DOCX, PPT, or PPTX file to continue.";
    if (!title) return "Add a title for this quiz.";
    if (!Number.isInteger(count) || count < 1 || count > 50) return "Choose between 1 and 50 questions.";
    return "";
  }

  async function startGeneration() {
    if (generating || activeJob() || backgroundJob?.status === "complete") return;
    const error = validateSetup();
    if (error) {
      showStatus(setupStatus, error, true);
      return;
    }
    const user = auth.currentUser;
    if (!user) {
      showStatus(setupStatus, "Sign in with your teacher account before generating a quiz.", true);
      return;
    }
    const button = generateButton;
    const loadingStatus = document.getElementById("quizGenerationStatus");
    const loadingHint = document.getElementById("quizGenerationHint");
    const file = selectedFile;
    const settings = {
      title: document.getElementById("quizTitle").value.trim(),
      questionCount: Number(document.getElementById("questionCount").value),
      difficulty,
      questionType: document.querySelector("input[name='questionType']:checked").value
    };
    generating = true;
    updateGenerateButton();
    button.setAttribute("aria-busy", "true");
    loadingStatus.textContent = "Preparing your file…";
    loadingHint.textContent = "Larger files and more questions can take longer.";
    const slowMessage = setTimeout(() => {
      loadingHint.textContent = "This is taking longer than usual. Keep this page open while ImARs finishes.";
    }, 15000);
    showStatus(setupStatus, "", false);
    try {
      generationDialog.showModal();
      const material = await prepareMaterial(file);
      if (auth.currentUser?.uid !== user.uid) throw new Error("Your sign-in expired. Please sign in again.");

      loadingStatus.textContent = material.pdfFile ? "Uploading your PDF…" : "Starting quiz generation…";
      const result = await requestQuiz({ ...material, ...settings, fileName: file.name }, user.uid, { background: true });
      if (auth.currentUser?.uid !== user.uid) return;
      if (Array.isArray(result)) openQuestions(result);
      else {
        backgroundJob = { ...result, status: "queued" };
        renderJob();
        void refreshJob(user);
      }
    } catch (generationError) {
      showStatus(setupStatus, generationError.message || "Quiz generation failed. Please try again.", true);
    } finally {
      clearTimeout(slowMessage);
      generating = false;
      updateGenerateButton();
      button.setAttribute("aria-busy", "false");
      generationDialog.close();
    }
  }

  function updateReviewCount() {
    const available = generatedQuestions.filter((question) => !question.discarded).length;
    const accepted = generatedQuestions.filter((question) => question.accepted && !question.discarded).length;
    const requested = Number(document.getElementById("reviewSummary").dataset.requested || 0);
    document.getElementById("reviewSummary").innerHTML = "<span><strong>" + available + " AI suggestions</strong> for “" + escapeHtml(selectedFile ? selectedFile.name : "your file") + "”</span><span>" + escapeHtml(difficulty) + " · " + questionTypeLabel(document.querySelector("input[name='questionType']:checked").value) + "</span>";
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
      let answerMarkup = writtenQuestion(type)
        ? `<div class="quiz-suggestion-answer correct"><b>Answer guide</b>${escapeHtml(question.answer)}</div><div class="quiz-suggestion-answer"><b>${type === "essay" ? "Marking criteria" : "Explanation"}</b>${escapeHtml(type === "essay" ? question.rubric : question.explanation)} · ${question.points} points</div>`
        : question.options.map((option, optionIndex) => {
        const label = type === "multiple-choice" ? String.fromCharCode(65 + optionIndex) : "";
        return "<div class='quiz-suggestion-answer " + (optionIndex === question.correctIndex ? "correct" : "") + "'><b>" + label + "</b>" + escapeHtml(option) + (optionIndex === question.correctIndex ? " · Correct answer" : "") + "</div>";
      }).join("");
      if (type === "modified-true-false" && question.correctIndex === 1) answerMarkup += `<div class="quiz-suggestion-answer correct"><b>Corrected statement</b>${escapeHtml(question.correction)}</div>`;
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
    editorQuestions = ready.map((question) => ({ ...question, id: makeId(), options: question.options.slice() }));
    editingQuiz = null;
    editRequest++;
    document.getElementById("editorTitle").value = document.getElementById("quizTitle").value.trim();
    document.getElementById("editorSectionName").textContent = "Assign in My quizzes → Schedule";
    document.getElementById("quizAvailability").hidden = true;
    document.getElementById("editorMeta").textContent = editorQuestions.length + " questions · " + difficulty + " · " + questionTypeLabel(document.querySelector("input[name='questionType']:checked").value);
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
      if (writtenQuestion(type)) {
        const field = type === "essay" ? "rubric" : "explanation";
        answers = `<label class="quiz-field"><span class="quiz-field-label">${type === "essay" ? "Model answer" : "Expected identification"}</span><textarea class="quiz-input" rows="3" maxlength="${type === "essay" ? 8000 : 1000}" data-answer-field="answer" data-question-index="${index}">${escapeHtml(question.answer || "")}</textarea></label><label class="quiz-field"><span class="quiz-field-label">${type === "essay" ? "Marking criteria" : "Expected explanation"}</span><textarea class="quiz-input" rows="3" maxlength="4000" data-answer-field="${field}" data-question-index="${index}">${escapeHtml(question[field] || "")}</textarea></label><label class="quiz-field"><span class="quiz-field-label">Points</span><input class="quiz-input" type="number" min="1" max="100" data-answer-field="points" data-question-index="${index}" value="${Number(question.points) || 1}" /></label>`;
      } else if (type === "multiple-choice") {
        answers = question.options.map((option, optionIndex) => "<label class='quiz-option-row'><input type='radio' name='correct-" + question.id + "' data-correct-index='" + optionIndex + "' data-question-index='" + index + "' " + (question.correctIndex === optionIndex ? "checked" : "") + " aria-label='Mark option " + String.fromCharCode(65 + optionIndex) + " as correct' /><input class='quiz-option-input' type='text' maxlength='240' data-option-index='" + optionIndex + "' data-question-index='" + index + "' value='" + escapeHtml(option) + "' aria-label='Answer option " + String.fromCharCode(65 + optionIndex) + "' /></label>").join("");
      } else {
        answers = question.options.map((option, optionIndex) => "<label class='quiz-option-row'><input type='radio' name='correct-" + question.id + "' data-correct-index='" + optionIndex + "' data-question-index='" + index + "' " + (question.correctIndex === optionIndex ? "checked" : "") + " aria-label='Mark " + escapeHtml(option) + " as correct' /><span class='quiz-option-input'>" + escapeHtml(option) + "</span></label>").join("");
      }
      if (type === "modified-true-false" && question.correctIndex === 1) answers += `<label class="quiz-field"><span class="quiz-field-label">Corrected statement</span><textarea class="quiz-input" rows="3" maxlength="4000" data-answer-field="correction" data-question-index="${index}">${escapeHtml(question.correction || "")}</textarea></label>`;
      const hint = writtenQuestion(type) ? "Answer guides support teacher review; they do not automatically grade a student's written response." : type === "modified-true-false" ? "Select the correct answer and provide the corrected statement for a False item." : "Select the circle beside the correct answer.";
      return "<article class='quiz-question-card'><div class='quiz-question-card-head'><strong>Question " + (index + 1) + "</strong><span class='quiz-q-badge'>" + questionTypeLabel(type) + "</span>" + controls + "</div><textarea class='quiz-question-input' rows='2' maxlength='500' data-question-text='" + index + "' aria-label='Question " + (index + 1) + " text'>" + escapeHtml(question.text) + "</textarea><div class='quiz-option-editor'>" + answers + "</div><p class='quiz-correct-hint'>" + hint + "</p></article>";
    }).join("");
    document.getElementById("questionLimitText").textContent = editorQuestions.length + " / 50";
    document.getElementById("addQuestion").disabled = editorQuestions.length >= 50;
    document.getElementById("editorMeta").textContent = editorQuestions.length + " questions · " + difficulty + " · " + questionTypeLabel(type);
  }

  function updateReleaseSelection() {
    document.querySelectorAll(".quiz-release-option").forEach((label) => {
      const radio = label.querySelector("input");
      label.classList.toggle("selected", radio.checked);
    });
    const scheduleSelected = document.querySelector("input[name='availability']:checked").value === "scheduled";
    document.getElementById("scheduleFields").hidden = !scheduleSelected;
  }

  function updateTypeSelection() {
    document.querySelectorAll(".quiz-type-option").forEach(label => label.classList.toggle("selected", label.querySelector("input").checked));
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
    const type = document.querySelector("input[name='questionType']:checked").value;
    const normalizedQuestions = editorQuestions.map(question => normalizeQuizQuestion(question, type));
    if (normalizedQuestions.some(question => !question)) {
      showStatus(editorStatus, "Complete every question, answer choice, answer guide, and required correction before saving. Multiple-choice options must be distinct.", true);
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
      showStatus(editorStatus, "Sign in with a teacher account before saving.", true);
      return;
    }
    const quizzes = loadQuizzes();
    const oldQuiz = editingQuiz;
    const quiz = {
      id: oldQuiz?.id || (reviewedJob ? "quiz-" + reviewedJob.id : makeId()),
      title: title,
      section: oldQuiz ? oldQuiz.section : "Not assigned",
      sectionId: oldQuiz ? oldQuiz.sectionId : "",
      assignmentScope: oldQuiz ? quizAssignmentScope(oldQuiz) : "unassigned",
      sourceFile: oldQuiz?.sourceFile || reviewedJob?.details.fileName || selectedFile?.name || "Uploaded source",
      type,
      schemaVersion: 2,
      gradingMode: writtenQuestion(type) || type === "modified-true-false" ? "teacher-review" : "automatic",
      difficulty: difficulty,
      questions: normalizedQuestions.map((question, index) => ({ id: editorQuestions[index].id, ...question })),
      availability: availability,
      availableAt: availability === "scheduled" ? new Date(availableAt).toISOString() : "",
      createdAt: oldQuiz ? oldQuiz.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      demo: false
    };
    const saveButton = document.getElementById("saveQuiz");
    saveButton.disabled = true;
    saveButton.setAttribute("aria-busy", "true");
    try {
      await setDoc(doc(firestore, "generatedQuizzes", quiz.id), {
        ...quiz,
        teacherUid: signedInUser.uid,
        teacherProfileId
      });
    } catch (error) {
      console.error("Could not save quiz to Firestore:", error);
      showStatus(editorStatus, "The quiz could not be saved. Check your connection and try again.", true);
      return;
    } finally {
      saveButton.disabled = false;
      saveButton.setAttribute("aria-busy", "false");
    }
    const existingIndex = quizzes.findIndex((item) => item.id === quiz.id);
    if (existingIndex >= 0) quizzes[existingIndex] = quiz;
    else quizzes.unshift(quiz);
    saveQuizzes(quizzes);
    renderLibrary();
    if (!oldQuiz && reviewedJob) {
      const savedJobId = reviewedJob.id;
      try {
        await discardQuizJob(signedInUser.uid, savedJobId);
        if (backgroundJob?.id === savedJobId) backgroundJob = undefined;
      } catch { /* The saved quiz uses the same ID if cleanup has to be retried. */ }
    }
    resetNewQuiz();
    if (quiz.assignmentScope === "unassigned") {
      librarySectionFilter.value = "";
      expandedScheduleQuizId = quiz.id;
    }
    setView("library");
    showStatus(document.getElementById("libraryStatus"), "Saved. " + availabilityText(quiz) + ".", false);
  }

  function availabilityText(quiz) {
    if (quiz.availability === "now") return "Marked available for " + assignmentLabel(quiz);
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
    const allQuizzes = loadQuizzes().sort((left, right) => new Date(right.updatedAt || right.createdAt) - new Date(left.updatedAt || left.createdAt));
    const quizzes = librarySectionFilter.value ? allQuizzes.filter(quiz => quizAssignedToSection(quiz, librarySectionFilter.value)) : allQuizzes;
    const count = String(allQuizzes.length);
    document.getElementById("libraryCount").textContent = count;
    document.getElementById("libraryTabCount").textContent = count;
    document.getElementById("emptyLibrary").hidden = allQuizzes.length > 0;
    document.getElementById("libraryFilterEmpty").hidden = !allQuizzes.length || quizzes.length > 0;
    document.getElementById("libraryFilterCount").textContent = `Showing ${quizzes.length} of ${count} ${allQuizzes.length === 1 ? "quiz" : "quizzes"}`;
    libraryList.hidden = quizzes.length === 0;
    libraryList.innerHTML = quizzes.map((quiz) => {
      const status = currentAvailability(quiz);
      const resultsButton = teacherSections.some(section => quizAssignedToSection(quiz, section.id))
        ? `<button type="button" data-results-quiz="${escapeHtml(quiz.id)}">View results</button>` : "";
      const statusLabel = status === "now" ? "Available" : status === "scheduled" ? "Scheduled · locked" : "Draft · locked";
      const statusClass = status === "now" ? "available" : status === "scheduled" ? "scheduled" : "";
      const availability = status === "scheduled" ? "Unlocks " + escapeHtml(formatDate(quiz.availableAt)) : status === "now" ? "Available now" : "Only visible to you";
      const expanded = expandedScheduleQuizId === quiz.id;
      const scheduleForm = expanded ? `<form class="quiz-library-scheduler" data-schedule-form="${escapeHtml(quiz.id)}">
        <div><strong>Quiz release</strong><p>Choose one section or all your sections, then set when learners can open this quiz.</p></div>
        <div class="quiz-library-scheduler-fields">
          <label>Assign to section <select name="sectionId" aria-label="Section for ${escapeHtml(quiz.title)}" required>
            ${quizAssignmentScope(quiz) === "all" || teacherSections.some(section => section.id === quiz.sectionId) ? "" : '<option value="" selected disabled>Choose a section</option>'}
            <option value="*" ${quizAssignmentScope(quiz) === "all" ? "selected" : ""} ${teacherSections.length ? "" : "disabled"}>All my sections</option>
            ${teacherSections.map(section => `<option value="${escapeHtml(section.id)}" ${section.id === quiz.sectionId ? "selected" : ""}>${escapeHtml(section.name)}</option>`).join("")}
          </select></label>
          <label>Access <select name="availability" aria-label="Access for ${escapeHtml(quiz.title)}">
            <option value="draft" ${status === "draft" ? "selected" : ""}>Keep locked</option>
            <option value="now" ${status === "now" ? "selected" : ""}>Available now</option>
            <option value="scheduled" ${status === "scheduled" ? "selected" : ""}>Schedule release</option>
          </select></label>
          <label class="quiz-library-date" ${status === "scheduled" ? "" : "hidden"}>Release date and time <input name="availableAt" type="datetime-local" value="${status === "scheduled" ? escapeHtml(toLocalDateTimeInput(quiz.availableAt)) : ""}"></label>
          <button class="primary-btn quiz-primary" type="submit" ${scheduleBusy ? "disabled" : ""}>Save release</button>
        </div>
      </form>` : "";
      return `<article class="quiz-library-card"><div class="quiz-library-main"><div class="quiz-library-title-row"><h3>${escapeHtml(quiz.title)}</h3><span class="quiz-status-badge ${statusClass}">${statusLabel}</span></div><div class="quiz-library-details"><span>${escapeHtml(assignmentLabel(quiz))}</span><span>${quiz.questionCount} questions</span><span>${questionTypeLabel(quiz.type)}</span><span>${availability}</span></div></div><div class="quiz-library-actions">${resultsButton}<button type="button" data-schedule-quiz="${escapeHtml(quiz.id)}" aria-expanded="${expanded}" ${scheduleBusy ? "disabled" : ""}>Assign / schedule</button><button type="button" data-edit-quiz="${escapeHtml(quiz.id)}">Edit</button><button class="delete" type="button" data-delete-quiz="${escapeHtml(quiz.id)}">Delete</button></div>${scheduleForm}</article>`;
    }).join("");
  }

  async function saveLibrarySchedule(form) {
    if (scheduleBusy) return;
    const id = form.dataset.scheduleForm;
    const quiz = loadQuizzes().find(item => item.id === id);
    if (!quiz || !auth.currentUser || !teacherProfileId) return;
    const availability = form.elements.availability.value;
    const dateInput = form.elements.availableAt;
    const releaseDate = availability === "scheduled" ? new Date(dateInput.value) : null;
    const libraryStatus = document.getElementById("libraryStatus");
    const allSections = form.elements.sectionId.value === "*";
    const section = teacherSections.find(item => item.id === form.elements.sectionId.value);
    if ((allSections && !teacherSections.length) || (!allSections && !section)) {
      showStatus(libraryStatus, "Choose one of your assigned sections for this quiz.", true);
      return;
    }
    if (availability === "scheduled" && (!dateInput.value || Number.isNaN(releaseDate.getTime()) || releaseDate.getTime() <= Date.now())) {
      showStatus(libraryStatus, "Choose a future date and time for this quiz.", true);
      dateInput.focus();
      return;
    }
    scheduleBusy = true;
    librarySectionFilter.disabled = true;
    form.querySelector("button[type='submit']").disabled = true;
    showStatus(libraryStatus, "", false);
    setLoadingState(libraryStatus, true, "Saving quiz release");
    let saved = false;
    try {
      const reference = doc(firestore, "generatedQuizzes", id);
      const updated = {
        assignmentScope: allSections ? "all" : "section",
        sectionId: allSections ? "" : section.id,
        section: allSections ? "All my sections" : section.name,
        availability,
        availableAt: availability === "scheduled" ? releaseDate.toISOString() : ""
      };
      const uid = auth.currentUser?.uid;
      await updateDoc(reference, updated);
      if (auth.currentUser?.uid !== uid) return;
      const quizzes = loadQuizzes();
      const currentQuiz = quizzes.find(item => item.id === id) || quiz;
      saveQuizzes([...quizzes.filter(item => item.id !== id), { ...currentQuiz, ...updated }]);
      if (librarySectionFilter.value && !quizAssignedToSection(updated, librarySectionFilter.value)) librarySectionFilter.value = updated.sectionId;
      expandedScheduleQuizId = null;
      saved = true;
      showStatus(libraryStatus, `Release saved for ${quiz.title} · ${assignmentLabel(updated)}.`, false);
    } catch (error) {
      console.error("Could not save quiz release:", error);
      showStatus(libraryStatus, error.message || "Could not save the quiz release. Try again.", true);
    } finally {
      scheduleBusy = false;
      setLoadingState(libraryStatus, false);
      librarySectionFilter.disabled = teacherSections.length === 0;
      if (saved) renderLibrary();
      else if (form.isConnected) form.querySelector("button[type='submit']").disabled = false;
    }
  }

  async function editQuiz(id) {
    const uid = auth.currentUser?.uid;
    if (!uid || !loadQuizzes().some(item => item.id === id)) return;
    const request = ++editRequest;
    const status = document.getElementById("libraryStatus");
    let quiz;
    try {
      const current = await getDoc(doc(firestore, "generatedQuizzes", id));
      if (request !== editRequest || auth.currentUser?.uid !== uid) return;
      if (!current.exists() || current.data().teacherUid !== uid) throw new Error("This quiz is no longer available.");
      const { questions, ...metadata } = current.data();
      quiz = { ...metadata, id };
      editorQuestions = questions;
    } catch {
      if (request === editRequest && auth.currentUser?.uid === uid) showStatus(status, "Could not open the quiz. Please try again.", true);
      return;
    }
    editingQuiz = quiz;
    reviewedJob = undefined;
    renderJob();
    editorQuestions = (editorQuestions || []).map((question) => ({
      ...question,
      id: question.id || makeId(),
      text: question.text || "",
      options: Array.isArray(question.options) ? question.options.slice() : writtenQuestion(quiz.type) ? [] : quiz.type === "multiple-choice" ? ["", "", "", ""] : ["True", "False"],
      correctIndex: Number.isInteger(question.correctIndex) ? question.correctIndex : 0
    }));
    selectedFile = null;
    updateGenerateButton();
    fileInput.value = "";
    selectedFileRow.hidden = true;
    document.getElementById("editorTitle").value = quiz.title || "";
    document.getElementById("editorSectionName").textContent = assignmentLabel(quiz);
    document.getElementById("quizAvailability").hidden = quizAssignmentScope(quiz) === "unassigned";
    document.getElementById("editorDemoNotice").hidden = !quiz.demo;
    document.getElementById("backToReview").hidden = true;
    document.getElementById("quizTitle").value = quiz.title || "";
    difficulty = quiz.difficulty || "Medium";
    document.querySelectorAll("[data-difficulty]").forEach((button) => {
      const selected = button.dataset.difficulty === difficulty;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    document.querySelector("input[name='questionType'][value='" + (quiz.type || "multiple-choice") + "']").checked = true;
    updateTypeSelection();
    const availability = currentAvailability(quiz);
    document.querySelector("input[name='availability'][value='" + availability + "']").checked = true;
    document.getElementById("availableAt").value = availability === "scheduled" ? toLocalDateTimeInput(quiz.availableAt) : "";
    updateReleaseSelection();
    document.getElementById("editorMeta").textContent = editorQuestions.length + " questions";
    setView("create");
    setStep("editor");
  }

  function resetNewQuiz() {
    reviewedJob = undefined;
    selectedFile = null;
    fileError.textContent = "";
    fileInput.setAttribute("aria-invalid", "false");
    updateGenerateButton();
    generatedQuestions = [];
    editorQuestions = [];
    editingQuiz = null;
    editRequest++;
    fileInput.value = "";
    selectedFileRow.hidden = true;
    document.getElementById("quizTitle").value = "";
    document.getElementById("questionCount").value = "10";
    document.querySelector("input[name='questionType'][value='multiple-choice']").checked = true;
    updateTypeSelection();
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
    renderJob();
  }

  loadSections();
  renderLibrary();
  updateGenerateButton();
  // Remove full quiz copies saved by older versions of the library.
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith("imars-generated-quizzes:")) localStorage.removeItem(key);
    }
  } catch {}
  onAuthStateChanged(auth, async (user) => {
    ++jobCheck;
    clearTimeout(jobTimer);
    backgroundJob = undefined;
    reviewedJob = undefined;
    renderJob();
    closeQuizReview();
    editRequest++;
    editingQuiz = null;
    expandedScheduleQuizId = null;
    editorQuestions = [];
    generatedQuestions = [];
    librarySectionFilter.value = "";
    teacherSections = [];
    renderSectionFilter();
    quizCache = [];
    renderLibrary();
    if (user) void refreshJob(user);
    await loadTeacherSections(user);
    if (user && teacherProfileId) await loadTeacherQuizzes(user);
    else if (user) {
      showStatus(document.getElementById("libraryStatus"), "Could not load quizzes. Please try again.", true);
      revealContent("quiz-library");
    }
  });

  fileInput.addEventListener("change", () => handleFile(fileInput.files[0]));
  document.getElementById("removeFile").addEventListener("click", (event) => {
    event.preventDefault();
    if (generating) return;
    selectedFile = null;
    updateGenerateButton();
    fileInput.value = "";
    fileError.textContent = "";
    fileInput.setAttribute("aria-invalid", "false");
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
  document.querySelectorAll("input[name='questionType']").forEach(radio => radio.addEventListener("change", updateTypeSelection));
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
  document.getElementById("discardAll").addEventListener("click", async () => {
    if (!await confirmAction({ title: "Discard all suggested questions?", message: "You’ll return to quiz setup and lose these suggestions.", confirmLabel: "Discard questions" })) return;
    if (reviewedJob) {
      try {
        await discardQuizJob(auth.currentUser?.uid, reviewedJob.id);
        backgroundJob = undefined;
        reviewedJob = undefined;
        renderJob();
      } catch (error) {
        jobStatus.hidden = false;
        jobMessage.textContent = error.message;
        return;
      }
    }
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
    const field = event.target.dataset.answerField;
    if (["answer", "explanation", "rubric", "correction", "points"].includes(field)) question[field] = field === "points" ? Number(event.target.value) : event.target.value;
  });
  editorList.addEventListener("change", (event) => {
    if (event.target.dataset.correctIndex === undefined) return;
    const question = editorQuestions[Number(event.target.dataset.questionIndex)];
    if (question) {
      question.correctIndex = Number(event.target.dataset.correctIndex);
      if (document.querySelector("input[name='questionType']:checked").value === "modified-true-false") renderEditor();
    }
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
      options: writtenQuestion(type) ? [] : type === "multiple-choice" ? ["", "", "", ""] : ["True", "False"],
      correctIndex: writtenQuestion(type) ? -1 : 0,
      ...(writtenQuestion(type) ? { answer: "", [type === "essay" ? "rubric" : "explanation"]: "", points: type === "essay" ? 10 : 2 } : {}),
      ...(type === "modified-true-false" ? { correction: "" } : {})
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
  librarySectionFilter.addEventListener("change", () => {
    expandedScheduleQuizId = null;
    showStatus(document.getElementById("libraryStatus"), "", false);
    renderLibrary();
  });
  libraryList.addEventListener("click", async (event) => {
    const results = event.target.closest("[data-results-quiz]");
    if (results) {
      const quiz = loadQuizzes().find(item => item.id === results.dataset.resultsQuiz);
      if (quiz && auth.currentUser) void openQuizReview(auth.currentUser, quiz, teacherSections, librarySectionFilter.value);
      return;
    }
    const schedule = event.target.closest("[data-schedule-quiz]");
    if (schedule && !scheduleBusy) {
      expandedScheduleQuizId = expandedScheduleQuizId === schedule.dataset.scheduleQuiz ? null : schedule.dataset.scheduleQuiz;
      showStatus(document.getElementById("libraryStatus"), "", false);
      renderLibrary();
      return;
    }
    const edit = event.target.closest("[data-edit-quiz]");
    const remove = event.target.closest("[data-delete-quiz]");
    if (edit) editQuiz(edit.dataset.editQuiz);
    if (remove) {
      const id = remove.dataset.deleteQuiz;
      const quiz = loadQuizzes().find(item => item.id === id);
      const uid = auth.currentUser?.uid;
      if (!quiz || !uid || !await confirmAction({
        title: "Delete quiz?",
        message: `Delete “${quiz.title}” from your library? This cannot be undone.`,
        confirmLabel: "Delete quiz"
      }) || auth.currentUser?.uid !== uid) return;
      try {
        await deleteDoc(doc(firestore, "generatedQuizzes", id));
        saveQuizzes(loadQuizzes().filter((quiz) => quiz.id !== id));
        showStatus(document.getElementById("libraryStatus"), "Quiz deleted.", false);
        renderLibrary();
      } catch (error) {
        console.error("Could not delete quiz from Firestore:", error);
        showStatus(document.getElementById("libraryStatus"), "Could not delete this quiz. Please try again.", true);
      }
    }
  });
  libraryList.addEventListener("change", (event) => {
    if (!event.target.matches("select[name='availability']")) return;
    const form = event.target.closest("[data-schedule-form]");
    form.querySelector(".quiz-library-date").hidden = event.target.value !== "scheduled";
  });
  libraryList.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-schedule-form]");
    if (!form) return;
    event.preventDefault();
    void saveLibrarySchedule(form);
  });

})();
