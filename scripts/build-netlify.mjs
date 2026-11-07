import "./build-site.mjs";
import { readFile, writeFile } from "node:fs/promises";

// Only this host uses background quiz jobs and chunked uploads. The regular
// Cloudflare build retains its current streaming endpoint and upload behavior.
const page = new URL("../dist/quiz-generator.html", import.meta.url);
const html = await readFile(page, "utf8");
await writeFile(page, html.replace("</head>", '<meta name="imars-quiz-transport" content="netlify-jobs"></head>'));
