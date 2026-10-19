# A Bloc

A Bloc assigns gear to your activities based on the sensors recorded in
the original FIT file. For example, you can map a power meter's ANT+ ID to a
piece of Strava gear and have the app tag matching rides.

## How it works

Strava's public API does not expose the original FIT file for an activity or
the individual sensors recorded in it. A Bloc gets the FIT file from
Garmin Connect, Wahoo, Hammerhead, COROS or a Strava web session, parses it
locally, then matches the discovered sensor keys to your gear mappings.

You can process activities in four ways:

- **Webhook:** Strava notifies the app about new activities. The app records
  the event in its database, acknowledges it, and a background worker checks
  each connected original-file source for an activity with the same start
  time, parses the FIT file, then applies a matching gear mapping. If every
  connected source answers but none has the activity yet (for example, the
  device has not finished syncing), the job is retried. Failed jobs
  are retried up to three times, and jobs interrupted by a restart resume on
  the next start.
- **Manual sync or Tag button:** Run the same matching process on demand.

## Project layout

- `src/server.js` — process startup, webhook worker, graceful shutdown.
- `src/app.js` — Express app; routes live in `src/routes/` by feature.
- `src/config.js` — the only place environment variables are read and validated.
- `src/db.js`, `src/migrations.js` — SQLite connection and versioned schema.
- `src/store/` — table access; together with `settings.js`,
  `session-store.js` and `webhook-queue.js`, the only modules that contain SQL.
- `src/webhook-queue.js` — durable queue for Strava webhook work.
- `src/strava.js`, `src/garmin.js`, `src/wahoo.js`, `src/hammerhead.js`,
  `src/coros.js`, `src/strava-web.js`, `src/sync.js` — external services and
  the FIT-to-gear pipeline; `src/original-file.js` holds helpers shared by the
  original-file sources.
- `public/` — static front end; `common.js` holds the shared `api()` and
  `escapeHtml()` helpers.
- `test/` — `node:test` suites (`npm test`).

## Run locally

1. Create an API application at <https://www.strava.com/settings/api>. Set its
   **Authorization Callback Domain** to `localhost`. A separate Strava API app
   for local development is recommended so its callback domain can differ from
   the production app.
2. Copy `.env.example` to `.env`. Set `STRAVA_CLIENT_ID`,
   `STRAVA_CLIENT_SECRET`, and a long random `SESSION_SECRET` (at least 16
   characters). Set a separate random `STRAVA_WEBHOOK_VERIFY_TOKEN`.
3. Install dependencies (Node.js 20 or newer) and start the app:

   ```sh
   npm install
   npm start
   ```

4. Open <http://localhost:3000> and choose **Connect with Strava**.

The app listens on `0.0.0.0` and uses the `PORT` environment variable when
provided (default `3000`). Without `SESSION_SECRET` the app starts with an
insecure development secret and cannot store credentials; in production
(Railway or `NODE_ENV=production`) it refuses to start.

Run the tests with `npm test` (Node's built-in test runner; each test file uses
a throwaway database).

## Deploy to Railway

1. Create a Railway project from this repository and use its Node builder. It
   installs dependencies from `package-lock.json` during the build.
2. Set the Railway **Start Command** to:

   ```sh
   bash start.sh
   ```

   The script only starts Node (with `exec`, so Railway's termination signal
   reaches the app process); it does not install dependencies. Railway's Node
   builder detects `package.json` and installs them during the build. If your
   service has a custom build setup that skips dependency installation, set its
   **Build Command** to `npm ci --omit=dev`. You can also set the **Start
   Command** to `node src/server.js` instead of using the script.
