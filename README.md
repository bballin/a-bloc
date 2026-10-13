# Strava Extended

Strava Extended assigns gear to your activities based on the sensors recorded in
the original FIT file. For example, you can map a power meter's ANT+ ID to a
piece of Strava gear and have the app tag matching rides.

## How it works

Strava's public API does not expose the original FIT file for an activity or
the individual sensors recorded in it. Strava Extended gets the FIT file from
Garmin Connect or a Strava web session, parses it locally, then matches the
discovered sensor keys to your gear mappings.

You can process activities in four ways:

- **Webhook:** Strava notifies the app about new activities. The app fetches
  and parses the FIT file, then applies a matching gear mapping.
- **Automatic polling:** The app checks recent activities on an interval and
  tags rides that have not been processed yet.
- **Manual sync or Tag button:** Run the same matching process on demand.
- **Manual FIT upload:** Upload a FIT file; the app matches it to a Strava
  activity by start time (within five minutes) and sets its gear.

## Run locally

1. Create an API application at <https://www.strava.com/settings/api>. Set its
   **Authorization Callback Domain** to `localhost`.
2. Copy `.env.example` to `.env`. Set `STRAVA_CLIENT_ID`,
   `STRAVA_CLIENT_SECRET`, and a long random `SESSION_SECRET` (at least 16
   characters). Set a separate random `STRAVA_WEBHOOK_VERIFY_TOKEN`.
3. Install dependencies and start the app:

   ```sh
   npm install
   npm start
   ```

4. Open <http://localhost:3000> and choose **Connect with Strava**.

The app listens on `0.0.0.0` and uses the `PORT` environment variable when
provided (default `3000`).

## Deploy to Railway

1. Create a Railway project from this repository. Railway's Node builder installs
   the dependencies from `package-lock.json`.
2. Set the Railway **Start Command** to:

   ```sh
   bash start.sh
   ```

   The script starts the app with `npm start`. If dependencies have not already
   been installed, it installs production dependencies with `npm ci --omit=dev`
   first.
3. Add these variables under the Railway service's **Variables**:
   - `STRAVA_CLIENT_ID`
   - `STRAVA_CLIENT_SECRET`
   - `SESSION_SECRET` — a long random value of at least 16 characters. Keep it
     stable across deploys; it is used to encrypt stored credentials.
   - `APP_BASE_URL` — the public HTTPS URL for the Railway service, for example
     `https://your-app.up.railway.app` (no trailing slash).
   - `STRAVA_WEBHOOK_VERIFY_TOKEN` — a separate random value for Strava webhook
     verification.
4. In your Strava API application's settings, set **Authorization Callback
   Domain** to the hostname from `APP_BASE_URL`, without `https://` or a path.
   For example, use `your-app.up.railway.app`.
5. Add a Railway **Volume** mounted at `/app/data`. The SQLite database is
   stored at `data/app.db`; the volume keeps athlete tokens, mappings, settings,
   and processing history across deploys. Without a persistent volume, that
   data can be lost when Railway replaces the container.
6. Deploy, open the public app URL, and connect your Strava account.

Railway provides `PORT`; the app binds to `0.0.0.0` and uses that port
automatically. To use Strava webhooks, create the subscription from the app
after deployment. Strava requires a public HTTPS callback URL, and permits one
webhook subscription per API application.

## Strava permissions

The app requests these scopes:

```text
read, activity:read_all, activity:write, profile:read_all, profile:write
```

`profile:write` is used by the Segmentation page to star and unstar segments. If
you connected before granting this scope, disconnect and connect again to
authorize it.

## Getting original FIT files

The app tries these unofficial sources in order:

1. **Garmin Connect** uses the
   [`garmin-connect`](https://www.npmjs.com/package/garmin-connect) library.
   Provide your Garmin email and password in the app's **Auto-fetch sources**
   settings. Credentials and cached OAuth tokens are encrypted at rest using a
   key derived from `SESSION_SECRET`.
2. **Strava web session** downloads
   `https://www.strava.com/activities/{id}/export_original` using a logged-in
   session cookie. Email/password login is also available, but Strava's
   Cloudflare and CAPTCHA protections may block it.

If a source cannot provide a FIT file, the app tries the next source. If none
succeed, the activity is recorded as `no_fit` and skipped; you can still
upload its FIT file manually.

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

Automatic polling can be configured in the UI or with
`POST /api/polling { enabled, intervalSeconds }`. Its default interval is five
minutes; supported values range from 60 to 3600 seconds. The setting persists
across restarts. Per-activity backoff prevents repeated retries:

- `ok` / `skipped`: 24 hours
- `no_mapping` / `parse_error`: 6 hours
- `no_fit`: 30 minutes
- `error`: 15 minutes

Alternatively, enable **Use webhook instead of polling** under **Gear Selector
→ Automatic gear updates**. The two gear-update modes are mutually exclusive.
Webhook gear updates deliberately replace an activity's existing gear when a
matching mapping is found.

## Segmentation

The **Segmentation** tab lists your starred Strava segments. It can export IDs
as JSON:

```json
{
  "format": "strava-extened-segment-ids",
  "version": 1,
  "exportedAt": "2026-09-06T12:00:00.000Z",
  "segmentIds": [123456, 789012]
}
```

Imports accept this object or a simple array such as `[123456, 789012]`.
Imported IDs are checked against Strava and shown unchecked; only selected
segments are added to your starred list.

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
hosting the app. On Railway, mount a volume at `/app/data`.

Garmin Connect and Strava web downloads use unofficial interfaces and can
break when those services change. Garmin MFA is not supported by the
underlying library. Credentials and tokens are encrypted at rest, but anyone
with code execution and access to `SESSION_SECRET` can decrypt them. Use a
unique, private deployment and protect access to its variables and persistent
volume.

`better-sqlite3` is a native Node module. On Windows, its initial installation
may require [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
