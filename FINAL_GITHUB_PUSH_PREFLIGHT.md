# Final GitHub Push Preflight

## Target

- Remote URL: `https://github.com/gwendolyngarci203-gif/foreign-trade-automation.git`
- Planned branch: `release/phase12-6-public-v1`
- Remote main ref observed: `b2d5b0e5ee8fc212ca4599a915cac8c454b0e4c7`
- Remote production ref observed: `95713bc5f9f55f780ed07081a21ce16a2ad71f17`

## Candidate

- Source of truth: `D:\zcy\外贸自动化拓客系统`
- Public mirror: `D:\zcy\github-public-release`
- D source commit: `e61fe70de3566a6a586a272f110ff3f1f70c9e87`
- Public payload manifest: `PUBLIC_GITHUB_FILE_MANIFEST.json`
- Preflight manifest SHA256: `b059d98239a03aa948381ecd9bdafa2f4a171bc608b0d99aff405ad3228350f8`

## Checks

| Check | Result |
|---|---|
| Target remote URL readback | PASS |
| Planned release branch absent remotely | PASS |
| Payload manifest (184 files) | PASS |
| Path denylist | PASS |
| Secret-literal scan | PASS |
| Large-file scan | PASS |
| Node syntax | PASS |
| `git diff --check` | PASS |

## Authorization boundary

Only a normal push of the new release branch is authorized. `main` and `production/main` will not be modified, no force push is allowed, and a remote rejection or unexpected branch collision is a stop condition.

## Superseded Manifest

The preflight value above is historical evidence. An initial post-push reconciliation found 41 ignored runtime/data/log files that had never entered Git. The public candidate now uses a tracked-file manifest; see `GITHUB_PUBLIC_SYNC_VERIFICATION.md` and `PUBLIC_GITHUB_FILE_MANIFEST.json`.
