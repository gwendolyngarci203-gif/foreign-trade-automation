# Phase 12.6-S: Public Release Sanitization

## Relationship

This directory is a sanitized export derived from D. D remains the complete engineering source and was not modified. The export source commit is `e61fe70de3566a6a586a272f110ff3f1f70c9e87`; the historical D release input is `0316b9fd96017924c3de046f2def3fabde94fff2`.

## Retained

Reviewed source and evidence under `app/`, `tools/`, `deploy/`, `docs/`, `migration/`, `plans/`, plus selected README, changelog, project-structure, source-of-truth, and release metadata files.

## Excluded

`.env*`, credentials, password/account material, secrets/tokens, SSH, browser profiles, `.codex_work`, runtime stores, outputs, mailbox/queue/outbox data, backups, recovery content, identity-source configuration, caches, `__pycache__`, and historical temporary builds.

## Security conclusion

Path and filename scans pass, no large files were exported, and no secret contents were read or copied. Two token-like textual matches remain a manual review item because automated scanning cannot establish whether they are harmless test/client literals.

## Push decision

**Do not push yet.** Public upload requires owner approval of category B deployment files, review of the two token-pattern matches, final manifest/hash verification, and an explicit choice of remote branch operation. No remote, production, SMTP, queue, outbox, or runtime action was performed.
