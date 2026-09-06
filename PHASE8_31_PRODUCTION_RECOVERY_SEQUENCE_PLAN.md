# Phase 8.31 Production Recovery Sequence Plan

## Decision

**Do not start either production timer yet.** The functional path is ready for staged recovery, but the current production state still has three operational blockers:

1. `dakings-managed-collection.timer` and `dakings-pipeline-worker.timer` are enabled but inactive and both use `Persistent=true`; starting either may cause an immediate catch-up invocation.
2. The managed daily cycle is locked for business date `2026-09-06` with reason `production_sending_started`. There is no formal same-day unlock endpoint.
3. The verified Phase 8.30 boundary is present in the cloud working tree but is not yet a committed, synchronized production version.

Recovery must keep delivery mode `manual` throughout Phases A-C and must never activate collection and pipeline schedulers for the first time in the same window.

## Audited production baseline

- Host: `iZ2zebek634r3g49ouokzyZ` (`39.106.182.40`)
- Working directory: `/opt/dakings-prospect-ops/`
- Branch: `production/main`
- HEAD: `92d3c0b6e61762f6a8c300dc497bf879209bd1f9`
- Delivery mode: `manual`
- Managed timer/service: `inactive`; timer remains enabled
- Pipeline timer/service: `inactive`; timer remains enabled
- Managed timer: every 15 minutes, `Persistent=true`, randomized delay up to 2 minutes
- Pipeline timer: every 2 minutes, `Persistent=true`, randomized delay up to 20 seconds, worker uses `--drain --max-jobs 6`
- Pipeline inventory: 94 jobs; 0 `queued`, 0 `running`
- Outbox: 0 `pending`, 0 `sending`
- SMTP established connections: 0
- Managed cycle: locked, `productionSends=0`, stored reason `production_sending_started`

## Recovery prerequisites

### Managed scheduler

All conditions must be true before any managed timer start:

- The Phase 8.30 control change and its tests are committed and deployed as one reviewed version.
- `GET /api/delivery-mode` returns `manual` immediately before the window.
- `GET /api/managed-cycle` returns `collectionLocked=false`.
- No managed supervisor, queue runner, pipeline worker, or active queue lease exists.
- Chromium/CDP is healthy, NetEase is logged in, and business-page readiness passes.
- The target queue is `ready`, with no active batch and no lease.
- A systemd environment/drop-in explicitly supplies `MANAGED_RUN_LIMIT=1`; relying on the default limit of 20 is not acceptable during initial recovery.
- Pipeline timer/service is inactive during the first managed scheduler firing.
- Baseline hashes and counts for operations, contact queue, pipeline, runtime, pipeline artifacts, and outbox are recorded.

### Pipeline scheduler

All conditions must be true before any pipeline timer start:

- Delivery mode remains `manual`.
- Managed timer/service is inactive during the first pipeline scheduler firing.
- Pipeline `claimable` count is 0 before starting the timer, so any `Persistent=true` replay is a no-op.
- No `running` job or expired lease needs reconciliation.
- Pipeline artifact root is `/opt/dakings-prospect-ops/deploy/runtime-data/pipeline-artifacts` for the API and worker.
- Outbox has 0 `pending` and 0 `sending`; SMTP connection count is 0.
- Existing 94 jobs are classified before any resume action. Waiting-input jobs must not be bulk-resumed.
- After timer activation is proven idle, only one reviewed job may be made claimable for the first observed tick.

## Delivery-mode strategy

Delivery mode remains `manual` for Phases A, B, and C.

The worker code checks delivery mode before both managed batch sending and automatic approval/send. Manual mode still permits normalization, matching, contact enrichment, validation, drafting, and an approval stop, but it prevents automatic approval and send.

Changing to `auto` is a separate production authorization after Phase C, not an automatic recovery step. Before a future `manual -> auto` transition:

- Stop both collection and pipeline timers/services.
- Confirm no queue lease, no `queued/running` pipeline job, and no active outbox entry.
- Review approval backlog, recipient evidence, sender/account health, capacity, suppression, dedupe, and delivery circuit.
- Perform a separately approved single-send canary with an explicit rollback to `manual`.

Never switch to `auto` while the pipeline timer is active: the next worker start calls the managed batch send scan before claiming jobs.

## Collection-lock strategy

The current lock must not be bypassed by editing `runtime-state.json`, restarting the API to manipulate state, or calling an unrelated endpoint.

The lock is business-date scoped. The preferred recovery is:

1. Wait for the next business-date rollover.
2. Confirm `/api/managed-cycle` naturally reports `collectionLocked=false` and `productionSends=0`.
3. If it remains locked, stop and audit the stored cycle and business-date calculation.

If same-day unlock becomes operationally necessary, first implement and separately validate a formal audited unlock transition. No such endpoint exists now, so same-day managed timer recovery is blocked.

## page_416 remaining-item order

Queue: `collection_14853386-a6ad-4e13-a4cd-0220a53dfce6`

Current state: `ready / READY`, 10 pending, 2 completed, 0 leased, no active batch.

The queue must not be manually reordered. Its existing claim algorithm places control-error items after untouched items, then sorts by `updatedAt`. Because all remaining items currently carry historical control errors, the expected order is:

| Order | Item | Company |
| --- | --- | --- |
| 1 | `item_5` | Allnote Printing Ltd. |
| 2 | `item_6` | Yongyi Construction And Engineering Ltd. |
| 3 | `item_7` | European World Pvt Ltd. |
| 4 | `item_8` | Dennis Amoako |
| 5 | `item_9` | Emmanuel Owusu |
| 6 | `item_10` | Emmansarp Enterprise |
| 7 | `item_11` | The Spicery Ltd. |
| 8 | `item_12` | Imex Shipping Solutions Gp |
| 9 | `item_1` | Global Edutainment Business Operations S. De R.l De C.v. |
| 10 | `item_2` | Yapi Kredi Kultur Sanat Yayincilik Tic Ve San A S |

