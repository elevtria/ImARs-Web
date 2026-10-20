import { PDF_REQUEST_TIMEOUT_MS, quizFileSizeError } from "./quiz-limits.js";

// Allow the server's generation deadline plus sign-in checks and network time.
const REQUEST_TIMEOUT_MS = 105000;

export async function requestQuiz(idToken, payload) {
  const { pdfFile, ...settings } = payload;
  const isPdf = settings.fileMimeType === "application/pdf" && pdfFile instanceof Blob;
  if (isPdf) {
    const error = quizFileSizeError(pdfFile.size);
    if (error) throw new Error(error);
  }
  const signal = AbortSignal.timeout(isPdf ? PDF_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch("/api/generate-quiz", {
      method: "POST",
      headers: { Authorization: "Bearer " + idToken,
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
    if (!Array.isArray(result.questions) || result.questions.length === 0) {
      throw new Error("The question generator returned no questions. Please try again.");
    }
    return result.questions;
  } catch (error) {
    if (signal.aborted) throw new Error("Generating these questions took too long. Please retry with fewer questions or a shorter learning file.");
    throw error;
  }
}
