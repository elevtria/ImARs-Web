# Deploy ImARs to Cloudflare Pages

The project uses static HTML/CSS/JavaScript and a Pages Function at
`functions/api/generate-quiz.js`. The existing frontend already calls
`/api/generate-quiz` with its Firebase sign-in token. The Function checks the
teacher role and section ownership before contacting Gemini.

## Build settings

Use the existing GitHub repository, `elevtria/ImARs-Web`:

| Cloudflare setting | Value |
| --- | --- |
| Framework preset | None |
| Production branch | `main` |
| Root directory | Repository root; leave the override empty |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Project name | `imars-web`, matching `wrangler.jsonc` |

The generated `dist` folder contains only HTML pages, CSS, browser JavaScript,
public assets, and `_routes.json`. Editor state, local secrets, dependencies,
tests, and backend source are excluded from static hosting. Cloudflare bundles
the root `functions` folder separately. Commit the source and lockfile; `dist`
and `node_modules` are generated and ignored.

The route configuration invokes the Function only for `/api/generate-quiz`, so
static page and image requests do not use the Function's request quota.

## Account steps for the owner

1. In Cloudflare, open Workers & Pages and select the existing `imars-web` Pages
   project, connected to `elevtria/ImARs-Web` at `imars-web.pages.dev`.
   For a new setup, create a Pages project and connect GitHub, granting access
   only to `elevtria/ImARs-Web` when choosing repositories.
2. Enter the build settings above and select the Free plan. A custom domain and
   paid billing are not required for this setup.
3. Open the Pages project's Settings > Variables and Secrets. Add
   `GEMINI_API_KEY` as an encrypted secret for Production. Enter the key directly
   in Cloudflare, rather than in GitHub, JavaScript, or chat.
4. Redeploy after adding the secret. A Preview deployment needs its own Preview
   secret if quiz generation should work there too.
5. If Firebase reports `auth/unauthorized-domain`, add the exact deployed
   `pages.dev` hostname to Firebase Authentication > Settings > Authorized domains.
   Keep the current Firestore rules and teacher/section permissions in place.

Cloudflare account authorization must be completed by the account owner before
the agent can inspect or publish to the account. A GitHub installation/permission
prompt also requires the owner's review.

## Local commands

```powershell
npm ci
npm test
npm run build
npm run dev
```

For local quiz generation, create an ignored `.dev.vars` file containing
`GEMINI_API_KEY` with your real value. The static site can be checked without a
key; generation returns a configuration error until the secret is supplied.

After Cloudflare authorization and project setup, `npm run deploy` builds and
uploads to the configured Pages project. Git-connected Pages projects can also
build automatically when changes are pushed to `main`. Do not create a separate
Direct Upload project if you want the guide's Git-based deployment workflow.

## Verify the live site

- Open `login.html` and confirm branding, styles, and the password toggle load.
- Sign in with a teacher account and confirm the assigned sections load.
- Open Quiz Generator, select that section, and upload a short PDF/DOCX/PPTX.
- Generate and review a quiz. Confirm questions, options, and correct answers
  appear; save a draft and check it in My quizzes.
- Check a marker ZIP download and the QR offline-sync page.

The backend currently uses `gemini-3.5-flash-lite`, with `gemini-3.8-flash` as a
fallback if the primary model is busy. Availability, billing and quotas depend
on the Google project. Quota exhaustion returns HTTP 429. The Function disables
Interactions API request storage with
`store: false`; Google's separate free-tier data-use terms still apply.

Server-side teacher and section authorization is implemented. No additional
per-teacher request limiter is configured yet; model quotas still apply. Do not
send private student records as quiz learning material.

## Quiz formats

The website supports multiple choice, true/false, essay, identification with
explanation, and modified true/false. Written questions keep teacher-editable
model answers, explanations or rubrics, and points. Modified false statements
include a corrected statement. These records use schema version 2. Student
answering and grading in the mobile app require a later mobile update; this
website change does not install that update or automatically grade essays.

Multiple-choice generation performs an additional independent relevance check
on all options. Questions are withheld when that check fails or cannot complete.
It shares the existing generation deadline and temporary PDF upload; it does
make a second AI request. Teacher review remains necessary because AI checks
can make mistakes.

## References

- [Cloudflare Git integration](https://developers.cloudflare.com/pages/get-started/git-integration/)
- [Pages Function routing](https://developers.cloudflare.com/pages/functions/routing/)
- [Encrypted secrets](https://developers.cloudflare.com/pages/functions/bindings/#secrets)
- [Pages file limits](https://developers.cloudflare.com/pages/platform/limits/)
- [Gemini free-tier pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Interactions storage behavior](https://ai.google.dev/gemini-api/docs/interactions-overview#data-storage-and-retention)
