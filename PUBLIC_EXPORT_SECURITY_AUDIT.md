# Public Export Security Audit

Date: 2026-09-08

## Source

- Source: `D:\zcy\外贸自动化拓客系统`
- Source branch: `github-release-staging`
- Source commit: `e61fe70de3566a6a586a272f110ff3f1f70c9e87`
- Export type: allowlist copy; D was not modified.

## Checks

| Check | Result | Notes |
|---|---|---|
| Secret path scan | PASS | No exported path matches `.env`, credential, password, secret, token, SSH, runtime, mailbox, queue, outbox, backup, or recovery deny rules. |
| Credential filename scan | PASS | No credential/account/password-named file exported. |
| Token pattern scan | REVIEW | Two source text files contain token-like test/client strings; no values are emitted here. They require owner review before public push. |
| Private config scan | PASS | `deploy/identity-source/` and runtime identity/config files excluded. |
| Large-file scan | PASS | No exported file exceeds 10 MiB. |
| Build artifact scan | PASS | `__pycache__`, node modules, coverage, temp, and historical build artifacts excluded. |

## Boundary

The export contains source code, reviewed tools, deployment definitions, documentation, migration evidence, plans, and release metadata. It contains no runtime state, mailbox data, queue/outbox data, browser profile, credentials, or private recovery directory.

## Decision

**Conditionally safe for human review, not yet approved for push.** The two token-pattern matches are treated as possible code/test literals, not cleared secrets. A maintainer must inspect the exact public diff without exposing secret contents and approve the final export.
