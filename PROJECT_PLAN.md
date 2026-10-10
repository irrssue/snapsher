# Snapsher: next release and roadmap

## Assessment

The product already has its essential loop: verified email registration and
password recovery, a server-enforced photo every 12 hours, friends and requests,
a private feed, captions, likes, comments, avatars, and account deletion.
`about.md` makes restraint the product: public engagement metrics and share
buttons would work against it. The next release should strengthen the existing
photo experience before introducing another social mechanism.

The clearest actionable gap is the profile archive:

- `listPostsFor` previously stopped at 300 photos without any way to retrieve
  the rest. At the maximum posting cadence that covers only about five months.
- Both profile callers swallowed grid errors. A failed request could claim an
  account had no photos even while its header reported a nonzero post count.
- A profile fetched up to 300 summaries and mounted all their controls at once.
- No repeatable server test command existed to guard archive visibility,
  private likes, or the posting cooldown during further development.

Other gaps worth investigating next: recoverability of the database and photo
files, new-user discovery, and stale data after a long-lived tab resumes. These
have less evidence here than the reproducible archive defects. The completed
email-verification note in `ongoing.md` is historical, not outstanding work.

## Execution scope: complete, reliable profile archives

This is the implementation plan for this release. All items below are included
in the current task; the later roadmap is a prioritized backlog.

1. **Bounded archive API.** Return 36 photos per explicit page and a nullable
   continuation cursor. Order by timestamp and id so equal timestamps cannot
   lose photos. Use a cursor rather than an offset so newer inserts and deletion
   of the last displayed photo do not shift the next page. Add an index matching
   the archive ordering. Keep the existing response for older browser bundles.
2. **Preserve the privacy boundary.** Check owner/friend access on every page.
   Reject malformed cursors. Keep like counts exclusive to the owner; preserve
   authenticated photo delivery and the independent 12-hour posting window.
3. **Expose the archive deliberately.** Give own and friend profiles a shared
   archive with an explicit “Load older photos” button. Keep the home feed
   finite. Do not introduce automatic endless loading or notification loops.
4. **Make states honest.** Show loading placeholders, a retryable error for
   failed initial reads, and existing photos beside a failed continuation.
   Retrying must repeat the failed operation. Remove the continuation control
   at the end, and show empty copy only after a successful empty read.
5. **Handle changes and races.** Ignore obsolete responses, prevent duplicate
   continuation requests, preserve the loaded archive during count refreshes,
   and invalidate reads when deleting a photo. Refresh friend-profile counts
   after comments, just as the owner profile does.
6. **Validate and ship.** Build both applications, lint the frontend, run
   database/HTTP regression tests against an isolated temporary database,
   exercise loading and failure recovery in a local browser preview, commit
   and push to main, rebuild the homeserver, and verify the served application.

## Acceptance evidence

- Eight automated tests pass with `cd server && npm test`.
- A 317-photo archive, including identical timestamps, is returned completely
  in order with no duplicates; the legacy endpoint still caps at 300.
- Empty and exact-36-photo archives terminate correctly.
- Inserts and deletion of the cursor row between pages do not skip older photos.
- Strangers and former friends cannot reuse another viewer's cursor for access.
- Owner-only like counts stay private across first and continuation pages.
- Deleting a photo does not refund the 12-hour posting window.
- HTTP tests cover authentication, unknown profiles, invalid/repeated cursors,
  legacy callers, and the new page contract.
- Frontend and server production builds pass. Frontend lint reports existing
  state-in-effect warnings in existing components; there are no lint errors.
- Local browser fixtures verify 36 → 40 photos, terminal-page button removal,
  first-page failure and retry, continuation failure and retry without losing
  existing photos, and the friend modal's loading/grid layout. Fixtures use
  synthetic accounts and images; they do not touch production accounts.

## Prioritized backlog after this release

| Priority | Next work | Why | Completion criteria |
| --- | --- | --- | --- |
| 1 | Backup and restore drill | A homeserver holds the sole database and uploaded photos; recovery is more valuable than a new engagement feature. Existing backup arrangements have not been verified. | Inspect current arrangements, create consistent database plus photo snapshots with restrictive access and retention, restore to an isolated checkout, and document the verified recovery procedure. |
| 2 | Refresh on resume and user request | Long-open tabs can miss new photos, requests, friendship changes, and quota updates from another device. | Refresh when a visible tab resumes after a bounded stale interval, offer a manual feed refresh, preserve existing content and scroll, and verify racing requests and offline recovery. |
| 3 | Better friend discovery | The feed cannot become useful until someone adds people they know; username search is currently the main entry. | Add a direct add/request action to public profiles with incoming/outgoing states and cancellation; keep friend counts private and test duplicate and crossed requests. |
| 4 | Broaden regression coverage and automate checks | Authentication and image handling are mature but lack equivalent repeatable coverage. | Add isolated tests for signup/reset possession and expiry, image validation, CSRF, session expiry, and friendship mutations; run tests and builds before future deploys. |

Decide between additional features only after observing where real users fail
in signup → first friend → first photo. Avoid public metrics, sharing, or push
notification campaigns without a concrete reason consistent with `about.md`.

## Deployment and rollback

No dependency is added. The database change is an additive index, with no data
rewrite. Existing API consumers retain their bounded archive response. Deploy
with the repository's prescribed main-branch push followed by homeserver pull,
both builds, and PM2 restart. The deployment must finish with PM2 online and
successful HTTP checks. If this release must be reverted, revert its commit,
push main and repeat the same rebuild; the unused index can safely remain.
