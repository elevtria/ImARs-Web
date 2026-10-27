# Checking page loading time

The production build also versions public CSS, JavaScript, and brand images
for browser reuse without repeat validation. See [Public file caching](static-caching.md)
for its scope, update behavior, and deployment checks.

Teacher login redirects after authentication. It no longer prepares an entire
student report before redirecting, waits for the optional password manager,
or makes a redundant configuration request before submitting credentials.

The production build compiles the existing Tailwind theme and utility classes
to a versioned CSS file. It removes the Play CDN compiler and its DOM observer
from published pages. Fonts retain their existing provider; app styles and
authentication are unchanged. The sidebar uses the teacher name returned by
the verified identity response instead of a second profile request.

Dashboard and Analytics use authenticated report pages of at most 25 active
students in one selected term. The server shares ownership checks and uses one
Firestore batchGet for their four fixed lesson IDs (at most 100 documents).
This removes 25 separate database network calls per report batch. Missing
lesson documents are handled explicitly; document-read billing still applies,
including missing document reads. Middleware session verification is
reused only inside the exact same Request; live staff status still gets checked.
Analytics defaults to the first assigned section and Term 1. Its term/section
controls select what is fetched, rather than filtering a three-term download.
Class totals are counted on the first page of a report/refresh rotation and
reused for its later pages. Curriculum reads run alongside the lesson batch.

The first report paints after its first batch. Remaining batches calculate the
selected class average progressively while that page is visible, with an explicit
"Results so far" count until the calculation is complete. Navigating away aborts
the pending browser request and stops scheduling more batches. In-flight server
reads may finish. Returning reuses completed batches and resumes the cursor;
it does not restart at the first student. Dashboard and Analytics share these
UID-owned, term/section-specific report pages. The result table displays 25 rows.

## Returning to a page

Dashboard, Analytics, Student Records, Batch Upload, and Topic Scheduler remember
their last successfully loaded view in this browser tab's `sessionStorage`.
After live website authentication confirms the same teacher, returning to one
of these pages shows the saved view. Data refreshed within 60 seconds is reused
without repeating report reads. Visible pages check for updates once a minute,
and on returning to a stale tab. Hidden pages do not poll. Changed results replace the
saved view; unchanged results do not redraw it. Search and section filters stay
selected during a background update. Topic Scheduler continues using its live
listeners after showing the saved schedule.

Entries are scoped to the signed-in UID, clear on account changes/sign-out,
and expire after 15 minutes without a successful refresh. Only display data is
cached; login checks and server authorization do not use these entries. Storage
being blocked or full falls back to normal loading. A connection failure keeps
the saved view with a short notice; denied access clears it.

Successful website writes (including imports, QR result sync, quiz saves, and
schedule edits) invalidate these views. A version marker also invalidates saved
views in other browser tabs. Results arriving from the mobile app are picked up
by each report's quiet background check. Teacher report checks update one
25-student batch per minute, rotating through the selected section. They do not
re-download the entire report each minute. A mobile change to an off-batch
student may take a full rotation to appear in the class summary; these summaries
are not real-time. A page with no saved view,
an expired entry, or invalidated data still needs its normal initial load.
During initial loading, only the relevant data section shows a small status
after 150 ms. There is no page-wide loading indicator. The header and navigation
remain visible during authentication; private content, account details and
dialogs stay hidden until the live check succeeds. Fast reads show no indicator.
This does not preserve unsaved form inputs or skip HTML/script loading.
The authentication guard is silent: it displays no "Checking your sign-in" text.

Analytics no longer falls back to querying all teachers, all classes, or all
students when the signed-in teacher has no profile, sections, or students.
An empty section stays empty. No schema, Firebase rules, indexes, mobile code,
or Cloudflare account settings were changed.

## Admin pages

Admin Dashboard, School Analytics, Manage Teachers, and Admin Profile use the
same session-scoped saved-view behavior and small, nonblocking initial loading
status. Dashboard, School Analytics, and Manage Teachers share one summary, so
visiting any one of them also prepares the saved display for the other two.
The administrator profile is verified on every visit; recent school reports are
reused rather than downloaded again. Re-verifying a role does not extend a report's
freshness. Admin Profile remembers only its display
and contact fields; the reports store teacher display fields and aggregates,
without storing student records or credentials in these entries.

