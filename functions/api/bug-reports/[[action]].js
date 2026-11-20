import { bugReports } from "../../../server/bug-reports.js";
export const onRequest = context => bugReports(context);
