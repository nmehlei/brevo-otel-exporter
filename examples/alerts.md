# Example alerts

Thresholds: warn at 70 %, critical at 90 % of the daily limit. Metric names use dots; in
Prometheus-style query languages they become underscores (`brevo_email_sent_today`).

| Alert | Expression |
|---|---|
| Quota warning | `brevo.email.sent_today / brevo.email.daily_limit > 0.7` per `account` |
| Quota critical | `brevo.email.sent_today / brevo.email.daily_limit > 0.9` per `account` |
| Low remaining | `brevo.email.remaining < 30` per `account` |
| One app dominates | `brevo.email.sent_today.by_app / brevo.email.sent_today > 0.8` per `account`, `app` when `sent_today > 50` |
| Delivery failure | `brevo.email.failed_today > 0` per `account`, `event` (needs `events.enabled`); the matching log record names the app, sender and reason |
| Exporter stale | `now() - brevo.exporter.last_success_timestamp > 3 * intervalSeconds` |
| Poll errors | `increase(brevo.exporter.poll_errors[15m]) > 0` |

The "stale" alert matters: if Brevo's API is unreachable, the quota gauges are dropped after 3 intervals
(so they do not show yesterday's numbers), and `last_success_timestamp` is the only signal left.
`poll_errors` is per process: use it in loop mode only; with `--once` rely on the staleness alert.

Note on quota alerts around midnight: Brevo rejects dates later than its own (UTC) date, so for 1 to 2 hours
after local midnight the exporter still reports the previous day's `sent_today`. A quota alert that fired
late in the evening can therefore keep firing until UTC midnight even though Brevo's quota has not reset
yet. Use `brevo.email.remaining` for "how much can I still send right now".
