# Data-fetch performance

## What was measured

Read-only requests against the production website and bounded reads using the
existing Firestore service account. No records were changed. Private document
contents, identifiers, cookies and keys were excluded from the saved timings.
Browser inspection was unavailable because it is disabled in Work settings.

| Check | Observed time | Scope |
| --- | ---: | --- |
| Production login HTML | 223 ms | Network request, not a browser paint measurement |
| Production school-year response | 363, 857, 509 ms | Three samples, 18-byte body |
| School-year Firestore read, warm token | 309, 405 ms | From this computer; includes network |
| School-year read, cold service token | 1,615 ms | Includes OAuth token acquisition |
| Student page before count changes, 25 rows, 12 assigned sections | 3,815 ms | Local gateway + live Firestore; excludes Cloudflare sessions/browser |
| Dashboard report before count changes, 25 rows, all three terms | 4,033 ms | Same diagnostic scope |
| Student page with selected-term results for eight students | 2,537 ms | Same diagnostic scope; zero COUNT requests |
| Initial dashboard report after changes, 25 rows, all three terms | 2,305 ms | Same diagnostic scope; zero COUNT requests |
| Empty Archived tab, 12 sections, sequential queries | 8,853 ms | Same diagnostic scope; zero COUNT requests |
| Empty Archived tab after bounded parallel queries | 3,757 ms | Same diagnostic scope; zero COUNT requests |

These are diagnostic samples, not a production p95 or a capacity guarantee.
Firestore server processing time and end-to-end network time are different
measurements. A successful HTTP 200 does not mean a response is fast.

## Main findings

1. **Section counts added substantial avoidable work before useful content.**
   With 12 sections, exact active/archived totals require 24 COUNT requests.
   The dashboard no longer requests them: its complete roster supplies active
   totals. Student Records shows its page before any missing totals arrive.
2. **The school year was polling much too often.** Every label subscribed to
   a 15-second poll, and every focus/visibility event triggered another read.
   Teacher pages used authenticated data requests for an already-public label.
3. **The scheduler also polled all three small term collections every 15
   seconds.** Each term has its own timer, so later refreshes can become
   separate HTTP requests. It also queried the teacher profile after identity
   verification, although identity already returns the current profile ID.
