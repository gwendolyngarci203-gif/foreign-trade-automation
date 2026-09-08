# Token Review Report

No secret values are reproduced in this report.

| File | Lines | Type | Risk |
|---|---:|---|---|
| `app/tests/smoke.mjs` | 116, 221 | A: test SMTP fixture fields | Placeholder/mock test data; no production credential. Low risk, retain. |
| `app/tests/smoke.mjs` | 252 | A: test webhook secret fixture | Test-only value; no production secret. Low risk, retain. |
| `tools/netease-cdp-client.mjs` | 243, 376, 555 | A: credential variable/argument handling | Code identifiers and input plumbing, not hardcoded credentials. Low risk, retain. |

The matches were scanner signals only. They are not evidence of a real secret and no complete sensitive string was emitted.
