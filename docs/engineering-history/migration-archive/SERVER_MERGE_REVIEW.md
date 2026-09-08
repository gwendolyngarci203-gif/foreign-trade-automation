# SERVER_MERGE_REVIEW

Compared sources:

- C: `C:\Users\18395\.codex\worktrees\d721\外贸自动化拓客系统\app\server.mjs`
- D: `D:\zcy\外贸自动化拓客系统\app\server.mjs`

The files differ by approximately 803 lines. No full-file replacement was performed.

| Classification | Hunk family | Decision |
|---|---|---|
| KEEP candidate | observability imports, event-envelope/trace inheritance, classified metrics and reconciliation API/UI wiring | Requires focused review before integration |
| DISCARD for this sync | quota profiles/gates, timer/service state, collection lock, runtime-state, delivery behavior, outbox/SMTP behavior | Not imported |
| HUMAN REVIEW | mixed hunks that combine observability with runtime or delivery changes | Deferred; no automatic merge |

Safety result: `app/server.mjs` remains unchanged on the synchronization branch.
