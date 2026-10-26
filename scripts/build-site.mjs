import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPublicClientContent, cacheStaticAssets, minifyPublicAssets } from "./cache-static-assets.mjs";

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
    filter: (source) => !basename(source).startsWith(".") && !source.endsWith(".map")
  });
}

const minified = await minifyPublicAssets(output, pages);
await cp(join(output, "js", "sw.js"), join(output, "sw.js"));
const cached = await cacheStaticAssets(output, pages);
// Remove only generated source copies; publish the hashed bundles and root SW.
for (const directory of ["js", "css"]) {
  const generated = resolve(output, directory);
  if (relative(output, generated) !== directory) throw new Error("Invalid generated asset directory.");
  await rm(generated, { recursive: true, force: true });
}
await writeFile(join(output, "_redirects"), "/scan-qr-ar /sync-offline-results 302\n/scan-qr-ar.html /sync-offline-results 302\n");

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
    if (/\.(?:html|js|css|json|txt|svg|ya?ml)$/i.test(path)) assertPublicClientContent(await readFile(path, "utf8"), relative(output, path));
    if (size > 25 * 1024 * 1024) throw new Error(`Cloudflare Pages asset exceeds 25 MiB: ${relative(output, path)}`);
    largest = Math.max(largest, size);
    files += 1;
  }
}
await validateDirectory(output);
console.log(`Built ${pages.length} pages and ${files} public files in dist. Largest file: ${(largest / 1024 / 1024).toFixed(1)} MiB.`);
console.log(`Minified ${minified.count} HTML, JS and CSS files: ${(minified.before / 1024).toFixed(0)} KiB → ${(minified.after / 1024).toFixed(0)} KiB. No source maps are published.`);
console.log(`Versioned ${cached.count} public assets at ${cached.prefix}.`);