This is an expected order, not a forced schedule. Any retriable control failure updates the item and rotates it behind the remaining work. After every item, use the API result as the new source of truth.

## Phase A: Collection-only controlled drain

### Enable

- No timer.
- After the lock has legitimately cleared, run one reviewed supervisor invocation at a time with `MANAGED_RUN_LIMIT=1` against page_416.
- Use the verified production CDP/Playwright environment from Phase 8.30.

### Keep disabled

- Managed timer/service.
- Pipeline timer/service.
- Approval automation, outbox consumption, SMTP.
- Delivery mode remains `manual`.

### Validate after every item

- Exactly one item changed from pending to completed, or one structured recoverable failure was recorded.
- Queue returns to `ready`, with no active batch or lease.
- Operation checkpoint identifies the same item/page and has a later timestamp.
- Pipeline store and pipeline artifact hashes remain unchanged.
- Runtime and outbox hashes remain unchanged.
- SMTP connections remain zero.
- NetEase safety signals show no CAPTCHA, rate limit, permission, or account error.

### Rollback/stop conditions

- More than one item is claimed or completed.
- Queue remains `running`, a lease survives the process, or checkpoint reconciliation fails.
- Any CAPTCHA, rate-limit, permission, login, CDP, selector, or target-state error appears.
- Pipeline/outbox/runtime changes outside the expected queue/checkpoint writes.
- Any SMTP connection or send event appears.

On stop, leave the timer inactive, allow the current oneshot to exit, and use the existing lease/checkpoint recovery mechanism. Do not delete or edit queue history.

## Phase B: Pipeline-only controlled recovery

### Enable

- Keep managed collection stopped.
- First start the pipeline timer only when `claimable=0`; treat an immediate `Persistent=true` invocation as expected and verify it is a no-op.
- Then expose/resume only one reviewed pipeline job and observe one scheduler tick.
- Keep `manual` delivery throughout.

### Keep disabled

- Managed timer/service.
- Automatic approval, outbox consumption, SMTP.
- Bulk job resume and bulk pipeline execution.

### Validate

- The initial timer catch-up creates no pipeline, artifact, outbox, or runtime mutation when claimable is zero.
- The single reviewed job reads the correct artifact root and advances only through valid stages.
- Draft output is associated with the intended job and stops at `waiting_input / approval`.
- No automatic approval, outbox creation, delivery event, or SMTP connection occurs.
- No unrelated historical job becomes claimable or changes state.

### Rollback/stop conditions

- Any unrelated job is claimed.
- More than the intended stage/job is processed.
- Artifact path, field mapping, or checkpoint validation fails.
- Approval advances automatically, outbox changes, or SMTP is contacted.

Stop the pipeline timer immediately, wait for the oneshot service to exit, confirm leases are reconciled, and leave the affected job paused/waiting for review. Do not reset pipeline history.

## Phase C: Scheduler coexistence under manual delivery

### Enable

- Only after Phase A drains page_416 without safety incidents and Phase B passes its single-job observation.
- Install and verify the managed service environment boundary `MANAGED_RUN_LIMIT=1` before starting its timer.
- Start the managed timer in a maintenance window while pipeline is temporarily inactive; observe the possible immediate persistent replay.
- Stop managed processing after that one observed cycle, verify the handoff, then allow the pipeline timer to process only the resulting known job.
- After at least three clean alternating cycles, both timers may remain active with delivery still `manual`.

### Keep disabled

- Delivery mode `auto`.
- Automatic approval/send authorization.
- Any SMTP/send timer or worker not explicitly included in this plan.
- Raising `MANAGED_RUN_LIMIT` above 1.

### Validate

- Every managed firing processes at most one queue item.
- Each handoff is idempotent and creates at most the expected single pipeline input/job.
- Pipeline processing stops at approval.
- Outbox active count stays zero and SMTP stays zero.
- Timer schedules settle to their normal cadence after the first persistent replay.
- No task, queue, job, or artifact growth exceeds the per-cycle prediction.

### Rollback/stop conditions

- Any runner reports a budget above 1.
- A timer replay overlaps an existing service or leaves a lease.
- Duplicate handoff/job creation occurs.
- Pipeline reaches sending, an outbox entry becomes active, or SMTP is contacted.
- Chromium/CDP or NetEase account safety degrades.

Rollback is to stop both timers, wait for both oneshot services to finish, restore no data, preserve all audit/checkpoint records, and return to the last verified manual phase.

## Breaking the automatic chain

The production chain is prevented from running end-to-end by four independent controls:

1. Phase A uses no scheduler and no pipeline handoff consumer.
2. Phase B keeps managed collection off and exposes only one pipeline job.
3. Phase C initially alternates the two schedulers instead of starting both together.
4. Delivery mode remains `manual`, which blocks automatic approval and send even after draft generation.

The current recovery target is therefore automated processing only up to the human approval boundary. Production sending remains a separately authorized phase.

## Go/no-go summary

- Phase A now: **NO-GO** while the current collection lock is true and the verified code is uncommitted.
- Phase A after legitimate lock rollover and version freeze: **GO**, one item per reviewed invocation.
- Phase B: **GO after Phase A evidence**, starting with a zero-claimable persistent replay check.
- Phase C: **GO only after A and B pass**, with `MANAGED_RUN_LIMIT=1` explicitly present in the managed systemd environment.
- Delivery mode `auto`: **OUT OF SCOPE / NO-GO** for Phases A-C.
