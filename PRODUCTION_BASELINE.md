# Production Baseline

- Baseline: cloud Phase 7 complete
- Commit: e87721dcf07380ace6eed68afefe335c6caeaa25
- Captured at: 2026-09-04 Asia/Shanghai
- Runtime root: `/opt/dakings-prospect-ops/deploy/runtime-data/`
- Services at capture: `dakings-prospect-ops.service=active`; `dakings-pipeline-worker.service=inactive (oneshot idle)`; `dakings-managed-collection.service=failed (NetEase session gate)`

## Capabilities

- Phase 7.2-A: HSCode, Keyword, Country+Business discovery artifacts share the managed pipeline.
- Phase 7.2-B: contact queue lease recovery, failed-item retry, and company-level pipeline checkpoint resume.
- Phase 7.2-C: account-aware delivery capacity, health signals, sender selection, and safety gates.
- Production safety: suppression, dedupe, bounce/complaint protection, uncertain handling, circuit breaker, SMTP status checks, and IMAP feedback.

## Production flow

`discovery -> pipeline -> contact -> validation -> drafting -> approval -> outbox -> SMTP -> feedback`

Runtime data, credentials, mailbox state, contacts, outbox, logs, and mutable artifacts are excluded from version control.
