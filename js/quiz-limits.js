// Decimal MB keeps the advertised maximum within the AI service's PDF limit.
export const MAX_QUIZ_FILE_BYTES = 50_000_000;
export const MAX_QUIZ_TEXT_CHARACTERS = 120_000;
export const PDF_REQUEST_TIMEOUT_MS = 300_000;

export function quizFileSizeError(size) {
  if (!Number.isSafeInteger(size) || size < 1) return "This file is empty or could not be read.";
  return size > MAX_QUIZ_FILE_BYTES ? "Please choose a file of 50 MB or less." : "";
}
