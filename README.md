# Strava Extened

Connects to your Strava account and sets the **equipment (gear)** on activities based on the **sensors recorded in the original FIT file** — for example, "any ride that contains power meter ANT+ #12345 → my Road Bike".

## Why a FIT file and not just the activity?

The Strava public API does **not** expose the original FIT file of an existing activity, and the activity object only includes the head-unit `device_name` — not individual sensors (power meter, HR strap, speed sensor, etc.). To match by sensor, this app parses the FIT file locally before talking to Strava.

## How it works

1. You sign in to Strava (official OAuth).
2. **Build mappings**: drop a FIT file into the **Inspect** card to discover sensor keys (e.g. `garmin:vector_3:12345`), pick a piece of Strava gear, and save the mapping.
3. **Tag activities** in any of four ways:
   - **Webhook**: with a public HTTPS URL, Strava can notify the app about each new activity immediately. The app evaluates its FIT sensors and replaces any existing gear assignment with the matching gear.
   - **Auto-monitor**: configure Garmin Connect and/or Strava-web in **Auto-fetch sources**, then enable polling under **Automatic gear updates**. The app checks recent activities on an interval (default every 5 min) and tags new untagged rides automatically.
   - **Manual sync / per-activity Tag button**: same logic, run on demand.
   - **Manual FIT drop**: drop a FIT file into the **Apply** card; the app finds the matching Strava activity by start time (±5 min) and sets gear.

Mappings, tracked segment IDs, encrypted credentials/tokens, and processing logs live in `data/app.db` (SQLite).

## Auto-fetch sources

Strava's official API does not expose the original FIT file of an activity, so to set gear automatically the app needs another way in. Two unofficial sources are supported and tried in this order:

1. **Garmin Connect** — uses the [`garmin-connect`](https://www.npmjs.com/package/garmin-connect) library. You provide your Garmin email + password (stored encrypted with AES-256-GCM, key derived from `SESSION_SECRET`). The app caches OAuth1/OAuth2 tokens so it doesn't re-login every time. For each Strava activity, it finds the matching Garmin activity by start time (±5 min) and downloads the original FIT.
2. **Strava web session** — calls `https://www.strava.com/activities/{id}/export_original` with a logged-in cookie. Easiest: paste your `_strava4_session` cookie value from a browser logged into strava.com. Email/password login is also implemented but Strava's Cloudflare/captcha layer often blocks it.

If a source fails for an activity, the next source is tried. If none succeed, the activity is logged as `no_fit` and skipped — you can still tag it manually by dropping the FIT.

### Getting your `_strava4_session` cookie

1. Log into <https://www.strava.com> in any browser.
2. Open DevTools → Application/Storage → Cookies → `https://www.strava.com`.
3. Copy the value of `_strava4_session`. Paste it (with or without the `_strava4_session=` prefix) into the Strava-web settings card. The cookie is long-lived but expires eventually; re-paste when the app reports auth errors.

## Caveats

- **Both auto-fetch sources are unofficial.** They work today but can break when Garmin/Strava changes their web flows. This app is intended for personal use on your own machine.
- **MFA on Garmin** is not currently handled by the underlying library; if your Garmin account has 2FA enabled, the credential login will fail.
- Tokens are encrypted at rest, but anyone with code execution on your machine + access to your `SESSION_SECRET` can read them. Don't deploy this to a shared server as-is.

## Setup

1. Create a Strava API application at <https://www.strava.com/settings/api>.
   - **Authorization Callback Domain**: `localhost`
2. Copy `.env.example` to `.env` and fill in `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`. Set `SESSION_SECRET` and `STRAVA_WEBHOOK_VERIFY_TOKEN` to different long random strings.
3. Install dependencies and start:

```powershell
npm install
npm start
```

4. Open <http://localhost:3000> and click **Connect with Strava**.

The app requests these Strava scopes:

```
read, activity:read_all, activity:write, profile:read_all, profile:write
```

`profile:write` is required for the Segmentation page to star and unstar segments. If you were already connected before this scope was added, sign out and connect with Strava again to grant the updated permission.

> Note: `better-sqlite3` is a native module. On Windows you may need the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) the first time `npm install` runs.

