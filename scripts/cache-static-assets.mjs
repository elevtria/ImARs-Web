import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { build, transform } from "esbuild";
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

// Version the whole published graph, including shared chunks and runtime assets.
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
  output = resolve(output);
  const inputs = new Map(), names = new Map();
  const files = new Map();
  async function collect(directory) {
    for (const entry of await readdir(join(output, directory), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const name = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Static assets cannot contain symbolic links: ${name}`);
      if (entry.isDirectory()) await collect(name);
      else inputs.set(name, await readFile(join(output, name)));
    }
  }
  await collect("js");
  await collect("css");
  const localName = name => relative(output, resolve(output, name)).split(sep).join("/");
  const options = {
    absWorkingDir: output, outdir: join(output, ".bundles"), bundle: true,
    write: false, metafile: true, minify: true, charset: "utf8",
    legalComments: "eof", sourcemap: false, logLevel: "silent",
    assetNames: "asset-[hash]", platform: "browser"
  };
  function keepBuild(result) {
    for (const file of result.outputFiles) {
      const name = basename(file.path);
      if (files.has(name) && !files.get(name).equals(Buffer.from(file.contents))) throw new Error(`Conflicting bundle: ${name}`);
      files.set(name, Buffer.from(file.contents));
    }
    for (const [name, details] of Object.entries(result.metafile.outputs)) {
      if (details.entryPoint) names.set(`/${localName(details.entryPoint)}`, basename(name));
    }
  }
  async function asset(name) {
    if (names.has(`/${name}`)) return names.get(`/${name}`);
    const path = resolve(output, name);
    if (relative(output, path).startsWith("..") || path === output || /\.(?:js|mjs|html)$/i.test(path)) {
      throw new Error(`Invalid runtime asset: ${name}`);
    }
    const content = inputs.get(name) || await readFile(path);
    const hashed = `asset-${createHash("sha256").update(content).digest("hex").slice(0, 16)}${extname(name)}`;
    names.set(`/${name}`, hashed);
    files.set(hashed, content);
    return hashed;
  }
  const styles = [...inputs.keys()].filter(name => name.endsWith(".css")).sort();
  if (styles.length) keepBuild(await build({ ...options, entryPoints: styles, entryNames: "style-[hash]",
    loader: { ".png": "file", ".jpg": "file", ".jpeg": "file", ".gif": "file", ".svg": "file", ".webp": "file", ".woff": "file", ".woff2": "file", ".ttf": "file" } }));
  // Marker downloads keep their existing URLs and are never bundled into JS.
  for (const name of ["assets/imars-logo.png", "assets/imars-loader-transparent.png"]) await asset(name);

  const modules = new Set(), classic = new Set();
  for (const page of pages) {
    const html = await readFile(join(output, page), "utf8");
    for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
      const source = match[0].match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2];
      if (!source || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source)) continue;
      const name = new URL(source, "https://imars.invalid/").pathname.slice(1);
      if (!inputs.has(name)) throw new Error(`Missing browser entry: ${source}`);
      (/\btype\s*=\s*(?:"module"|'module'|module\b)/i.test(match[0]) ? modules : classic).add(name);
    }
  }
  for (const name of classic) {
    if (modules.has(name)) throw new Error(`A browser entry cannot be both classic and module: ${name}`);
    // Preserve classic-script globals, execution order, and existing script tags.
    const content = inputs.get(name);
    const hashed = `app-${createHash("sha256").update(content).digest("hex").slice(0, 16)}.js`;
    names.set(`/${name}`, hashed);
    files.set(hashed, content);
  }
  if (modules.size) {
    keepBuild(await build({ ...options, entryPoints: [...modules].sort(),
      entryNames: "app-[hash]", chunkNames: "chunk-[hash]", format: "esm", splitting: true,
      plugins: [{ name: "runtime-assets", setup(builder) {
        builder.onLoad({ filter: /\.js$/ }, async args => {
          const name = localName(args.path);
          let contents = inputs.get(name)?.toString("utf8");
          if (contents === undefined) throw new Error(`Unexpected browser module: ${name}`);
          const pattern = /new URL\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)/g;
          for (const match of [...contents.matchAll(pattern)]) {
            const url = new URL(match[2], `https://imars.invalid/${name}`);
            if (url.origin !== "https://imars.invalid" || !match[2].startsWith(".")) continue;
            const hashed = await asset(decodeURIComponent(url.pathname.slice(1)));
            contents = contents.replace(match[0], `new URL(${JSON.stringify(`./${hashed}${url.search}${url.hash}`)}, import.meta.url)`);
          }
          return { contents, loader: "js", resolveDir: dirname(args.path) };
        });
      } }]
    }));
  }
  const plan = staticAssetPlan(files);
  const urls = new Map([...names].map(([original, name]) => [original, plan.urls.get(`/${name}`)]));
  for (const [name, content] of files) {
    if (/\.(?:js|css|svg)$/i.test(name)) assertPublicClientContent(content.toString("utf8"), name);
    const destination = join(output, plan.prefix.slice(1), name);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  for (const page of pages) {
    const path = join(output, page);
    await writeFile(path, versionHtmlAssets(await readFile(path, "utf8"), urls));
  }
  await writeFile(join(output, "_headers"), plan.headers);
  return { prefix: plan.prefix, count: files.size, urls };
}
