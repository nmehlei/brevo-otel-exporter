# brevo-otel-exporter

Export your [Brevo](https://www.brevo.com) mail-send quota, **per-application usage** and **delivery
failures** as OpenTelemetry metrics and logs (OTLP/HTTP), so you can alert before the free tier's daily
send limit is hit and notice mails that Brevo rejected or bounced.

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
| `brevo.email.failed_today` | gauge | `account`, `event` | Failure events seen today per type (only with `events.enabled`; zeros included) |
| `brevo.exporter.last_success_timestamp` | gauge | `account` | Unix seconds of the last good poll |
| `brevo.exporter.poll_errors` | counter | `account`, `reason` | Failed polls: `http_429`, `http_5xx`, `http_4xx`, `timeout`, `network`, `parse`, `unexpected`; event polls are prefixed `events_` (e.g. `events_log_export` = the OTLP log export failed) |

## Logs

Logs are opt-in.

- **Delivery failures** (`events.enabled: true`): every `hardBounces`, `softBounces`, `blocked`, `spam`,
  `deferred`, `invalid` and `error` event becomes one OTLP log record, with the event time as timestamp,
  severity `ERROR` (`WARN` for soft bounces and deferrals) and the attributes `brevo.account`, `brevo.event`,
  `brevo.message_id`, `brevo.sender`, `brevo.reason`, `app`, plus optionally `recipient.domain` and
  `email.subject` (`includeSubject` / `includeRecipientDomain` turn those off).
  **Privacy:** the recipient's address is never exported, only its domain. Email addresses that appear
  inside Brevo's free text (`reason`, `subject`) are redacted to `<redacted>@domain`. The subject can still
  contain other personal data such as names: set `includeSubject: false` if that matters.
  Typical findings: "sender not valid" (an unvalidated sender address), blocklisted sending IPs.
  **`app`** is derived from `sender` and `subject` rules only. Brevo's events carry no tag, so tag rules do
  not apply here: a failure of a tag-attributed app shows as `unattributed` unless a sender or subject
  rule also matches it.
- **The exporter's own log lines** (`logs: true`) are exported next to the JSON lines on stdout.

**Delivery guarantee: at least once.** An event counts as exported only after the OTLP log export succeeded;
if it failed, the event is retried on the next poll (it may then appear twice, never zero times). The very
first run is a **baseline**: events that already exist are marked as seen and not replayed.
`events.statePath` (`<statePath>.<account>.json`) keeps that state, and the last polled day, across restarts.
It is **required with `--once`**, otherwise every run would be a fresh baseline. A corrupt state file is
moved to `*.corrupt` and logged as a warning.

After more than one full day without a successful events poll, only the last polled day and today are read; failures of the days in between are not exported.

Events are polled every `events.intervalSeconds` (default 900) in loop mode, one API call per type per
day. With `--once` every run polls them, so a 5-minute cron costs about 7 extra calls per run.

## Resource attributes

The standard `OTEL_RESOURCE_ATTRIBUTES` (e.g. `nme_tenant=acme`) and `OTEL_SERVICE_NAME` are honoured for
metrics and logs. Default service name: `brevo-otel-exporter`.

The daily limit is **not exposed by the Brevo API**, so you configure it (free tier: 300).

## Run

```
docker run --rm -v ./config.yaml:/config.yaml:ro -e BREVO_API_KEY -e OTLP_PASSWORD \
  ghcr.io/<owner>/<repo>:<version> --config /config.yaml
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
- "Today" is the account's timezone day (from Brevo, or the `timezone` setting), capped at Brevo's UTC date (see below).
- Events are listed per day, 500 per page (deduplicated by message id, capped at 200 pages). The free tier
  (300/day) fits in one page; for high-volume accounts prefer `tag` rules, which need no event listing.
- If an account keeps failing, its quota gauges are dropped after 3 intervals (never shown as current
  across midnight); `brevo.exporter.last_success_timestamp` stays so the staleness alert can fire.
- Failed OTLP exports (metrics and logs) are logged (`otlp export failed`, `otlp log export failed`) and make `--once` exit 1.
- `brevo.exporter.poll_errors` counts per process lifetime, so it is meaningful in loop mode. With
  `--once` (a fresh process per run) alert on `last_success_timestamp` and the exit code instead.
- Logs carry no trace or span IDs: the exporter creates no spans (the OpenTelemetry JS trace SDK and the log/metric SDKs are not yet released on a compatible version line).
- Brevo rejects dates later than its own (UTC) date, so between local midnight and UTC midnight (00:00 to 01:00 in Berlin in winter, to 02:00 in summer) the previous day's numbers are still shown.

## Alerts

Examples for SigNoz and OpenObserve: [`examples/alerts.md`](examples/alerts.md).

## Security

API keys come from an environment variable or a file, never from the config's values, and are not logged.
Logs are JSON lines containing account names and error reasons only.

## Versioning

[GitVersion](https://gitversion.net) 5.x in Mainline mode (`GitVersion.yml`): every commit to `main` gets
a new, higher version and CI publishes that image tag (plus `latest`). Commits bump the patch number;
put `+semver: minor` or `+semver: major` in a commit message to bump those instead. The history starts
from the tag `v0.1.0` on the first commit.

## Development

```
npm ci && npm test && npm run build
```

MIT licensed.