The admin reports now fetch teachers and students concurrently, then fetch
students' Term 1 lesson results through the same eight-request pool. This
preserves the reports' current Term 1 coverage, score rounding, heatmap fallback,
AR time calculations, section order, and existing teacher assignment fallback.
Dashboard table rows are inserted in a single DOM batch. Each page also fills
its sidebar from its existing profile read instead of querying the same profile
again.

A fresh, unique, UID-linked admin profile is checked before reading school-wide
data or enabling edit buttons. Missing, inactive, or non-admin profiles return
to login rather than using another administrator's profile. Saved display data
does not authorize actions. Profile edits use only the document ID from that
fresh profile, and a quiet refresh preserves open form inputs. Teacher searches
and the Analytics teacher/section view also survive quiet refreshes. Successful
teacher, profile, and school-year writes invalidate saved views; a write during
a pending refresh makes the admin page re-read rather than paint older values.
These checks supplement the existing Firebase/server permissions; browser
caching is not a replacement for those permissions.

The controlled browser comparison in `admin-performance-benchmark.json` uses
30 synthetic students, four Term 1 lessons each, and 100 ms of artificial delay
per query. The three reports fell from about 3.4–3.5 seconds to 0.8 seconds;
saved displays returned in about 0.1 seconds. This is a local regression check,
not a measurement or guarantee of production Firebase latency. The profile
already needed just one query, so its initial load remains about the same;
its benefit is the immediate saved display on return visits.

## Measure on your real account

### Indexes and connection reuse

The site uses static browser modules, Cloudflare Pages Functions and the
Firestore HTTPS API. It does not open SQL connections, so a Node SQL connection
pool is not applicable. The Google access token is reused until near expiry;
concurrent refreshes for the same service-account key/email now share one pending
request. A failed refresh is released so later requests can retry. Staff session
and role checks still run as described above.

A read-only Firebase CLI index check on 2026-10-27 returned no composite indexes
and no field overrides. The current UID/teacher/class/role/active filters use
Firestore's automatic single-field indexes and equality index merging. This
does not make substring name search indexed: it still uses bounded scans.
Prefix/full-text name search would require a separate data/search design.

### Repeatable local load check

Run `npm run test:load -- --vus 50 --iterations 6 --students 1000`.
The command starts and stops a loopback HTTP server using the real middleware
and data handlers against synthetic in-memory fixtures. It accepts no production
URL or credentials and writes no student records. Virtual users share a fixture
teacher session. Requests alternate between student pages and one-term report
pages, advance cursors, check ownership/output bounds, and report failures,
response sizes, throughput and latency percentiles. `--delay-ms N` optionally
adds artificial delay to each fixture database operation; `--out path.json`
saves the measured summary.

Local run on 2026-10-27, 1,001 fixture students, no artificial delay:

| Virtual users | Requests | Failures | p95 HTTP time |
| --- | --- | --- | --- |
| 10 | 60 | 0 | 84 ms |
| 25 | 150 | 0 | 175 ms |
| 50 | 300 | 0 | 341 ms |

Every response held at most 25 students and every report batch requested at most
100 selected-term lesson documents. These numbers measure this machine and
fixture implementation; fixture queries scan memory rather than using Firestore
indexes. They exclude Cloudflare, Google network latency, billing limits and
real multi-account traffic. They do not establish production user capacity.
Production capacity should be measured separately against an isolated staging
deployment with representative test accounts/data and a tool such as k6.

Student Records uses server-side cursor pages of at most 25 profiles. Active
and archived totals use Firestore COUNT instead of downloading every profile.
Only visible/opened cards fetch their selected term-result collection. Loaded
results are reused within the authenticated tab; an error shows a local retry.
Paging, archiving, restoring and deleting do not reload HTML or re-read other
students' results. Bulk section archiving still includes off-page students and
retries only unfinished batches.
Changing the Student Records term also reuses the current roster page instead
of downloading its profiles and counts again. Unchanged section options are
retained during quiet refreshes so a native dropdown is not closed by rebuilding
its children. Grouped fixed-lesson reads use a profile batch for live ownership
checks followed by bounded lesson batches (at most 100 documents each), instead
of one lesson collection query per student. The entire group must be authorized
before lesson results are read or returned. These changes reduce round trips,
not Firestore's per-document read charges.

