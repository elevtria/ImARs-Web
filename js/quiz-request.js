import { PDF_REQUEST_TIMEOUT_MS, quizFileSizeError } from "./quiz-limits.js";

// Allow the server's generation deadline plus sign-in checks and network time.
const REQUEST_TIMEOUT_MS = 105000;

const usesNetlifyJobs = () => globalThis.document?.querySelector('meta[name="imars-quiz-transport"]')?.content === "netlify-jobs";
const jobHeaders = uid => uid ? { "X-Web-User": uid } : {};

export async function readQuizJob(uid) {
  if (usesNetlifyJobs()) return { status: "none" };
  const response = await fetch("/api/generate-quiz", {
    credentials: "same-origin", cache: "no-store", headers: jobHeaders(uid), signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error("Quiz progress is temporarily unavailable.");
  return response.json();
}

export async function discardQuizJob(uid, id) {
  const response = await fetch("/api/generate-quiz?id=" + encodeURIComponent(id), {
    method: "DELETE", credentials: "same-origin", headers: jobHeaders(uid), signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error("Could not clear the previous quiz. Please try again.");
}

export async function requestQuiz(payload, uid, { background = false } = {}) {
  const { pdfFile, ...settings } = payload;
  const isPdf = settings.fileMimeType === "application/pdf" && pdfFile instanceof Blob;
  if (isPdf) {
    const error = quizFileSizeError(pdfFile.size);
    if (error) throw new Error(error);
  }
  const signal = AbortSignal.timeout(isPdf ? PDF_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  try {
    if (usesNetlifyJobs()) {
      const { requestNetlifyQuiz } = await import("./netlify-quiz-request.js");
      return await requestNetlifyQuiz(settings, isPdf ? pdfFile : null, uid, signal);
    }
    const response = await fetch(background ? "/api/generate-quiz?background=1" : "/api/generate-quiz", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { ...jobHeaders(uid),
        "Content-Type": isPdf ? "application/pdf" : "application/json",
        ...(isPdf ? { "X-Quiz-Options": encodeURIComponent(JSON.stringify({ ...settings, fileSize: pdfFile.size })) } : {})
      },
      body: isPdf ? pdfFile : JSON.stringify(settings),
      signal
    });
    const result = await response.json().catch(error => {
      if (signal.aborted) throw error;
      return {};
    });
    if (!response.ok) throw new Error(result.error || (response.status === 404
      ? "The quiz-generation service is unavailable. Refresh the page and try again."
      : "Quiz generation failed. Please try again."));
    if (background && response.status === 202 && typeof result.id === "string" && ["queued", "running", "complete"].includes(result.status)) return result;
    if (!Array.isArray(result.questions) || result.questions.length === 0) {
      throw new Error("The question generator returned no questions. Please try again.");
    }
    return result.questions;
  } catch (error) {
    if (signal.aborted) throw new Error("Generating these questions took too long. Please retry with fewer questions or a shorter learning file.");
    throw error;
  }
}
