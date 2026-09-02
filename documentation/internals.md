# Contact Runner Internals

> **Scope:** How `src/verify-contacts.mjs` works internally: session handling, the profile lookup strategies, company/title matching, statuses and confidence, pacing, and failure behaviour. For setup and CLI usage, see the [README](../README.md).

---

## 1. Pipeline

One contact at a time, sequentially:

```
main()
  ├─ parseContactsCSV(input)          Validate columns, resolve header aliases, skip bad rows
  ├─ launchBrowser(args)              Persistent profile, or CDP attach, or headless
  ├─ ensureLinkedInSession(page)      Open Sales Nav home, extract CSRF, probe auth, prompt login if needed
  └─ for each contact:
       ├─ verifyContact(page, contact, csrfToken)
       ├─ writeResults(output)        Full CSV rewrite after EVERY contact
       └─ sleep(delayMs + jitter)     Base delay (default 2500ms) + 0-1000ms random jitter
```

All LinkedIn requests are executed **inside the page context** via `page.evaluate(fetch(...))` (`browserFetchJson`), so they carry the browser session's cookies and look like same-origin requests from a logged-in tab. The runner never copies cookies out of the browser.

## 2. Session and Auth

- `getCsrfToken` reads the `JSESSIONID` cookie from the browser context and strips its quotes; LinkedIn expects this value in a `csrf-token` header on API calls (alongside `x-restli-protocol-version: 2.0.0`).
- `hasAuthenticatedLinkedInSession` probes `voyager/api/me`. A non-OK response means not logged in.
- Interactive mode: the runner opens Sales Navigator home, and if the probe fails, waits for the user to log in and press Enter, then re-probes.
- Headless mode (`--headless`) and CDP mode never prompt: if the probe fails, the run aborts before processing any contacts.

## 3. Lookup Strategies

`verifyContact` tries up to three sources in order, stopping at the first that yields a company. The `Strategy` output column records which class succeeded (`1` = direct profile fetch, `2` = name search), and `Fetched Via` records the exact API URL used.

| Order | Condition | API | Notes |
|-------|-----------|-----|-------|
| 1a | URL contains `/in/<slug>` | Voyager `identity/dash/profiles?q=memberIdentity` | Parses top position for company/title; falls back to splitting the headline on "at". If name or title is missing but a profile ID was returned, backfills from the Sales Nav profile API. |
| 1b | URL contains `/sales/lead/` or `/sales/people/` | Sales Nav `salesApiProfiles/(profileId:...)` | The Sales Nav key can carry `authType`/`authToken` parts, which are preserved. |
| 2 | Nothing yet | Sales Nav `salesApiPeopleSearch` keyword search | First searched as `"<name> <company>"`, then name only. |

Search-result matching (`matchFromElements`) prefers, in order: entity URN containing the Sales Nav profile ID, exact public-identifier/slug match, exact full-name match. If a name-only search matches nothing but returned results, the **first result is used as a last resort** (lowest-trust path; still `Strategy 2`).

## 4. Company and Title Matching

Both matchers normalize, then compare with a bigram Dice coefficient:

- `normalizeCompany`: lowercase, strip punctuation, strip one trailing legal/generic suffix (`Inc`, `LLC`, `Ltd`, `Corp`, `Pvt`, `Technologies`, `Solutions`, `Consulting`, ...), collapse whitespace.
- `normalizeTitle`: lowercase, strip punctuation and level/filler words (`senior`, `jr`, `lead`, `principal`, `of`, `and`, `at`, ...).
- Similarity: `2 * |shared bigrams| / (|bigrams a| + |bigrams b|)`. Exact match scores 1.0; a space-insensitive exact match scores 0.95.

Thresholds: companies match at ratio >= 0.8, titles at >= 0.7.

## 5. Status and Confidence Rules

| Output | Rule |
|--------|------|
| `Status: Still there` | Company matched. `Confidence: high` when ratio > 0.9, else `low`. |
| `Status: Moved on` | A current company was found but did not match. Always `Confidence: high`. |
| `Status: Unknown` | No company could be resolved (or the row errored). `Confidence: low`. |
| `Title Status` | `Same role` / `Changed role` by the title matcher; `Unknown` when either title is missing. |

Note the asymmetry: "Moved on" is always high confidence because a concrete different employer was observed, while "Still there" is downgraded when the name match was fuzzy.

## 6. Output, Resume, and Interrupts

- The full output CSV is rewritten after **every** contact, so a crash or `Ctrl+C` loses at most the in-flight contact.
- `SIGINT`/`SIGTERM` write partial results, close the browser, and exit 130.
- A per-contact exception produces an `Unknown` row with the error message in `Fetched Via`, and the run continues.

## 7. Rate-Limiting Posture

- Sequential processing only; no concurrency.
- Base delay between contacts (`--delay-ms`, default 2500ms) plus 0-1000ms random jitter.
- At most three API calls per contact (usually one or two).

There is no retry/backoff on HTTP failures: a failed call falls through to the next strategy or ends as `Unknown`.

## 8. Repository Data Files

`b1.csv` / `b2.csv` are sample input batches; `b1o.csv` / `b2o.csv` are their corresponding outputs, kept as format references for the input and output column contracts described in the README.

---

## Related Files

| File | Purpose |
|------|---------|
| `src/verify-contacts.mjs` | The entire runner: CLI, CSV I/O, browser session, lookup strategies, matching |
| `README.md` | Setup, CLI options, CSV column contracts, headless/CDP workflows |
| `b1.csv`, `b2.csv` | Sample inputs |
| `b1o.csv`, `b2o.csv` | Sample outputs |
| `package.json` | `npm run verify` (the runner) and `npm run check` (syntax check); Playwright is the only dependency |
