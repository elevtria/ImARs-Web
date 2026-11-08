// Loaded only by the Netlify build's capability marker. Files stay in bounded
// chunks so the independent host preserves the same 50 MB source-file limit.
export async function requestNetlifyQuiz(settings, pdfFile, uid, signal) {
  const request = async (path, body = {}, binary = false) => {
    const response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store", signal,
      headers: { "Content-Type": binary ? "application/octet-stream" : "application/json", ...(uid ? { "X-Web-User": uid } : {}) },
      body: binary ? body : JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "The backup quiz service could not finish this request. Please retry.");
    return result;
  };
  const started = await request("/api/quiz-jobs/start", { ...settings, ...(pdfFile ? { fileSize: pdfFile.size } : {}) });
  if (!/^[a-f0-9]{32}$/.test(started.id) || started.chunkBytes !== 3_000_000) throw new Error("The quiz upload could not be started.");
  const query = "?id=" + started.id;
  if (pdfFile) {
    const chunks = Math.ceil(pdfFile.size / started.chunkBytes);
    // Three uploads overlap, with at most 9 MB of file data in flight.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, chunks) }, async () => {
      while (next < chunks) {
        const index = next++;
        await request("/api/quiz-jobs/chunk" + query + "&index=" + index, pdfFile.slice(index * started.chunkBytes, (index + 1) * started.chunkBytes), true);
      }
    }));
  }
  await request("/api/quiz-jobs/run" + query);
  while (!signal.aborted) {
    const result = await request("/api/quiz-jobs/status" + query);
    if (result.status === "complete") {
      if (!Array.isArray(result.questions) || !result.questions.length) throw new Error("The question generator returned no questions. Please try again.");
      return result.questions;
    }
    if (result.status === "failed") throw new Error(result.error || "Quiz generation could not finish. Please try again.");
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  throw signal.reason;
}
