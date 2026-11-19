import { onRequestPost as generateQuiz } from "./generate-quiz.js";
import { limitedStream } from "../../server/quiz-material.js";
import { quizExecutionObject, quizJobResponse, verifyQuizJob } from "../../server/quiz-background.js";
import { staffProfile } from "../../server/web-auth.js";

export async function onRequestPost(context, { generate = generateQuiz } = {}) {
  const { request, env } = context;
  try {
    const signature = request.headers.get("X-Imars-Quiz-Signature") || "";
    if (!/^[a-f0-9]{64}$/.test(signature) || !env.QUIZ_GENERATION_JOBS) return quizJobResponse({ error: "Unauthorized." }, 401);
    const raw = await new Response(limitedStream(request.body, 1_000_000)).text();
    const prepared = await verifyQuizJob(env.WEB_SESSION_SECRET, signature, raw);
    if (prepared?.actor?.role !== "teacher") return quizJobResponse({ error: "Unauthorized." }, 401);
    const execution = quizExecutionObject(env, prepared.id);
    const claim = await execution.fetch("https://quiz-job.internal/claim-execution", {
      method: "POST", body: JSON.stringify({ id: prepared.id, executeBy: prepared.executeBy })
    });
    if (!claim.ok) return quizJobResponse({ error: "This quiz job is no longer available." }, 409);
    // The signed payload was built after teacher and upload validation in Pages.
    const response = await generate(context, {
      prepared, limitGeneration: false,
      authenticate: (_request, _env, store) => staffProfile(prepared.actor, store)
    });
    const result = { status: response.status, body: await response.clone().json() };
    const saved = await execution.fetch("https://quiz-job.internal/finish-execution", {
      method: "POST", body: JSON.stringify({ id: prepared.id, result })
    });
    if (!saved.ok) return quizJobResponse({ error: "Quiz generation could not finish. Please try again." }, 503);
    return response;
  } catch {
    return quizJobResponse({ error: "Quiz generation could not finish. Please try again." }, 503);
  }
}
