import { schoolYearHistory } from "../../../server/school-year-history.js";
export const onRequest = context => schoolYearHistory(context);
