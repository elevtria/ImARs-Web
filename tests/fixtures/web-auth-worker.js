// LOCAL TEST ONLY. Never deploy this fixture or bind production Pages to it.
// It verifies dummy accounts without contacting Firebase.
import { WebLoginState as ProductionState } from "../../workers/web-auth-worker.js";

export class WebLoginState extends ProductionState {
  constructor(state, env) {
    super(state, env, { fetch: async (_url, options) => {
      const { email, password } = JSON.parse(options.body);
      const uid = { "teacher@example.test": "teacher-a", "admin@example.test": "admin-a" }[email];
      return uid && password === "local-fixture-password"
        ? Response.json({ localId: uid, idToken: "local-fixture-token" })
        : Response.json({ error: { message: "INVALID_LOGIN_CREDENTIALS" } }, { status: 400 });
    } });
  }
}
export default { fetch: () => new Response("Local fixture only", { status: 404 }) };
