# Server Merge Preparation

## Three-way Inputs

- Base/production reference: D `production/main` lineage at `33aba8a` and current D branch state.
- D working target: `app/server.mjs` SHA-256 `517b2eb986fa6dee40deaead1494cad3211ec66aa547201a648ff55a590f02c9`.
- C development source: `app/server.mjs` SHA-256 `f8b5f7e324b5671a55bb5c51bb84fb8e8e97795c40d9762464c5d39340f5ec3a`.

## Procedure

1. Produce a line-level three-way diff from the common Git base.
2. Classify each hunk as adopt, adapt, or reject.
3. Preserve D-owned quota, timer, lock, runtime, delivery, SMTP, queue, pipeline, and outbox behavior.
4. Apply only reviewed hunks on a separate commit; never replace the whole file.
5. Run syntax, contract, deployment, and diff checks before review.

No `server.mjs` change was made in Phase 12.6-B.