3. Add the production values from `.env.railway.example` under the Railway
   service's **Variables**. Railway does not automatically load that example
   file; it documents the values to configure in the dashboard. Use the
   production Strava API app's credentials and generate production-only
   secrets:
   - `STRAVA_CLIENT_ID`
   - `STRAVA_CLIENT_SECRET`
   - `SESSION_SECRET` — a long random value of at least 16 characters. Keep it
     stable across deploys; it is used to encrypt stored credentials.
   - `APP_BASE_URL` — the public HTTPS URL for the Railway service, for example
     `https://your-app.up.railway.app` (no trailing slash).
   - `STRAVA_WEBHOOK_VERIFY_TOKEN` — a separate random value for Strava webhook
     verification.
   - `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` — set to `15`. Railway sends
     `SIGTERM` to the old deployment and, by default, waits **0 seconds**
     before sending `SIGKILL`, which kills the app before it can finish
     in-flight requests and close the database. With a drain window, the app
     stops accepting connections, waits for pending requests and the running
     webhook job, closes SQLite, and exits; it gives itself the drain window
     minus 2 seconds. A webhook job still running at the deadline stays in the
     database and is retried by the next deployment. The app logs a startup
     warning on Railway when this variable is missing.
   Do not set `PORT` manually; Railway provides it at runtime.
4. In your Strava API application's settings, set **Authorization Callback
   Domain** to the hostname from `APP_BASE_URL`, without `https://` or a path.
   For example, use `your-app.up.railway.app`.
5. Add a Railway **Volume** to the service and note its mount path. Railway
   provides that path in `RAILWAY_VOLUME_MOUNT_PATH`; the app stores
   `app.db` directly in the volume. If you choose `/app/data`, the database
   will be `/app/data/app.db`. If the Railway variable is unavailable, set
   `APP_DATA_DIR` to the volume's mount path. The volume keeps athlete tokens,
   mappings, settings, processing history, and login sessions across deploys.
   The Strava connection and app login are retained across redeploys as long
   as the volume is mounted and `SESSION_SECRET` stays unchanged. The app login
   cookie lasts up to 30 days. The app warns at startup if it detects Railway
   without a configured volume path; data written to the container filesystem
   can be lost when Railway replaces it.
6. Deploy, open the public app URL, and connect your Strava account.

Railway provides `PORT`; the app binds to `0.0.0.0` and uses that port
automatically. To use Strava webhooks, create the subscription from the app
after deployment. Strava requires a public HTTPS callback URL, and permits one
webhook subscription per API application. Keep the local and Railway values
separate: in particular, use the Railway HTTPS URL and production Strava
credentials in Railway, and `http://localhost:3000` with local credentials in
your local `.env`. If you reuse one Strava API app, its Authorization Callback
Domain must be changed when switching environments.

## Strava permissions

The app requests these scopes:

```text
read, activity:read_all, activity:write, profile:read_all, profile:write
```

`profile:write` is used by the Segmentation page to star and unstar segments. If
you connected before granting this scope, disconnect and connect again to
authorize it.

## Getting original FIT files

Connect one or more sources under **Configure → Original Activity File**. For
each Strava activity, the app checks every connected source for an activity
that started within five minutes of the Strava start time and uses the first
FIT file it finds. The source that matches the Strava activity's recording
device (its `device_name`, such as "Wahoo ELEMNT BOLT" or "Hammerhead Karoo")
is checked first; the others follow in this order:

