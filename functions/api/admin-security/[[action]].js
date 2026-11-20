import { adminSecurity } from "../../../server/admin-security.js";
export const onRequest = context => adminSecurity(context);
