# Contact Runner

Local terminal runner for verifying contacts against the current LinkedIn/Sales Navigator session.

This is separate from the `XTRACTARR` browser extension. It opens a visible Chrome window with a dedicated local profile, so the LinkedIn login session can be reused without manually copying cookies.

## Setup

```bash
npm install
```

If Playwright cannot find a browser, install its bundled Chromium:

```bash
npx playwright install chromium
```

## Usage

```bash
npm run verify -- --input ./contacts.csv --limit 2
```

For a real run:

```bash
npm run verify -- --input /path/to/contacts.csv --output ./contact-verify-output.csv
```

The runner uses a dedicated browser profile at `.local/linkedin-profile` by default. On the first run, log in to LinkedIn/Sales Navigator in the opened browser, then press Enter in the terminal. The runner checks LinkedIn authentication with an API probe before it starts processing contacts.

## Run on a Headless Machine

For a headless server, seed the browser profile on a desktop machine first:

```bash
npm run verify -- --input ./contacts.csv --limit 1
```

When the browser opens, log in to LinkedIn/Sales Navigator and let the runner start. Stop it with `Ctrl+C` after the session is confirmed if you only wanted to seed the profile.

Copy the authenticated profile to the server:

```bash
rsync -a .local/linkedin-profile/ user@server:/path/to/linkedin-profile/
```

On the server, run with the copied profile:

```bash
npm run verify -- --input ./contacts.csv --profile-dir /path/to/linkedin-profile --headless
```

Headless mode does not prompt for login. If the copied profile is expired or invalid, the runner exits before processing contacts and asks you to refresh the profile on a desktop machine.

## Use an Existing Logged-In Browser

You can attach the runner to an existing Chrome/Chromium session, but the browser must be started with remote debugging enabled. If your normal browser is already open, close it first so the profile is not locked, then start it with a debugging port.

For Google Chrome:

```bash
google-chrome --remote-debugging-port=9222
```

For Chromium:

```bash
chromium --remote-debugging-port=9222
```

Then run:

```bash
npm run verify -- --input ./contacts.csv --cdp-url http://127.0.0.1:9222
```

The runner opens a new tab in that browser and uses the session already logged in there. It disconnects when finished and does not close the browser.

## CLI Options

- `--input <path>`: required CSV input.
- `--output <path>`: output CSV path. Defaults to `contact-verify-YYYYMMDD-HHMMSS.csv`.
- `--profile-dir <path>`: persistent browser profile. Defaults to `.local/linkedin-profile`.
- `--cdp-url <url>`: attach to a Chrome/Chromium browser started with remote debugging.
- `--headless`: run without a visible browser window. Requires a pre-authenticated profile.
- `--delay-ms <number>`: base delay between contacts. Defaults to `2500`.
- `--limit <number>`: process only the first N contacts.

## Required CSV Columns

- `UUID`
- `Name`
- `Company`
- `LinkedIn URL`
- `Original Title` is optional (enables the Title Status comparison)

Accepted UUID aliases include `ID`, `Contact ID`, and `Record ID`. Accepted LinkedIn URL aliases include `LinkedIn`, `LinkedIn Link`, `Profile URL`, `Sales Nav URL`, and `Sales Navigator URL`. Accepted Original Title aliases include `Title`, `Job Title`, `Role`, and `Position`.

Rows without a UUID, Name, or LinkedIn URL are skipped. A CSV missing the UUID column entirely is rejected.

## Output Columns

- `UUID`
- `Name`
- `LinkedIn Name`
- `Original Company`
- `Current Company`
- `Status`
- `Original Title`
- `Current Title`
- `Title Status` (`Same role`, `Changed role`, or `Unknown`)
- `LinkedIn URL`
- `Confidence`
- `Strategy`
- `Fetched Via`

## Notes

- The browser is visible by default because LinkedIn may require login, MFA, or manual review.
- The runner does not import cookies manually and does not use Python requests.
- API failures for a single contact produce an `Unknown` row and continue the run.