## Segmentation

The **Segmentation** tab lists the authenticated user's starred Strava segments. It can export the current segment IDs as JSON:

```json
{
   "format": "strava-extened-segment-ids",
   "version": 1,
   "exportedAt": "2026-09-06T12:00:00.000Z",
   "segmentIds": [123456, 789012]
}
```

Imports accept this object format or a simple array such as `[123456, 789012]`. Imported IDs are checked against Strava and displayed with unchecked boxes. Only selected segments are added to the user's starred list.

Strava does not expose a bulk star/unstar endpoint. Adding selected segments and deleting all starred segments therefore make one request per segment, run sequentially, and report any individual failures. Segment mutations wait 1 second between requests by default and retry HTTP 429 rate-limit responses up to three times, honoring Strava's `Retry-After` header when available. Set `SEGMENT_MUTATION_DELAY_MS` in `.env` to increase the spacing if needed; values below 250 ms are raised to 250 ms.

## Sensor key format

Sensor keys are normalized to lowercase strings of the form:

```
manufacturer:product_or_devicetype:antDeviceNumber
```

Examples:

```
garmin:vector_3:12345
quarq:dzero:67890
wahoo_fitness:tickr:0
```

Use the **Inspect** card to discover the exact keys for your gear, then map each one.

## Mapping priority

Lower numbers win. If a file contains both your power meter and your HR strap, and both have mappings, the one with the lowest priority value is used. Tie-broken by most recently created.

## Auto-monitor (polling)

A background poller calls the same sync logic on an interval per athlete. Configurable in the UI (or `POST /api/polling { enabled, intervalSeconds }`).

- **Default interval**: 300 s (5 min). Min 60 s, max 3600 s.
- **Per-activity backoff** prevents the poller from hot-looping on activities that already failed:
  - `ok` / `skipped`: 24 h (won't retry)
  - `no_mapping` / `parse_error`: 6 h
  - `no_fit` (couldn't download original): 30 min
  - `error` (Strava update failed): 15 min
- **Persists across restarts** — the poller re-starts on server boot for any athlete who had it enabled.
- Polling state is process-local; if you want cross-process or webhook-based push, see "Why not webhooks?" below.

## Segment completion counts

Open **Segment Counts** from the main navigation and enter up to five Strava segment IDs. When Strava sends a new-activity webhook, the app checks the activity's segment efforts. If it contains a tracked segment, the app reads that segment's lifetime effort count and adds or replaces this block in the activity description:

```text
Segment counts (Strava Extended)
Example Segment: 12 completions
End segment counts
```

The tracked IDs and webhook log remain local in `data/app.db`; only this description block is written to Strava. Existing description text is preserved, and webhook retries replace the block rather than duplicating it. Use **Refresh** in Recent webhook activity to check and process your latest Strava activity, then reload the list.

Strava requires the webhook callback to be a **publicly reachable HTTPS URL**. Set `APP_BASE_URL` to that URL, restart the app, then create the subscription from either the Gear Selector or Segment Counts page. A tunnel such as ngrok or Cloudflare Tunnel is sufficient for a locally hosted app. Strava permits one webhook subscription per API application, shared by all athletes connected to that application.

## Webhook gear updates

Under **Gear Selector → Automatic gear updates**, enable **Use webhook instead of polling**. The two modes are mutually exclusive: enabling webhook mode disables polling, and enabling polling disables webhook gear processing. The app-level Strava subscription can be created from the same card.

For each `activity/create` event belonging to a connected athlete, the app downloads the original FIT using the configured Garmin or Strava-web source, applies the existing sensor mapping, and updates the activity with `force: true`. This intentionally replaces a gear assignment that Strava or another integration already set.

## Tuning

- The activity match window is ±5 minutes on `start_date` against the most recent 30 activities. Edit `src/sync.js` / `src/garmin.js` if you need a different window or page size.
- Sync runs sequentially across activities (one Garmin/Strava-web request at a time) to stay polite with rate limits.