1. **Garmin Connect** uses the
   [`garmin-connect`](https://www.npmjs.com/package/garmin-connect) library.
   Provide your Garmin email and password. If Garmin rate-limits a login, new
   Garmin logins are paused globally until the cooldown expires; existing
   cached OAuth tokens remain usable.
2. **Wahoo** uses Wahoo's official
   [Cloud API](https://cloud-api.wahooligan.com/). The server operator
   registers an app at <https://developers.wahooligan.com>, sets its redirect
   URI to `{APP_BASE_URL}/auth/wahoo/callback`, and sets `WAHOO_CLIENT_ID` and
   `WAHOO_CLIENT_SECRET`. Each user then chooses **Connect Wahoo** and
   approves access (`user_read workouts_read offline_data`). Tokens are
   refreshed only when needed, because Wahoo limits unrevoked tokens per
   user. Wahoo sandbox apps are limited to 25 requests per 5 minutes and 250
   per day; each lookup uses one or two requests. **Disconnect** revokes the
   app's access at Wahoo.
3. **Hammerhead** uses your Hammerhead dashboard email and password (the same
   login as <https://dashboard.hammerhead.io>). Access and refresh tokens are
   cached and renewed automatically.
4. **COROS** uses your COROS Training Hub email and password (the same login
   as <https://t.coros.com>). COROS only offers its official API to approved
   partners, so this uses the Training Hub web API. The account's region is
   detected at login.
5. **Strava web session** downloads
   `https://www.strava.com/activities/{id}/export_original` using a logged-in
   session cookie. Email/password login is also available, but Strava's
   Cloudflare and CAPTCHA protections may block it.

Credentials and cached tokens are encrypted at rest using a key derived from
`SESSION_SECRET`. Sources that are not configured are skipped. If a source
cannot provide a FIT file, the app tries the next one. If none succeed, the
activity is recorded as `no_fit` and skipped; you can still upload its FIT file
manually.

To configure a Strava web session:

1. Log in at <https://www.strava.com>.
2. Open your browser's developer tools and go to **Application/Storage →
   Cookies → https://www.strava.com**.
3. Copy the `_strava4_session` cookie value into the Strava-web settings card.
   The app accepts the value with or without the `_strava4_session=` prefix.
   The cookie eventually expires and must be replaced when authentication
   errors occur.

## Gear mappings and automatic updates

Use the **Inspect** card to upload a FIT file and discover sensor keys, then
map each key to a piece of Strava gear. Keys have the form
`manufacturer:product_or_devicetype:antDeviceNumber`, normalized to lowercase.
For example: `garmin:vector_3:12345`, `quarq:dzero:67890`, or
`wahoo_fitness:tickr:0`.

When multiple mapped sensors appear in a FIT file, the mapping with the lowest
priority number wins. Ties go to the most recently created mapping.

Enable **Enable webhook gear updates** in **Configure** to process new activities
automatically. Webhook gear updates deliberately replace an activity's existing
gear when a matching mapping is found.

## Segmentation

The **Segmentation** tab lists your starred Strava segments. It can export IDs
as JSON:

```json
{
  "format": "a-bloc-segment-ids",
  "version": 1,
  "exportedAt": "2026-09-06T12:00:00.000Z",
  "segmentIds": [123456, 789012]
}
```

Imports accept this object (including files exported by older versions with
the `strava-extened-segment-ids` format) or a simple array such as
`[123456, 789012]`. Imported IDs are checked against Strava and shown
unchecked; only selected segments are added to your starred list or local
segment database.

Strava has no bulk star/unstar endpoint, so mutations run sequentially, one
request per segment. The app waits one second between requests by default and
retries HTTP 429 responses up to three times, honoring `Retry-After` when
available. Set `SEGMENT_MUTATION_DELAY_MS` to increase the delay; values below
250 ms are raised to 250 ms.

## Segment completion counts

Open **Segment Counts** and enter up to five Strava segment IDs. When a new
activity webhook includes one of those segments, the app adds or replaces a
completion-count block in the Strava activity description. Existing
description text is preserved, and webhook retries do not duplicate the
block. Tracked IDs and webhook logs remain in the local database; only the
description block is written to Strava.

Use **Refresh** in Recent webhook activity to check and process your latest
Strava activity. The Strava webhook subscription can be created from either
the Gear Selector or Segment Counts page.

## Data, deployment, and limitations

The SQLite database is stored in `data/app.db`; uploaded files are temporary
and stored in `uploads/`. Back up the database or use persistent storage when
hosting the app. On Railway, mount a volume at `/app/data`. General segment
metadata is cached globally, so when one user fetches a segment, other users
can reuse that cached information; starred segments and segment-count settings
remain per-user.

The schema is versioned with `PRAGMA user_version`. Pending migrations in
`src/migrations.js` run automatically at startup, each in its own transaction.
To change the schema, append a new migration rather than editing an existing
one.

Signed-out visitors can browse the tabs, but every control is disabled until
they connect a Strava account.

Garmin Connect, Hammerhead, COROS and Strava web downloads use unofficial
interfaces and can break when those services change. Garmin MFA is not
supported by the underlying library. Credentials and tokens are encrypted at rest, but anyone
with code execution and access to `SESSION_SECRET` can decrypt them. Use a
unique, private deployment and protect access to its variables and persistent
volume.

`better-sqlite3` is a native Node module. On Windows, its initial installation
may require [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
