export * from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { signOut as firebaseSignOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { closeWebSession } from "./web-login.js";
import { invalidateTeacherViews } from "./view-cache.js";

export async function signOut(auth) {
  invalidateTeacherViews();
  let sessionError;
  try { await closeWebSession(); } catch (error) { sessionError = error; }
  await firebaseSignOut(auth);
  if (sessionError) throw sessionError;
}
