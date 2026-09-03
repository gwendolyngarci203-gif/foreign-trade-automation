# NetEase Edge CDP Collection Runbook

Last verified: 2026-08-27

## Active managed HSCode plan

- Plan: `plans/managed-hscode-plan.json`
- Desktop entry point: `tools/run-managed-hscode-plan.ps1`
- Windows task: `DaKings Managed HSCode Plan`, disabled after server cutover; do not enable it while the server timer owns collection
- Each trigger still runs one bounded page/queue cycle. Capacity shortage keeps collection running but remains a hard blocker in the separate sending preflight.
- Latest completed checkpoint: HSCode `4903000`, page 19 contact queue completed 8/8 companies with 92 visible rows, zero failures, and safety state `READY`; 41 unique email domains passed, 6 named people qualified, and the server produced 6 template drafts plus a no-SMTP send simulation. The active server queue is page 22, currently 7/18 companies and 55 visible rows, zero failures.
- Daily managed target: replenish the central send inventory from the actual remaining sender capacity, cover up to 100 companies with partial contact coverage, prepare up to 4 qualified contacts per company, and send at most 2 contacts per company within the global 200-message hard cap. Discovery uses at least `8 x validEmailCompaniesDaily` buyer rows (current plan `1200`, hard cap `2000`) and pauses only when 100 distinct send-ready companies are available; message count alone does not stop collection.
- A visible company mailbox without a personal name is retained as a generic `Purchasing Team` candidate when its domain, company attribution, source trace and suppression checks pass; no personal name is fabricated.
- The runner reuses an unfinished queue before opening the next page. Page and queue keys are idempotent.
- Discovery snapshots carry both top-level `query`/`normalizedHsCode` and the nested source metadata required by the pipeline; a snapshot that cannot pass `validateDiscovery` is not a checkpoint.
- Company names are deduplicated across every prior queue for the same HSCode before a new queue is created. An existing same-page queue is returned unchanged.
- Browser actions are accounted back to the operation task by queue-item id; reruns cannot charge the same company twice.
- A current-day exhausted budget returns `daily_budget_exhausted` before any company search. Only an Asia/Shanghai date change resets counters.
- Login recovery may submit the ACL-restricted, Git-ignored credential file once. CAPTCHA, credential error, permission and MFA remain mandatory human gates.
- Login recovery trigger aliases: `处理网易登录异常` and `处理网络登录异常` are equivalent. After QR scan, the operator replies `已登录`; the controller rechecks the business page and resumes the interrupted managed batch automatically. If CDP inspection times out, restart only `dakings-netease-browser.service` with the persistent profile, then rerun the fixed-element check; do not create a second browser profile.
- The customs page now exposes both `请输入HSCode` and `请输入HSCode，按回车确认`; discovery must use the exact primary placeholder, bind readiness to the result pagination's active item, and wait until all 20 business rows have rendered company, transaction, amount and date columns.
- A valid page with no new contact candidates is a normal `no_candidates` result. The managed runner records the checkpoint and advances pages until a queue is found or the daily buyer-entry budget is exhausted.
- After each bounded queue batch, the runner calls `tools/handoff-managed-pipeline.py <discovery.json> <contact-enrichment.json>` to upload only newly completed, qualified records, synchronize idempotent counters, run server templates and stop at `approval/waiting_input`. A persistent handoff key makes retries idempotent. Run that command manually only to recover an interrupted handoff. It never copies the server AI token locally or bypasses recipient evidence/approval.

## Server ownership transition

- The Linux host now owns a persistent Chromium profile, Xvfb, loopback-only CDP `127.0.0.1:9224`, the production API, local validation/template handoff, pipeline, outbox, feedback, backups and health checks. `deploy/one-click-deploy.ps1` installs and verifies this runtime.
- `dakings-managed-collection.service` runs the existing bounded managed runner against `127.0.0.1:4173`; its timer is enabled after the first server login and no-SMTP batch canary passed.
- The server QR login completed successfully and survived a browser restart. The persistent profile requests the platform's 60-day trusted-session option, but MFA remains a human gate whenever NetEase requires it again.
- Cutover remains exclusive: Windows task `DaKings Managed HSCode Plan` stays disabled. Never enable both collectors or maintain two queue states. The server runner always uses `--simulate-send`, so collection canaries cannot create outbox entries or connect SMTP.

Server checks:

```bash
systemctl status dakings-netease-browser.service
systemctl start dakings-managed-collection.service
systemctl show dakings-managed-collection.service -p Result -p ExecMainStatus
systemctl enable --now dakings-managed-collection.timer
```

Manual full managed cycle:

```powershell
.\tools\run-managed-hscode-plan.ps1
```

Install or repair the daily Windows task:

```powershell
.\tools\install-managed-hscode-task.ps1
```

Do not schedule `run-netease-contact-queue.mjs` or the raw supervisor directly for plan work. The full runner owns login recovery, page selection, discovery freeze, deterministic company selection, task budgeting and the supervisor handoff.

## Final production checkpoint

- Queue: `collection_e977e59e-8f24-408b-9076-ebcc3bac9f93`
- Companies: 1,328 total, 1,328 completed, 0 pending, 0 failed
- Platform contact rows: 6,617
- Parsed contact rows: 6,424
- Deduplicated people: 6,219
- Queue state: `completed`
- Safety state: `READY`
- Workbook: `outputs/20260813_hung_hing_amity_all_contacts/Hung_Hing_Amity_全部买家公司联系人_2026-08-13.xlsx`

