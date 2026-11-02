# brevo-quota-otel

Export your [Brevo](https://www.brevo.com) mail-send quota and **per-application usage** as
OpenTelemetry metrics (OTLP/HTTP), so you can alert before the free tier's daily send limit is hit.

Brevo's daily limit is shared by the whole account, so one misbehaving app can silently use up the quota
of all the others. This tool tells you how much is left and which app is using it.

> Not affiliated with Brevo. "Brevo" is a trademark of its owner.

## How it works

Every `intervalSeconds` (default 300) the exporter polls each configured account through Brevo's REST API
(read-only calls) and records OTel metrics. It uses no sending quota itself.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `brevo.email.daily_limit` | gauge | `account` | Configured daily limit |
| `brevo.email.sent_today` | gauge | `account` | Sends today (account timezone) |
| `brevo.email.remaining` | gauge | `account` | Remaining sends reported by Brevo (omitted if the plan has no send limit) |
| `brevo.email.sent_today.by_app` | gauge | `account`, `app` | Sends today per app; the rest is `app="unattributed"` |
| `brevo.exporter.last_success_timestamp` | gauge | `account` | Unix seconds of the last good poll |
| `brevo.exporter.poll_errors` | counter | `account`, `reason` | Failed polls (`http_429`, `http_5xx`, `http_4xx`, `timeout`, `network`, `parse`, `unexpected`) |

The daily limit is **not exposed by the Brevo API**, so you configure it (free tier: 300).

## Run

```
docker run --rm -v ./config.yaml:/config.yaml:ro -e BREVO_API_KEY -e OTLP_PASSWORD \
  ghcr.io/<owner>/brevo-quota-otel:<version> --config /config.yaml
```

`--once` polls once, flushes and exits (for cron, CronJobs or serverless). Without it the process loops
until SIGTERM. Use a **read-only** Brevo API key. See [`examples/config.yaml`](examples/config.yaml).

## Per-application attribution

Rules are evaluated per account; an app can have several rules.

- **`tag`** (recommended): send mails with a Brevo tag equal to the rule's tag. Counted via Brevo's
  per-tag report.
- **`sender`**: the `from` address (case-insensitive).
- **`subject`**: a regular expression on the subject line (fragile, good as a stopgap).

`sender` and `subject` rules are matched against the day's send events; the **first matching rule in
config order wins**, so a mail is counted once among them. Anything not attributed is
`unattributed` (never negative).

**Caveat:** tag counts and event-based counts are computed separately (events carry no tag). If the same
mails match a tag rule *and* a sender/subject rule, or carry two tags, they are counted twice. The
exporter then logs a `warn` ("overlapping attribution rules") with the number of double-counted mails, and
the per-app sum exceeds `sent_today`.

## Known limits

- `sent_today + remaining` can differ from `daily_limit` by a few mails. Brevo's quota counter and its
  reporting window are not identical (we observed gaps of 1 to 12). Alert on ratios, not equality.
- "Today" is the account's timezone day (from Brevo, or the `timezone` setting).
- Events are listed per day, 500 per page (deduplicated by message id, capped at 200 pages). The free tier
  (300/day) fits in one page; for high-volume accounts prefer `tag` rules, which need no event listing.
- If an account keeps failing, its quota gauges are dropped after 3 intervals (never shown as current
  across midnight); `brevo.exporter.last_success_timestamp` stays so the staleness alert can fire.
- Failed OTLP exports are logged (`otlp export failed`) and make `--once` exit 1.
- `brevo.exporter.poll_errors` counts per process lifetime, so it is meaningful in loop mode. With
  `--once` (a fresh process per run) alert on `last_success_timestamp` and the exit code instead.
- Logs are JSON lines without trace or span IDs (the exporter creates no spans).

## Alerts

Examples for SigNoz and OpenObserve: [`examples/alerts.md`](examples/alerts.md).

## Security

API keys come from an environment variable or a file, never from the config's values, and are not logged.
Logs are JSON lines containing account names and error reasons only.

## Development

```
npm ci && npm test && npm run build
```

MIT licensed.