4. **Network round trips amplify sequential dependencies.** An empty Archived
   tab was checking 12 sections sequentially. It now queries at most four at
   once and filters archived students in Firestore. Individual bounded
   reads took hundreds of milliseconds. The existing database is in `nam5`
   (US multi-region), as recorded in the previous database metadata check.
   That supports investigating distance and request chains; it does not prove
   that database capacity is exhausted. Firebase recommends locating compute
   and data close to users: [Firestore best practices](https://firebase.google.com/docs/firestore/best-practices).
5. **Some paths still need architectural work for large datasets.**
   Admin reports load the entire student roster and Term 1 results before
   summarizing it. The quiz library downloads full quiz documents, including
   questions. Teacher dashboard averages correctly cover all assigned students
   and all three terms, but currently calculate those averages by progressively
   reading every report page. At 1,000 active students the updated fixture uses
   11 report requests rather than about 40, but a full calculation still needs
   up to 12,000 lesson-document lookups. Batching reduces network round trips;
   it does not remove this underlying read workload.

## Changes in this patch

- School-year labels reuse a five-minute public-value cache across pages and
  poll every five minutes. Only `startYear` and `checkedAt` are stored. Admin
  editors still read live on entry; successful saves refresh immediately, and
  same-browser tabs update through storage events.
- Focus events no longer request fresh snapshots again or queue another read
  merely because a request is already running. Hidden subscriptions retain
  their timer without fetching until visible. Local writes still force refresh.
- Scheduler background checks run once per minute. Its section lookup and
  the quiz generator use the verified identity's teacher ID when available.
- Section totals reuse the existing owner-scoped view cache for 60 seconds,
  shared by Student Records, reports and batch-upload counts. Data still goes
  through live server authorization on every request. Cached totals are rejected
  if the current assigned class IDs differ, expire automatically, and are
  invalidated with other views after a successful local save. External changes
  can take up to one cache interval to appear in totals.
- Student Records keeps its visible page at 25 students. Its authorized roster
  request can include results for at most eight students in the selected term;
  remaining cards retain lazy loading. An optional performance-read failure
  leaves the roster usable and allows the existing card retry. Missing exact
  totals arrive separately and update badges without rebuilding the cards.
- Reports show the first 25 students, then fill in batches of up to 100 while
  visible. Each Firestore lesson batch contains at most 100 document paths,
  with at most four concurrent batches. Leaving or hiding the page stops further
  initial work. Background checks replace one existing page per minute while
  preserving the visible content. Reports do not request startup counts; exact
  active totals come from the complete roster, and unknown totals display a dash.
- A complete, recently checked dashboard cache can supply narrower section/term
  views in Analytics and Student Records after authentication. Term changes reuse
  held results; missing curriculum fetches only that term's lesson metadata.
  Failed curriculum reads retry automatically without downloading the held
  student results again. Incomplete, expired or unavailable caches fall back to
  the normal authorized requests. Automatic checks still update results because
  mobile changes do not invalidate the website's browser cache directly.
- Archived roster queries include `active == false`. Up to four assigned
  sections are checked concurrently; probes for following sections return at
  most eight profiles each. Cursor traversal stays ordered and paginated, even
  when most sections are empty. Active queries retain support for older student
  records whose `active` field is absent.

These changes reuse the existing JavaScript modules and styles. No dependencies,
new background services, or requests for private data before login were added.
Firebase billing remains disabled. Automatic stored summaries maintained by
Firebase write triggers were deferred; they are not part of this patch.

Batch Upload now requests its verified teacher profile and assigned sections in
one metadata request, reusing the profile already checked by authorization. It
does not fetch student profiles or wait for all-section totals to enable the
section picker. Only the selected section's missing count refreshes afterward;
the resulting count is saved with the existing view cache. Quiet updates retain
the dropdown and previous values. The heading no longer has a fetch spinner.

While access is being checked, static page frames and generic headings remain
visible. Sensitive values, profile names and controls remain hidden and the main
content is inert until verification succeeds. The same guard covers logout and
back-button restoration. Pages still use normal HTML navigation; this change
does not turn the website into a single-page application or guarantee a fresh
database response within a few milliseconds.

Account verification overlaps the independent live profile and Firebase Auth
status reads. Both still must pass. A section-metadata diagnostic before this
change measured 1,654 ms overall, with 1,332 ms in verification and 321 ms in the
section query. This sample explains why removing a spinner alone cannot make
fresh reads immediate; it excludes the browser and Cloudflare session requests.
A later sample with overlapping verification measured 1,138 ms overall: 328 ms
in verification and 809 ms in the section query. Network variation prevents
treating these two samples as a guaranteed percentage improvement.

## Verification and measured limits

Regression coverage checks repeated focus events, delayed polling, expired/corrupt
cache entries, post-save invalidation, changed class membership, account isolation,
and unchanged visible cards while totals update. The 1,000-student report fixture
checks 25-first/100-later batching, zero requested counts, and reuse across reports
and Student Records without repeated result reads. Additional fixtures check
selected-term prefetch limits, failed optional performance reads, bounded lesson
concurrency, and ordered pagination through empty and populated archived sections.
Existing authentication, section ownership, schedule deadlines and quiz release
checks remain in place.

The live-read samples above were taken under different network conditions. They
identify request chains and avoidable work; they do not establish a percentage
speed guarantee, production p95, or capacity for 1,000 simultaneous users. Exact
cold averages still require relevant student results, and browser storage limits
can prevent cache reuse. Authentication remains a required part of each visit.

## Next work, in order

1. Store authoritative per-section counts and report summaries, maintained by
   server-side changes/triggers for both website and mobile writes. Backfill and
   reconciliation are required so imports, archives, restores and mobile progress
   update totals correctly. This removes the repeated cold aggregation fan-out
   and avoids scanning every result just to show dashboard cards. Keep detailed
   student results paginated and loaded only when needed.
2. Give admin reports bounded metadata endpoints and stored summary reads;
   reuse the existing summary display. Give the quiz library a metadata-only
   paginated list and fetch questions only when opening an editor or attempt.
3. Measure authenticated production p50/p95 by endpoint and stage (session,
   profile, roster, counts, lessons). Only then decide whether placing server
   compute nearer Firestore is worthwhile. Moving the existing database is a
   separate migration affecting mobile too, not the first quick fix.
4. Run realistic staging load tests against the actual backend with sanitized
   data. The repository's in-memory load tests verify bounded requests and
   isolation; they cannot establish production capacity.

No database rules, indexes, record schemas, credentials or production deployment
were changed by this patch.

## Local checks

Run `npm test` and `npm run build` before publishing. `npm run test:rules`
checks the Firestore emulator using synthetic records. `npm run test:load`
exercises bounded requests against an in-memory fixture, not production capacity.

The build publishes only generated public HTML, JavaScript, CSS and assets.
The tests, docs, server source, security files and local diagnostics are not
published as static website files. They cannot cause browser data-fetch delays.

Initial data sections use the shared spinner after a short delay, without
loading text or a page-wide overlay. Login and save buttons retain their action
labels while busy. Quiet background refresh keeps the current content visible;
errors, actual empty results and confirmed saves retain their messages.