The Codex scheduled collection task is paused. Do not enable it before user
acceptance or use completion of this queue as permission to start another one.

## Managed entry points

Start or reuse the isolated browser and local queue service:

```powershell
.\tools\start-netease-collection-runtime.ps1
```

Run one managed supervisor cycle:

```powershell
& "C:\Users\18395\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" `
  ".\tools\netease-contact-supervisor.mjs"
```

Scheduled runs must call the supervisor, never the raw collector. The
supervisor owns the workspace lock, adaptive cooldown, recovery canary,
workbook rebuild, and terminal completion behavior.

If the isolated profile is on the official NetEase login page and the user has
explicitly approved the credential submission in the current interaction, log
in from the ignored credential file without printing either value:

```powershell
& "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" `
  ".\tools\netease-cdp-client.mjs" login-from-file ".\网易外贸通.txt"
```

The command accepts only labeled account/password lines, verifies the complete
field lengths and service agreement, submits once, and returns only a status
and URL. Stop on `captcha`, `credential_error`, `account_error`, or `timeout`;
never retry a credential failure or print the file while diagnosing it.
When the login tab is in the background, bring it to the front through CDP
before dispatching the trusted click on the agreement control. Verify the
control is actually `checked` before the single login submission.

Validate the scheduled wrapper without opening or submitting any platform page:

```powershell
.\tools\run-managed-hscode-plan.ps1 -Check
```

## Browser contract

1. Manage only `.codex_work/edge-cdp-profile`; never terminate the user's other
   Edge processes.
2. Reuse CDP port 9223 and the existing ready page. Do not duplicate the
   profile or create a new browser window for every company.
3. A page is ready only when fixed business elements exist: Global Search,
   top navigation, Company mode, Exact Match, company input, and Search.
4. URL and hash text are not readiness evidence.
5. Wait up to 60 seconds for CDP, 90 seconds for fixed business elements, and
   75 seconds for one company search process.
6. Keep only one ready NetEase page. Duplicate ready pages are closed before a
   managed batch begins.

## Per-company path

1. Claim one queue item with a 30-minute lease.
2. Select Company and Exact Match.
3. Submit the full queue company name.
4. Verify the actual search XHR, submitted value, response total, and returned
   company names.
5. Accept an explicit zero result. Treat display-name variants as a soft
   validation issue, not an automatic timeout.
6. Read only currently visible company and contact rows.
7. Write one `tmp/edge_auto_<company>_<timestamp>.json` artifact.
8. Complete the lease, then wait 15-25 random seconds before the next company.

If the visible `快速锁定商机` 1/3 onboarding overlay blocks the Company or
Keyword tab, click its visible `跳过` control once and verify the overlay is
gone. This overlay is a local UI obstruction, not a CAPTCHA or rate-limit
signal. Do not retry the blocked company until that verification succeeds.

Do not click asynchronous contact-enrichment controls, wait for data
integration, paginate hidden tables, or call non-public endpoints.

## Throughput and cooldown

- Concurrency: 1
- Claim size: 1 company
- Hard supervisor limit: 20 companies per invocation
- Delay between companies: random 15-25 seconds
- Minimum gap between normal batches: 10 minutes
- Recovery first run: 1 company canary
- Cooldown ladder: 30, 45, 60, 90, 120, 180 minutes

If a recovery window completes at least 20 companies before the next severe
boundary, the next boundary returns to the 30-minute probe. If fewer than five
companies complete before another severe boundary, cooldown advances one step.
The ladder never authorizes retrying through an active warning.

## Error classification

Open the circuit immediately:

- `captcha`
- `frequent_operation`
- `permission` or account error
- HTTP 403
- HTTP 429

Record and rotate the item without increasing platform cooldown:

- explicit zero result
- no visible contacts or unpublished fields
- ambiguous/display-name mismatch
- local controller timeout
- transient browser disconnect
- temporary render delay

Three consecutive page-structure failures open the circuit. Local telemetry,
Codex crashes, and controller timeouts are not NetEase safety alarms.

## Recovery and failed items

Severe-boundary recovery requires the API confirmation phrase:

```text
RECOVER COLLECTION <queue-id>
```

Failed-item requeue requires:

```text
RETRY FAILED <queue-id>
```

The supervisor automatically retries one identical failed-item signature at
most once after all untouched work is complete. This prevents both false
completion and infinite retry loops.

## Output acceptance

- The company sheet must contain every frozen buyer company, including zero
  results and unpublished contacts.
- The people sheet contains only parsed, attributable, deduplicated people.
- Platform rows, parsed rows, and deduplicated people are separate metrics.
- Rebuilding the workbook is idempotent.
- Final acceptance includes formula-error scanning and visual review of both
  delivery sheets.

## Prohibited behavior

Do not bypass CAPTCHAs, permissions, rate limits, paywalls, or account controls.
Do not use proxy pools, account rotation, fingerprint spoofing, hidden APIs, or
refresh loops. A successful batch is evidence for these settings on that
account and date, not a universal unlimited-volume guarantee.
