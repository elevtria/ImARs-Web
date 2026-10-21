import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { transform } from "esbuild";
import { minify as minifyHtml } from "html-minifier-terser";

const IMMUTABLE = "public, max-age=31536000, immutable";

export function assertPublicClientContent(content, name) {
  if (/AIza[\w-]{30,}|firebaseConfig|firebasejs\/|firebaseapp\.com|firestore\.googleapis\.com|imars-db-a733b/i.test(content)) {
    throw new Error(`Browser Firebase connections are forbidden in ${name}. Use the authenticated website API.`);
  }
  if (/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|["']?type["']?\s*:\s*["']service_account["']|\b(?:GEMINI_API_KEY|FIREBASE_SERVICE_ACCOUNT_JSON|WEB_SESSION_SECRET|WEB_MAINTENANCE_KEY)\b["']?\s*[:=]\s*["'][^"']+["']/i.test(content)) {
    throw new Error(`Private server credentials cannot be published in ${name}.`);
  }
}

// Only generated files are changed. Keep the editable source and module paths intact.
export async function minifyPublicAssets(output, pages) {
  let before = 0, after = 0, count = 0;
  async function compact(name, loader) {
    const path = join(output, name);
    const original = await readFile(path, "utf8");
    assertPublicClientContent(original, name);
    const result = loader === "html"
      ? await minifyHtml(original, { collapseWhitespace: true, conservativeCollapse: true, removeComments: true, minifyJS: false, minifyCSS: false })
      : (await transform(original, { loader, minify: true, charset: "utf8", legalComments: "eof", sourcemap: false, sourcefile: name })).code;
    await writeFile(path, result);
    before += Buffer.byteLength(original);
    after += Buffer.byteLength(result);
    count++;
  }
  async function visit(directory) {
    for (const entry of await readdir(join(output, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Public files cannot contain symbolic links: ${name}`);
      if (entry.isDirectory()) await visit(name);
      else if (entry.name.endsWith(".js")) await compact(name, "js");
      else if (entry.name.endsWith(".css")) await compact(name, "css");
    }
  }
  await visit("js");
  await visit("css");
  for (const page of pages) await compact(page, "html");
  return { before, after, count };
}

// One content-derived directory preserves relative JS imports and import.meta.url
// references without changing application source or introducing a bundler.
export function staticAssetPlan(files) {
  const names = [...files.keys()].sort();
  const hash = createHash("sha256").update("imars-static-cache-v1\0");
  for (const name of names) {
    const content = files.get(name);
    hash.update(`${name}\0${content.length}\0`).update(content);
  }
  const prefix = `/assets/site-${hash.digest("hex").slice(0, 20)}`;
  const urls = new Map(names.map(name => [`/${name}`, `${prefix}/${name}`]));
  // Exact file rules keep errors, HTML fallback pages, and APIs out of this policy.
  if (names.length > 100) throw new Error("Static cache policy exceeds Cloudflare Pages' 100 header rule limit.");
  const headers = names.map(name => `${urls.get(`/${name}`)}\n  Cache-Control: ${IMMUTABLE}`).join("\n\n") + "\n";
  return { prefix, urls, headers };
}

export function versionHtmlAssets(html, urls) {
  return html.replace(/(\b(?:src|href)\s*=\s*["'])([^"']+)(["'])/gi, (match, before, value, after) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) return match;
    const url = new URL(value, "https://imars.invalid/");
    const versioned = urls.get(url.pathname);
    return versioned ? `${before}${versioned}${url.search}${url.hash}${after}` : match;
  });
}

export async function cacheStaticAssets(output, pages) {
  const files = new Map();
  async function collect(directory) {
    for (const entry of await readdir(join(output, directory), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const name = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Static assets cannot contain symbolic links: ${name}`);
      if (entry.isDirectory()) await collect(name);
      else files.set(name, await readFile(join(output, name)));
    }
  }
  await collect("js");
  await collect("css");
  // Marker ZIPs already have a version in their download links. Keep their
  // existing paths/policy and avoid copying the 50 MB marker library twice.
  for (const name of ["assets/imars-logo.png", "assets/imars-loader-transparent.png"]) {
    files.set(name, await readFile(join(output, name)));
  }
  const plan = staticAssetPlan(files);
  for (const [name, content] of files) {
    const destination = join(output, plan.prefix.slice(1), name);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  for (const page of pages) {
    const path = join(output, page);
    await writeFile(path, versionHtmlAssets(await readFile(path, "utf8"), plan.urls));
  }
  await writeFile(join(output, "_headers"), plan.headers);
  return { prefix: plan.prefix, count: files.size };
}
