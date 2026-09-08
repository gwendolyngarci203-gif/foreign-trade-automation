# GitHub Public Sync Verification

## Published release branch

- Repository: `https://github.com/gwendolyngarci203-gif/foreign-trade-automation`
- Branch: `release/phase12-6-public-v1`
- Last confirmed remote commit: `3a6bbc941b1ffe670fcc3672fcc8f2caeef51dd4`
- Candidate commit pending transport: `e1c54e0e83bbb09a330c3d0763c045b7a640917b`
- Push result: the reconciled `3a6bbc9...` commit was accepted by a normal fast-forward push; the later documentation-only candidate update was not delivered because GitHub HTTPS was unavailable.

## Local-to-commit reconciliation

An initial post-push audit found 41 ignored local files incorrectly listed by the export manifest. All were log/runtime, contact, operations, suppression, pipeline artifact, or other `app/data` state files. They were never committed or pushed. They were moved out of the public candidate into the local export quarantine, and the manifest is being regenerated from the Git tracked set.

## Independent clone verification

The remote release branch was previously independently cloned at the reconciled commit. Readback of `e1c54e0...` remains pending because normal push and subsequent GitHub HTTPS access failed with timeout/reset errors. No retry loop, remote mutation, or fallback was performed.

## Verification boundary

`main` and `production/main` were not modified. No deployment, SSH, SMTP, queue, outbox, runtime, service, or systemd action occurred.

## Reconciled state

The initial manifest was superseded after the ignored files were identified. The current public candidate manifest is generated from 145 Git-tracked payload files. Its SHA256 is `bccd80b81fc484689a27ab42234c8692ac6030536d56d7b6015d29aeb9a70d3e`. The reconciliation commit `3a6bbc941b1ffe670fcc3672fcc8f2caeef51dd4` was accepted by GitHub via a normal fast-forward push. The current manifest payload is unchanged between the confirmed remote commit and the pending candidate commit.
