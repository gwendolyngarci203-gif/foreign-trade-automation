# Phase 8.30 Managed Runner One-Item Operational Boundary

## Result

**PASS.** A minimal, opt-in operational boundary now limits one managed collection run to one queue item by setting `MANAGED_RUN_LIMIT=1`.

The change is confined to the existing contact supervisor budget. It does not modify collection logic, queue/checkpoint state machines, pipeline behavior, runtime schemas, systemd units, or delivery behavior.

## Environment and safety gates

- Execution host: `iZ2zebek634r3g49ouokzyZ` (`39.106.182.40`)
- Working directory: `/opt/dakings-prospect-ops/`
- Branch: `production/main`
- HEAD: `92d3c0b6e61762f6a8c300dc497bf879209bd1f9`
- Delivery mode: `manual`
- `dakings-managed-collection.timer/service`: `inactive`
- `dakings-pipeline-worker.timer/service`: `inactive`
- SMTP established connections before and after: `0`
- Managed timer was not started or restored

## Existing control audit

| Capability | Before Phase 8.30 | Finding |
| --- | --- | --- |
| Queue CLI numeric limit | Present | `run-netease-contact-queue.mjs` accepts a limit bounded to 1-20 |
| Managed runner limit | Absent | Supervisor always allowed up to 20 items |
| Canary environment variable | Absent | No `MANAGED_RUN_LIMIT` existed |
| Queue selection | Present | Existing `COLLECTION_QUEUE_ID` and managed plan selection are retained |
| Dry-run | Absent | No production managed-runner dry-run path was found |

The top-level managed runner invokes the contact supervisor once per process. Its existing process launcher merges `process.env` into the child environment, so an operator-supplied `MANAGED_RUN_LIMIT=1` reaches the supervisor without changes to `run-managed-hscode-plan.mjs` or systemd.

## Implementation

Modified files:

- `tools/netease-contact-supervisor.mjs`
  - Parses `MANAGED_RUN_LIMIT`.
  - Bounds an explicit value to 1-20.
  - Applies the value to the existing managed budget calculation.
  - Preserves the historical default maximum of 20 when the variable is absent or invalid.
- `app/tests/deployment-contract-unit.mjs`
  - Adds contract checks for the environment variable and budget clamp.

No new dependency, abstraction, CLI, state file, or systemd configuration was added.

## Verification

Static checks:

```text
node --check tools/netease-contact-supervisor.mjs
node app/tests/deployment-contract-unit.mjs
```

Result: syntax check passed; `deployment contract unit passed`.

The controlled operational invocation used the existing queue and explicit one-item limit:

```text
COLLECTION_SERVICE=http://127.0.0.1:4173 \
COLLECTION_QUEUE_ID=collection_14853386-a6ad-4e13-a4cd-0220a53dfce6 \
OPERATION_TASK_ID=task_2195614e-7736-4255-822a-9603eee6a4ba \
OPERATION_PAGE=416 \
MANAGED_RUN_LIMIT=1 \
COLLECTION_OWNER=phase830-managed-limit-canary \
EDGE_CDP_ENDPOINT=http://127.0.0.1:9224 \
WS_MODULE=/opt/dakings-prospect-ops/browser-runtime/node_modules/ws \
PLAYWRIGHT_MODULE=/opt/dakings-prospect-ops/browser-runtime/node_modules/playwright-core \
PLAYWRIGHT_MODULE_PATH=/opt/dakings-prospect-ops/browser-runtime/node_modules/playwright-core \
/usr/bin/node tools/netease-contact-supervisor.mjs
```

Supervisor result:

- `action`: `canary`
- `budget`: `1`
- Queue transition: 11 pending / 1 completed -> 10 pending / 2 completed
- Exactly one new item completed: `item_4`
- Contact rows: 15
- Queue returned to `ready / READY`
- Active batch: none
- Active lease: none
- Task checkpoint updated for page 416 with 15 extracted rows

## Side-effect audit

| Store | Before SHA-256 | After SHA-256 | Interpretation |
| --- | --- | --- | --- |
| `operations.json` | `9c73c02b2906fb2c779199ba949f7f858cc19a1b916b632cb1eee95c5dc358a9` | `d5db97b35cb57155a3e9cd5321842ac8f69c2e0044c99d6d6a98a2a920c03462` | Expected checkpoint/audit update |
| `contact-collection.json` | `7d1a38e38bdd0cc1e83ba7c5c7c2b3387edb2392422ca5a50e64fc1ad397889e` | `cafd37d4cb90d1d3b71e9e450ceda79702720d048115cd29591209eca87ec65e` | Expected one-item lifecycle and artifact reference |
| `pipeline.json` | `d7bcd31d087e1fd8e3d7717c00ffb3f2c9ada94f4f9dcf0a0192a0fc4a8014b2` | unchanged | No pipeline trigger or consumption |
| `runtime-state.json` | `4e9180fd68ab7b9e07421d8533136dcfbd780ff2ce4def4841544d7cb93655cd` | unchanged | No runtime side effect |
| `outbox.json` | `6efeb6d95831f29e9026412722f15883fddfb741f5314a9f3fc336220cfb715a` | unchanged | No outbox creation or consumption |
| Pipeline artifact tree | `d42aeb52aed868e0e2f6598c7327fcd8bce8c05366392c4e5ecb1c5e96199bcc` | unchanged | No pipeline artifact generated |

SMTP connections remained zero. Delivery mode remained `manual`. All four managed/pipeline timer and service states remained `inactive`.

## Top-level runner boundary

The complete top-level managed runner was not forced past its existing production gate. `/api/managed-cycle` currently reports `collectionLocked=true` with reason `production_sending_started`. This guard was preserved.

The one-item boundary is nevertheless established for a future authorized one-shot invocation because:

1. `run-managed-hscode-plan.mjs` calls the supervisor once per run.
2. Its child-process helper inherits `process.env`.
3. The supervisor operational test proved `MANAGED_RUN_LIMIT=1` produces `budget=1` and processes exactly one item.

## Classification and operational decision

- `RUNNER_LIMIT_ERROR`: not observed
- `CONTROL_BOUNDARY_ERROR`: not observed
- `UNEXPECTED_PIPELINE_TRIGGER`: not observed
- `UNEXPECTED_SEND`: not observed

Phase 8.30 establishes a safe manual one-shot collection boundary. It does **not** authorize restoring `dakings-managed-collection.timer`; the timer remains inactive as required. The supported recovery command must explicitly supply `MANAGED_RUN_LIMIT=1`, keep delivery mode manual, and keep the pipeline scheduler inactive until the single-item result is reviewed.
