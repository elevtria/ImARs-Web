# Public file caching

`npm run build` now publishes a versioned copy of the website's JavaScript,
CSS, logo, and loading image under `/assets/site-<content-hash>/`. Generated
HTML uses those URLs. The shared directory preserves relative module imports
and the loading image's `import.meta.url` reference. Application source files,
page navigation, Firebase requests, and authentication code are unchanged by
this build step.

The hash includes the sorted names and bytes of all files in the versioned
copy. Identical builds reuse the same URLs; changing a file gives the next
build a new directory. Browsers can therefore reuse the public files without
revalidating them on each page, and new deployments reference new URLs.

## Cache scope

The generated `dist/_headers` contains one exact rule per versioned file:

```text
/assets/site-<content-hash>/css/app.css
  Cache-Control: public, max-age=31536000, immutable
```

The current build emits 41 rules, below Pages' 100-rule limit. Only those
known file paths receive this policy. HTML pages, API endpoints, error paths,
private records, and cookies do not get a new public cache rule. Cloudflare
Pages' normal edge caching and the existing HTML/API cache headers remain in
place. When web login protection is enabled, its authenticated responses still
use `private, no-store`; login API and quiz-generation responses use `no-store`.

Original unversioned public URLs are retained with Pages' normal revalidation
behavior. Marker ZIP download paths and their existing version parameters stay
unchanged; the 50 MB marker library is not copied into the versioned directory.
Remote Firebase scripts, fonts, and other third-party resources retain their
providers' caching policies.

Do not add a site-wide "Cache Everything" rule or public caching for Firestore
responses. This change does not create a backend report cache or remove the
quiet Firebase refresh when a saved teacher/admin view opens.

## Deployment and verification

Use the normal build command and `dist` output directory. The build creates
`_headers` automatically; no Cloudflare dashboard setting or new binding is
required for this feature. The source pages served directly by a simple local
static server do not use the generated versioned URLs; test the built output
with `npm run dev` instead.

After deployment:

1. In Chrome's Network tab, keep **Disable cache** unchecked and open a page.
2. Check a CSS/JS/logo URL under `/assets/site-.../`. Its response should have
   `Cache-Control: public, max-age=31536000, immutable`.
3. Navigate to another page. The same public files should show memory/disk
   cache reuse instead of a new validation request.
4. Check that HTML and API responses did not receive the immutable policy.
5. After changing a public file and rebuilding, confirm the generated HTML
   references a different version directory and displays the updated content.

Local checks passed against Cloudflare's Pages runtime: 41 valid header rules,
real Chrome cache reuse for CSS/JS/logo across page navigation, unchanged HTML
policy, and `no-store` auth/quiz error responses. Teacher/admin browser fixtures
also passed using the generated files and mocked Firebase. These are local
checks, not confirmation that this version is deployed.

Official references: [Pages caching defaults](https://developers.cloudflare.com/pages/configuration/serving-pages/#caching-and-performance)
and [versioned public assets with custom headers](https://developers.cloudflare.com/pages/configuration/headers/#configure-custom-browser-cache-behavior).
