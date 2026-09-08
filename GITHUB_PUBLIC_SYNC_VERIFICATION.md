# GitHub Public Sync Verification

## Published release branch

- Repository: `https://github.com/gwendolyngarci203-gif/foreign-trade-automation`
- Branch: `release/phase12-6-public-v1`
- Public commit: `609e355c2b69e0a2501a73a6c2882fbf1e2763ca`
- Push result: GitHub accepted the new branch using a normal non-force push.

## Local-to-commit reconciliation

An initial post-push audit found 41 ignored local files incorrectly listed by the export manifest. All were log/runtime, contact, operations, suppression, pipeline artifact, or other `app/data` state files. They were never committed or pushed. They were moved out of the public candidate into the local export quarantine, and the manifest is being regenerated from the Git tracked set.

## Independent clone verification

The intended clean clone verification was attempted after the push but could not connect to `github.com:443`. No retry, remote mutation, or fallback was performed. GitHub's successful push acknowledgement establishes that the named public commit was accepted; independent clone/readback remains a network-dependent follow-up.

## Verification boundary

`main` and `production/main` were not modified. No deployment, SSH, SMTP, queue, outbox, runtime, service, or systemd action occurred.

## Reconciled state

The initial manifest was superseded after the ignored files were identified. The current public candidate manifest is generated from 145 Git-tracked payload files. Its SHA256 is recorded in `PUBLIC_GITHUB_FILE_MANIFEST.json`. The reconciliation commit is local and awaits a normal push because the host could not connect to `github.com:443`; it has not been represented as remote-complete.
