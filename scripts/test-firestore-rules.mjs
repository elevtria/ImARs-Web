import { readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = join(root, ".wrangler", "firestore-security-runtime");
const env = { ...process.env, FIREBASE_EMULATORS_PATH: runtime, FIREBASE_CLI_DISABLE_UPDATE_CHECK: "true" };
// Local demo tests need no Google credentials or Firebase CLI token.
delete env.FIREBASE_TOKEN;
delete env.GOOGLE_APPLICATION_CREDENTIALS;
try {
  for (const directory of await readdir(join(runtime, "java"))) {
    const home = join(runtime, "java", directory);
    if ((await stat(join(home, "bin", process.platform === "win32" ? "java.exe" : "java")).catch(() => null))?.isFile()) {
      env.JAVA_HOME = home;
      env.PATH = join(home, "bin") + (process.platform === "win32" ? ";" : ":") + (env.PATH || env.Path || "");
      break;
    }
  }
} catch { /* Otherwise use the owner's Java 21+ installation. */ }
const child = spawn(process.execPath, [join(root, "node_modules", "firebase-tools", "lib", "bin", "firebase.js"),
  "emulators:exec", "--only", "firestore", "--project", "demo-imars-security-review",
  "--config", "security/firebase.emulator.json", "--non-interactive", "node tests/firestore-rules.emulator.mjs"],
{ cwd: root, env, stdio: "inherit" });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
