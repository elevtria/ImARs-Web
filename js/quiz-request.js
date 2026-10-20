// Allow the server's generation deadline plus sign-in checks and network time.
const REQUEST_TIMEOUT_MS = 105000;

export async function requestQuiz(idToken, payload) {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch("/api/generate-quiz", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + idToken },
      body: JSON.stringify(payload),
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
