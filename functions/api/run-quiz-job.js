import { onRequestPost as generateQuiz } from "./generate-quiz.js";
import { limitedStream } from "../../server/quiz-material.js";
import { quizJobObject, quizJobResponse, verifyQuizJob } from "../../server/quiz-background.js";
import { staffProfile } from "../../server/web-auth.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const signature = request.headers.get("X-Imars-Quiz-Signature") || "";
    if (!/^[a-f0-9]{64}$/.test(signature) || !env.QUIZ_GENERATION_JOBS) return quizJobResponse({ error: "Unauthorized." }, 401);
    const raw = await new Response(limitedStream(request.body, 1_000_000)).text();
    const prepared = await verifyQuizJob(env.WEB_SESSION_SECRET, signature, raw);
    if (prepared?.actor?.role !== "teacher") return quizJobResponse({ error: "Unauthorized." }, 401);
    const claim = await quizJobObject(env, prepared.actor).fetch("https://quiz-job.internal/claim", {
      method: "POST", body: JSON.stringify({ id: prepared.id })
    });
    if (!claim.ok) return quizJobResponse({ error: "This quiz job is no longer available." }, 409);
    // The signed payload was built after teacher and upload validation in Pages.
    return await generateQuiz(context, {
      prepared, limitGeneration: false,
      authenticate: (_request, _env, store) => staffProfile(prepared.actor, store)
    });
  } catch {
    return quizJobResponse({ error: "Quiz generation could not finish. Please try again." }, 503);
  }
}
