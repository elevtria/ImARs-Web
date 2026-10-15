import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "dist");
// Only the generated dist directory may be cleared; never use a caller-supplied path.
if (relative(root, output) !== "dist" || basename(output) !== "dist") {
  throw new Error("Refusing to clear an unexpected build output directory.");
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const pages = (await readdir(root)).filter((name) => name.endsWith(".html"));
const publicPaths = [...pages, "assets", "css", "js", "_routes.json"];
for (const name of publicPaths) {
  await cp(join(root, name), join(output, name), {
    recursive: true,
    filter: (source) => !basename(source).startsWith(".")
  });
}

let files = 0;
let largest = 0;
async function validateDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Public assets cannot contain symbolic links: ${entry.name}`);
    if (entry.isDirectory()) {
      await validateDirectory(path);
      continue;
    }
    const { size } = await stat(path);
    if (size > 25 * 1024 * 1024) throw new Error(`Cloudflare Pages asset exceeds 25 MiB: ${relative(output, path)}`);
    largest = Math.max(largest, size);
    files += 1;
  }
}
await validateDirectory(output);
console.log(`Built ${pages.length} pages and ${files} public files in dist. Largest file: ${(largest / 1024 / 1024).toFixed(1)} MiB.`);
