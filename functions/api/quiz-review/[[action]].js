import { quizReview } from "../../../server/quiz-review.js";

export const onRequest = context => quizReview(context);