Name/ID searches retain case-insensitive matching over assigned sections, using
bounded scans of at most 100 profiles per server request. A rare search may scan
more than one batch; it does not fetch those students' lesson results. Counts
and class ownership remain server-verified. Tests cover 1,000 sample profiles,
page boundaries, cache reuse, denied writes and partial bulk failures.

Exact class averages still require the initial selected-term result reads from
the existing per-student collections. Background batching makes that calculation
nonblocking, but does not eliminate its database reads. Stored summary documents
maintained when mobile/offline results change would eliminate the repeated scan;
that write-side aggregation is not implemented here. Redis or extra web servers
would not remove this underlying read pattern by themselves.

For Dashboard and Analytics, inspect the teacher-report-page requests in Network.
Each contains one termId and a cursor and returns at most 25 students. The
Server-Timing response header separates handler authentication and data time.
It excludes middleware/network time; compare it with browser TTFB and total
duration. A 200 status is success; a duration alone is not evidence of a failed
fetch. Student Records uses student-page followed by selected-term reads for
visible cards.

1. Open an admin report page and wait for its data. The diagnostic below applies
   to the older admin loader, not the new teacher report-page endpoint.
2. Press **F12**, open **Console**, and run:

   ```js
   console.table(window.imarsPerformance)
   ```

   `dataMs` measures the elapsed time awaiting the page's database stages,
   including query queueing and SDK response processing. `renderMs` measures
   synchronous report calculations and DOM updates. `startupMs` is the time
   from navigation until the authenticated page starts its data load (including
   scripts and restoring authentication). `readyMs` is the time from navigation
   until the next animation frame after the report finishes; it is not a
   guarantee that the browser has finished painting. `queries` counts one-time
   `getDoc`/`getDocs` calls through the shared reader, excluding streaming listeners,
   started in this interval, including shared background reads. These are
   application measurements, not billable Firestore read counts.

3. In **Performance**, start recording and reload. Stop after data appears.
   Look for **ImARs: Dashboard/Analytics data** and **render** under
   **Timings**. Network/long tasks can then be compared with these spans.
4. In **Network**, enable **Preserve log**, reload, and sort by **Duration**.
   Use **Fetch/XHR** for database traffic and **All** for page/scripts/images.
   A Firestore streaming connection may remain open after data has arrived;
   its full request duration is not the same as the report's loading time.
5. To examine Cloudflare, click the main HTML request and view **Timing**
   (especially TTFB) and **Headers → Response Headers → CF-Cache-Status**.
   That header describes that response, not the separate Firebase queries.
   On `127.0.0.1`, the page is served locally and does not pass through Cloudflare.
6. Compare one normal reload with a reload using **Disable cache**, on the same
   account, page, and connection. Leave Disable cache unchecked for normal use.

`cacheHit: true` indicates that this visit displayed a saved view before checking
Firebase. The diagnostic object contains timing/count information only, without student
names, IDs, scores, or tokens. It is local to the open page and is not uploaded.

The older admin report loader still scans student results. The teacher report
loader batches selected-term reads, but still scans the selected class for exact
averages on a cold load. Neither is a write-time summary pipeline. Production
latency and capacity have not been established by the local fixture tests.
Do not cache private reports in a public CDN.

References: [Firestore best practices](https://firebase.google.com/docs/firestore/best-practices#read_and_write_operations),
[Firestore aggregation queries](https://firebase.google.com/docs/firestore/query-data/aggregation-queries),
[Firestore indexes](https://firebase.google.com/docs/firestore/query-data/index-overview),
[k6 scenarios](https://grafana.com/docs/k6/latest/using-k6/scenarios/),
[Firestore caching behavior](https://firebase.google.com/docs/firestore/manage-data/enable-offline),
[Cloudflare cache response headers](https://developers.cloudflare.com/cache/concepts/cache-responses/).
