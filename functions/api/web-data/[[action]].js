import { webData } from "../../../server/web-data.js";

export const onRequest = context => webData(context);
