# End-to-end tests

Playwright drives the operator console in a real browser, against the real
stack: nginx serving the built bundle, FastAPI behind it, Postgres behind that,
and a camera worker running the production `people.pt` and `gender.pt` on the
mediamtx demo stream. Nothing is mocked. When these pass, the wiring works, not
just the React components.

## Running

```bash
docker compose up -d --build                    # from the repository root
docker compose exec -T postgres psql -U gender -d gender_db < database/seed.sql
E2E_ADMIN_PASSWORD=<BOOTSTRAP_ADMIN_PASSWORD> ./e2e/run.sh                         # whole suite
E2E_ADMIN_PASSWORD=<BOOTSTRAP_ADMIN_PASSWORD> ./e2e/run.sh tests/03-analytics.spec.js  # one file
```

`run.sh` runs the tests inside `mcr.microsoft.com/playwright`, so you need
nothing installed locally beyond Docker. The image already has the browsers
and their system libraries. It runs with `--network host`, so `BASE_URL`
defaults to `http://localhost:8083` (the console's published port) rather than
a compose service name.

`E2E_ADMIN_PASSWORD` (and `E2E_ADMIN_USERNAME`, default `admin`) must match the
`BOOTSTRAP_ADMIN_*` values the API was started with. There is no public signup,
so the bootstrap admin is the only account the suite can start from.

Results land in:

| Path | What |
| --- | --- |
| `playwright-report/` | HTML report, opened with `npx playwright show-report` |
| `results.json` | machine-readable summary |
| `test-results/` | screenshots of every page the specs visit (`light-*`, `dark-*`, `mobile-*` from spec 05); video and trace for failures |

To run against a different origin, such as a staging deploy or the Vite dev server:

```bash
BASE_URL=http://localhost:5173 ./e2e/run.sh
```

## Two kinds of data

**The seed is a fixture.** Specs 03 and 04 assert against `database/seed.sql`:
three cameras across two buildings and four zones, plus 14 days of snapshots and
visits. Analytics need history, and waiting for a live camera to build two
weeks of it is not an option. The seed's camera ids and zone names are in
`SEED` (`tests/helpers.js`). The specs assert on shapes and invariants rather
than exact counts, for example shares that add up to 100% and peak hours inside
the seeded opening hours. That way a re-seed on a later day, or a live camera
adding rows, does not break them.

**Spec 02 counts for real.** It registers a camera on `rtsp://mediamtx:8554/gender`,
waits for its worker to label at least one person, and checks that the
occupancy adds up, that snapshots are written on the camera's 15-second
override with their annotated frame, and that the detail page shows gender
chips. On a GPU this takes seconds. On CPU, loading both models and the first
labels can take a couple of minutes, which is why that test has a 300 s budget.

## Auth: one login, shared by everything

Every route except `/health` and `/login` needs a session. Rather than have
every file log in, `global.setup.js` runs once as a Playwright *setup project*.
It logs in as the bootstrap admin through the real `/login` page and saves the
browser's storageState (the access/refresh tokens in `localStorage`, plus the
httpOnly cookie the image routes accept) to `.auth/admin.json`. It also creates
one operator and one viewer account for the role assertions. `chromium`, the
project that runs `01`–`07`, starts every test already signed in.

The bare `request` fixture used for direct API assertions is a *separate*
context from the browser. It only inherits the cookie, and the JSON API
requires the bearer header (the cookie is accepted on image routes only, see
`get_image_viewer` in `backend/app/api/deps.py`). So any spec that calls
`request.get/post/patch/delete` directly passes `{ headers: authHeaders() }`,
which reads the token back out of `.auth/admin.json`.

`00-auth.spec.js` runs in its own project, signed out on purpose. It covers the
login page, a wrong password, the redirect-and-return flow, and what a viewer
and an operator can and cannot reach.

## The specs are one story

`playwright.config.js` runs a single worker, files in order, and they share
state:

| File | What it covers |
| --- | --- |
| `00-auth.spec.js` | Login (by username or email), bad credentials, redirects, role boundaries, forgot password; runs signed out |
| `01-shell.spec.js` | Health, input validation (timezone, date range), every route renders, nav, 404, theme toggle |
| `02-camera-lifecycle.spec.js` | Register a camera through the form, validation, start/stop its worker, real counting off the demo stream |
| `03-analytics.spec.js` | InsightEye's two endpoints and the extended reports against the seed; every Analytics tab draws; the location cascade; the dashboard |
| `04-visits-snapshots.spec.js` | Visits filtered by gender, paging, CSV export; the Snapshots grid and frame dialog |
| `05-full-app.spec.js` | The System page; frames on the live MJPEG view; a viewer cannot control a camera; an account's whole life on the Users page (create, change role, admin reset, own password change, deactivate, delete); a session that survives an expired access token; every page at phone width with no sideways scroll and reachable paging; every page in light and dark mode |
| `06-workspaces.spec.js` | Create a workspace, a camera in it, switch to it, a non-member is shut out, delete it |
| `07-teardown.spec.js` | Edit the camera's place, stop, delete; check that the seed survived |

The password-reset test reads the emailed code from a [mailpit](https://mailpit.axllent.org)
SMTP sink. It runs only when the API has `SMTP_HOST` pointed at that sink
(`SMTP_PORT=1025`, `SMTP_STARTTLS=false`) and `MAILPIT_URL` (for example
`http://mailpit:8025`) is passed to the test container. Otherwise it is skipped.
The compose file does not include mailpit; add `axllent/mailpit` to the stack in
a compose override and pass the `SMTP_*` values to the api service to run it.

Anything that has to survive between files is re-read from the API
(`findCamera`), never kept in a module variable, because each spec file gets a
fresh module registry. The files run in order rather than in parallel: two
files racing would fight over the camera-name uniqueness constraint and over
the same workers.

## Conventions worth keeping

**`collectPageProblems` runs on most specs.** A React page that throws still
renders its shell, so a passing visual assertion can hide a broken component.
Console errors are collected and asserted empty at the end. Image 404s and
503s are filtered out: a snapshot whose frame was never stored is a state the
UI renders a fallback for on purpose.

**Assertions check the API as well as the page.** A form that navigates
correctly but wrote nothing is the failure worth catching, so the write specs
read the row back. In particular, `02` checks that a blank override is *absent*
from `settings`, not stored as `0`.

**`07` verifies the seed survived.** Deleting a camera cascades to its visits
and snapshots, so a stray delete would quietly gut the fixture and make the
next run fail somewhere unrelated.
