import { studentQuizzes } from "../../../server/student-quizzes.js";

export const onRequest = context => studentQuizzes(context);
