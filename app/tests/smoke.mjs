import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(testDir, "..");
const port = 4187;
const base = `http://127.0.0.1:${port}`;
const campaignPath = path.join(testDir, `.campaigns-${process.pid}.json`);
const validationPath = path.join(testDir, `.validation-${process.pid}.json`);
const suppressionPath = path.join(testDir, `.suppressions-${process.pid}.json`);
const operationsPath = path.join(testDir, `.operations-${process.pid}.json`);
const contactCollectionPath = path.join(testDir, `.contact-collection-${process.pid}.json`);
const contactCollectionSourcePath = path.join(testDir, `.contact-collection-source-${process.pid}.json`);
const contactCollectionArtifactDir = path.join(testDir, `.contact-collection-artifacts-${process.pid}`);
const pipelinePath = path.join(testDir, `.pipeline-${process.pid}.json`);
const pipelineArtifactDir = path.join(testDir, `.pipeline-artifacts-${process.pid}`);
const outboxPath = path.join(testDir, `.outbox-${process.pid}.json`);
const runtimeStatePath = path.join(testDir, `.runtime-state-${process.pid}.json`);
const senderProfilePath = path.join(testDir, `.sender-profile-${process.pid}.json`);
const senderAccountsPath = path.join(testDir, `.sender-accounts-${process.pid}.json`);
const mailboxAccountsPath = path.join(testDir, `.mailbox-accounts-${process.pid}.json`);
const mailboxStorePath = path.join(testDir, `.mailboxes-${process.pid}.json`);
const mailboxReplyPath = path.join(testDir, `.mailbox-replies-${process.pid}.json`);
const hmacSecretPath = path.join(testDir, `.unsubscribe-hmac-${process.pid}.txt`);
const localBackupDir = path.join(testDir, `.backups-${process.pid}`);
const workerInputPath = path.join(testDir, `.worker-input-${process.pid}.json`);
const workerArtifactDir = path.join(testDir, `.worker-artifacts-${process.pid}`);
const sourceFixture = JSON.parse(await fs.readFile(process.env.SOURCE_PATH || path.join(
  appDir,
  "..",
  "采集输出",
  "深圳市金豪彩色印刷有限公司_网易前20买家联系方式_2026-07-19.json",
), "utf8"));
await fs.writeFile(campaignPath, "[]", "utf8");
await fs.writeFile(validationPath, JSON.stringify({ version: 1, records: [] }), "utf8");
await fs.writeFile(suppressionPath, JSON.stringify({ version: 1, records: [] }), "utf8");
await fs.writeFile(operationsPath, JSON.stringify({ version: 1, tasks: [] }), "utf8");
await fs.writeFile(contactCollectionPath, JSON.stringify({ version: 1, queues: [] }), "utf8");
await fs.writeFile(contactCollectionSourcePath, JSON.stringify({ buyers: ["Alpha Books", "Beta Books", "Gamma Books"] }), "utf8");
const pipelineSmokeId = "pipe_11111111-1111-4111-8111-111111111111";
const reserveSmokeId = "pipe_22222222-2222-4222-8222-222222222222";
const racePipelineId = "pipe_33333333-3333-4333-8333-333333333333";
await fs.mkdir(path.join(pipelineArtifactDir, pipelineSmokeId), { recursive: true });
await fs.mkdir(path.join(pipelineArtifactDir, reserveSmokeId), { recursive: true });
await fs.mkdir(path.join(pipelineArtifactDir, racePipelineId), { recursive: true });
const pipelineDraftPath = path.join(pipelineArtifactDir, pipelineSmokeId, "drafting.json");
const reserveDraftPath = path.join(pipelineArtifactDir, reserveSmokeId, "drafting.json");
const raceDraftPath = path.join(pipelineArtifactDir, racePipelineId, "drafting.json");
const pipelineDraftBody = `Hi Alex,

DaKings Cultural and Creative Co., Ltd supports custom children's picture, activity, and coloring book projects from Guangzhou. Your manufacturing work at Example Publisher appears relevant to our book printing, binding, packaging, and post-press finishing capabilities.

For an upcoming title, we can quote against the exact trim size, page count, paper, binding, finishing, pack-out, and delivery requirements. This gives your team a clear specification-based comparison without a long back-and-forth.

Would you be open to sharing one current specification or RFQ for review?

Best regards,
DaKings Printing Company`;
await fs.writeFile(pipelineDraftPath, JSON.stringify({ kind: "pipeline-email-drafts", drafts: [
  { company: "Example Publisher", contactName: "Alex Buyer", contactRole: "VP Manufacturing", email: "alex@example.org", subject: "A printing option for Example Publisher", body: pipelineDraftBody, warnings: [] },
  { company: "Example Publisher", contactName: "Pat Buyer", contactRole: "Operations", email: "pat@example.org", subject: "Another option", body: pipelineDraftBody, warnings: [] },
] }), "utf8");
await fs.writeFile(reserveDraftPath, JSON.stringify({ kind: "pipeline-email-drafts", drafts: [
  { company: "Example Publisher", contactName: "Sam Buyer", contactRole: "Sourcing", email: "sam@example.org", subject: "A sourcing option", body: pipelineDraftBody, warnings: [] },
  { company: "Example Publisher", contactName: "Lee Buyer", contactRole: "Production", email: "lee@example.org", subject: "A production option", body: pipelineDraftBody, warnings: [] },
] }), "utf8");
await fs.writeFile(raceDraftPath, JSON.stringify({ kind: "pipeline-email-drafts", drafts: [
  { company: "Example Publisher", contactName: "Alex Duplicate", contactRole: "Purchasing", email: "alex@example.org", subject: "A concurrent option", body: pipelineDraftBody, warnings: [] },
] }), "utf8");
await fs.writeFile(pipelinePath, JSON.stringify({ version: 1, jobs: [{
  id: pipelineSmokeId, operationTaskId: null, hsCode: "4903000", status: "waiting_input", currentStage: "approval",
  requiredInput: "review", stages: { approval: { status: "waiting_input" }, sending: { status: "pending" }, feedback: { status: "pending" } },
  artifacts: [{ stage: "drafting", reference: pathToFileURL(pipelineDraftPath).href }], audit: [],
}, {
  id: reserveSmokeId, operationTaskId: null, hsCode: "4903000", status: "waiting_input", currentStage: "feedback",
  automation: { mode: "managed" }, batchReview: { status: "sent" },
  requiredInput: "feedback", stages: { approval: { status: "completed" }, sending: { status: "completed" }, feedback: { status: "waiting_input" } },
  artifacts: [{ stage: "drafting", reference: pathToFileURL(reserveDraftPath).href }], audit: [],
}, {
  id: racePipelineId, operationTaskId: null, hsCode: "4903000", status: "waiting_input", currentStage: "approval",
  requiredInput: "review", stages: { approval: { status: "waiting_input" }, sending: { status: "pending" }, feedback: { status: "pending" } },
  artifacts: [{ stage: "drafting", reference: pathToFileURL(raceDraftPath).href }], audit: [],
}] }), "utf8");
await fs.writeFile(outboxPath, JSON.stringify({ version: 1, entries: [] }), "utf8");
await fs.writeFile(runtimeStatePath, JSON.stringify({ version: 1, ai: {} }), "utf8");
await fs.writeFile(senderProfilePath, JSON.stringify({
  version: 1,
  status: "placeholder",
  identityMode: "company_first_round",
  senderName: "",
  senderTitle: "",
  companyLegalName: "[待填写：公司法定名称]",
  companyDisplayName: "DaKings Printing Company",
  senderEmail: "sender@example.test",
  replyTo: "reply@example.test",
  phone: "[待填写：电话]",
  website: "[待填写：公司网址]",
  physicalAddress: "[待填写：完整实体地址]",
  unsubscribeMode: "hosted_link_and_reply",
  unsubscribeBaseUrl: "[待填写：HTTPS退订地址]",
  unsubscribeReplyMailbox: "reply@example.test"
}), "utf8");
await fs.writeFile(senderAccountsPath, JSON.stringify({
  version: 2,
  domains: [
    { domain: "example.test", status: "test", usagePolicy: "approved_small_batch_business_exchange", accounts: [{ address: "maggie1@example.test", smtpAuthStatus: "passed_local_and_server_application_password" }] },
    { domain: "restricted.test", status: "test", usagePolicy: "business_communication_only_no_marketing", accounts: [] },
  ],
}), "utf8");
await fs.writeFile(mailboxAccountsPath, JSON.stringify({ version: 1, accounts: [{
  address: "maggie1@example.test", password: "test-app-password", smtpHost: "127.0.0.1", smtpPort: 465, enabled: true,
}] }), "utf8");
await fs.writeFile(mailboxStorePath, JSON.stringify({
  version: 1,
  updatedAt: "2026-08-24T00:00:00Z",
  accounts: [{ address: "maggie1@example.test", status: "synced", lastSyncAt: "2026-08-25T00:00:00Z", remoteInboxCount: 2 }],
  messages: [
    { id: "mail-smoke-system", account: "maggie1@example.test", folder: "inbox", uid: 2, uidValidity: "1", from: { name: "Post Master", address: "postmaster@example.org" }, to: ["maggie1@example.test"], subject: "Delivery failed", date: "2026-08-25T00:00:00Z", messageId: "system-1@example.org", references: [], unread: true, hasAttachments: false, snippet: "Undeliverable", bodyText: "Undeliverable" },
    { id: "mail-smoke-1", account: "maggie1@example.test", folder: "inbox", uid: 1, uidValidity: "1", from: { name: "Buyer", address: "buyer@example.org" }, to: ["maggie1@example.test"], subject: "Printing inquiry", date: "2026-08-24T00:00:00Z", messageId: "buyer-1@example.org", references: [], unread: true, hasAttachments: false, snippet: "Could you quote this project?", bodyText: "Could you quote this project?" },
  ],
}), "utf8");
await fs.writeFile(mailboxReplyPath, JSON.stringify({ version: 1, entries: [] }), "utf8");
await fs.writeFile(hmacSecretPath, "密钥（Base64URL）：test-hmac-secret-for-smoke-123456789012345678901234567890\n", "utf8");
await fs.writeFile(workerInputPath, JSON.stringify({
  schemaVersion: 1,
  kind: "netease-customs-discovery",
  query: "4903000",
  normalizedHsCode: "490300",
  pagination: { page: 1, pageSize: 2, totalResults: 31607, totalPages: 500 },
  records: [
    { page: 1, row: 1, rowKey: "buyer-1", company: "Example Publisher Inc.", country: "美国", hasContact: true, hsCode: "4903000000", transactions: "12", amountUsd: "123,456.00", latestTradeDate: "2026-07-01" },
    { page: 1, row: 2, rowKey: "logistics-1", company: "Example Freight LLC", country: "美国", hasContact: false, hsCode: "490300", transactions: "3", amountUsd: "未公开", latestTradeDate: "2026-06-01" },
  ],
}), "utf8");

const validCampaignBody = `Hi {{first_name}},

DaKings Cultural and Creative Co., Ltd supports custom children's picture, activity, and coloring book projects from Guangzhou. {{company}}'s work appears relevant to our book printing, binding, packaging and post-press finishing capabilities.

For an upcoming title, we can quote against the exact trim size, page count, paper, binding, finishing, pack-out and delivery requirements. This gives your team a clear specification-based comparison without a long back-and-forth.

Would you be open to sharing one current specification or RFQ for review? If another colleague manages print sourcing, I would appreciate an introduction.

Best regards,
DaKings Printing Company`;

const validBrief = {
  scenario: "first_touch",
  hsCode: "4903000",
  productFocus: "Children's picture, drawing, coloring and activity books.",
  buyerEvidence: "Buyer publishes or sources children's activity and coloring books.",
  contactRole: "Logistics Manager",
};

let aiRequestBody;
const mockOpenAi = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  aiRequestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(req.url, "/responses");
  assert.equal(req.headers.authorization, "Bearer test-key");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    model: "gpt-5.6-sol-test",
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: `Draft follows:\n\`\`\`json\n${JSON.stringify({
          subject: "A printing option for {{company}}",
          body: "Hi {{first_name}},\n\nWe noticed {{company}} works with illustrated publishing projects. DaKings Cultural and Creative Co., Ltd provides book printing, binding, packaging, and post-press finishing in China. Would a concise quotation checklist for an upcoming title be useful?\n\nBest regards,\nDaKings Printing Company",
        })}\n\`\`\``,
      }],
    }],
  }));
});
await new Promise((resolve) => mockOpenAi.listen(0, "127.0.0.1", resolve));
const mockOpenAiPort = mockOpenAi.address().port;

const smtpMessages = [];
const mockSmtp = net.createServer((socket) => {
  let buffer = "";
  let authStep = 0;
  let readingData = false;
  socket.write("220 mock-smtp ESMTP ready\r\n");
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (buffer) {
      if (readingData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) return;
        smtpMessages.push(buffer.slice(0, end));
        buffer = buffer.slice(end + 5);
        readingData = false;
        socket.write("250 2.0.0 queued\r\n");
        continue;
      }
      const lineEnd = buffer.indexOf("\r\n");
      if (lineEnd < 0) return;
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 2);
      if (/^EHLO /.test(line)) socket.write("250-mock-smtp\r\n250 AUTH LOGIN\r\n");
      else if (line === "AUTH LOGIN") { authStep = 1; socket.write("334 VXNlcm5hbWU6\r\n"); }
      else if (authStep === 1) { authStep = 2; socket.write("334 UGFzc3dvcmQ6\r\n"); }
      else if (authStep === 2) { authStep = 0; socket.write("235 2.7.0 authenticated\r\n"); }
      else if (/^MAIL FROM:/.test(line)) socket.write("250 2.1.0 sender ok\r\n");
      else if (/^RCPT TO:/.test(line)) socket.write("250 2.1.5 recipient ok\r\n");
      else if (line === "DATA") { readingData = true; socket.write("354 end with dot\r\n"); }
      else if (line === "QUIT") { socket.write("221 2.0.0 bye\r\n"); socket.end(); }
    }
  });
});
await new Promise((resolve) => mockSmtp.listen(0, "127.0.0.1", resolve));
const mockSmtpPort = mockSmtp.address().port;
await fs.writeFile(mailboxAccountsPath, JSON.stringify({ version: 1, accounts: [{
  address: "maggie1@example.test", password: "test-app-password", smtpHost: "127.0.0.1", smtpPort: mockSmtpPort,
  smtpSecure: false, smtpAllowInsecureAuth: true, enabled: true,
}] }), "utf8");

const child = spawn(process.execPath, [path.join(appDir, "server.mjs")], {
  cwd: appDir,
  env: {
    ...process.env,
    PORT: String(port),
    CAMPAIGN_PATH: campaignPath,
    VALIDATION_PATH: validationPath,
    SUPPRESSION_PATH: suppressionPath,
    OPERATIONS_PATH: operationsPath,
    CONTACT_COLLECTION_PATH: contactCollectionPath,
    CONTACT_COLLECTION_ARTIFACT_DIR: contactCollectionArtifactDir,
    PIPELINE_PATH: pipelinePath,
    PIPELINE_ARTIFACT_DIR: pipelineArtifactDir,
    OUTBOX_PATH: outboxPath,
    RUNTIME_STATE_PATH: runtimeStatePath,
    SENDER_PROFILE_PATH: senderProfilePath,
    SENDER_ACCOUNTS_PATH: senderAccountsPath,
    MAILBOX_ACCOUNTS_PATH: mailboxAccountsPath,
    MAILBOX_STORE_PATH: mailboxStorePath,
    MAILBOX_REPLY_STORE_PATH: mailboxReplyPath,
    MAILBOX_REPLY_ENABLED: "false",
    UNSUBSCRIBE_HMAC_SECRET_FILE: hmacSecretPath,
    LOCAL_BACKUP_DIR: localBackupDir,
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: `http://127.0.0.1:${mockOpenAiPort}`,
    OPENAI_MODEL: "gpt-5.6-sol",
    AI_MIN_INTERVAL_MS: "250",
    FEEDBACK_WEBHOOK_SECRET: "test-feedback-secret",
    EMAIL_SENDING_ENABLED: "true",
    EMAIL_ALLOW_UNVERIFIED: "true",
    EMAIL_UNSUBSCRIBE_URL: "https://example.test/unsubscribe",
    EMAIL_PHYSICAL_ADDRESS: "Dakings, Shenzhen, China",
    SEND_BATCH_LIMIT: "2",
    SEND_DAILY_LIMIT: "5",
    OPS_ALERT_EMAIL: "ops-owner@example.test",
    SEND_DELAY_MS: "500",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(mockSmtpPort),
    SMTP_SECURE: "false",
    SMTP_STARTTLS: "false",
    SMTP_ALLOW_INSECURE_AUTH: "true",
    SMTP_USER: "test-user",
    SMTP_PASS: "test-pass",
    ALLOW_INSECURE_SMTP_FOR_TESTS: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

async function request(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json();
  return { response, body };
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const { response } = await request("/api/health");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not become healthy");
}

try {
  await waitForHealth();

  const health = await request("/api/health");
  assert.equal(health.body.ai.configured, true);
  assert.equal(health.body.ai.model, "gpt-5.6-sol");
  assert.equal(health.body.delivery.enabled, true);
  assert.equal(health.body.delivery.smtpConfigured, true);
  assert.equal(health.body.delivery.batchLimit, 2);
  assert.equal(health.body.delivery.senderFleet.accountLimit, 50);
  assert.equal(health.body.delivery.senderFleet.configured, 1);
  assert.deepEqual(health.body.delivery.daily, {
    businessDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()),
    used: 0,
    limit: 5,
    remaining: 5,
  });
  assert.equal(health.body.feedback.webhookConfigured, true);
  assert.equal(health.body.feedback.eventCount, 0);
  assert.equal(health.body.mailbox.configuredAccounts, 1);
  assert.equal(health.body.mailbox.replyEnabled, false);
  assert.equal(health.body.delivery.senderProfile.readyForCanary, false);
  assert.equal(health.body.delivery.automationMode, "manual");
  const autoMode = await request("/api/delivery-mode", { method: "PUT", body: JSON.stringify({ mode: "auto", updatedBy: "smoke" }) });
  assert.equal(autoMode.response.status, 200);
  assert.equal(autoMode.body.mode, "auto");
  const resetMode = await request("/api/delivery-mode", { method: "PUT", body: JSON.stringify({ mode: "manual", updatedBy: "smoke-reset" }) });
  assert.equal(resetMode.body.mode, "manual");

  const managedPlan = await request("/api/managed-plan");
  assert.equal(managedPlan.response.status, 200);
  assert.equal(managedPlan.body.hsCodes[0].hsCode, "4903000");
  assert.equal(managedPlan.body.dailyBudgets.globalEmailHardCap, 500);
  assert.equal(managedPlan.body.authorizedBy, undefined);

  const mailbox = await request("/api/mailbox");
  assert.equal(mailbox.response.status, 200);
  assert.equal(mailbox.body.counts.accounts, 1);
  assert.equal(mailbox.body.messages[0].id, "mail-smoke-1");
  assert.equal(mailbox.body.messages[1].id, "mail-smoke-system");
  assert.equal("bodyText" in mailbox.body.messages[0], false);
  const mailboxMessage = await request("/api/mailbox/messages/mail-smoke-1");
  assert.equal(mailboxMessage.body.bodyText, "Could you quote this project?");
  const lockedMailboxReply = await request("/api/mailbox/messages/mail-smoke-1/reply", { method: "POST", body: JSON.stringify({ body: "Thank you", confirm: "REPLY mail-smoke-1" }) });
  assert.equal(lockedMailboxReply.response.status, 423);
  const lockedMailboxCompose = await request("/api/mailbox/compose", { method: "POST", body: JSON.stringify({ account: "maggie1@example.test", to: "buyer@example.org", subject: "Hello", body: "Thank you", normalBusinessConfirmed: true, confirm: "SEND MAIL maggie1@example.test" }) });
  assert.equal(lockedMailboxCompose.response.status, 423);

  const placeholderProfile = await request("/api/sender-profile");
  assert.equal(placeholderProfile.response.status, 200);
  assert.equal(placeholderProfile.body.readiness.readyForCanary, false);
  assert.equal(placeholderProfile.body.readiness.hasPlaceholders, true);

  const invalidReplyTo = await request("/api/sender-profile", {
    method: "PUT",
    body: JSON.stringify({ replyTo: "not-an-email" }),
  });
  assert.equal(invalidReplyTo.response.status, 422);

  const invalidUnsubscribe = await request("/api/sender-profile", {
    method: "PUT",
    body: JSON.stringify({ unsubscribeBaseUrl: "http://example.test/unsubscribe" }),
  });
  assert.equal(invalidUnsubscribe.response.status, 422);

  const configuredProfile = await request("/api/sender-profile", {
    method: "PUT",
    body: JSON.stringify({
      senderName: "Maggie",
      senderTitle: "Business Development Manager",
      companyLegalName: "DaKings Cultural and Creative Co., Ltd",
      companyDisplayName: "DaKings Printing Company",
      senderEmail: "sender@example.test",
      replyTo: "reply@example.test",
      phone: "+86 20 0000 0000",
      website: "https://www.example.test",
      physicalAddress: "Room 701, No. 2, Kehui 1st Street, Science City, Huangpu District, Guangzhou, Guangdong, China",
      unsubscribeMode: "reply_only",
      unsubscribeBaseUrl: "",
      unsubscribeReplyMailbox: "unsubscribe@example.test",
      updatedBy: "smoke-test",
    }),
  });
  assert.equal(configuredProfile.response.status, 200);
  assert.equal(configuredProfile.body.readiness.readyForCanary, true);
  assert.equal(configuredProfile.body.status, "configured");
  assert.equal(configuredProfile.body.identityMode, "company_first_round");
  assert.equal(configuredProfile.body.secondRound.status, "reserved_blank");
  assert.equal(configuredProfile.body.secondRound.body, "");
  assert.equal(configuredProfile.body.unsubscribeHmac.configured, true);
  assert.equal(configuredProfile.body.unsubscribeHmac.activeForReplyOnly, false);

  const draftInbox = await request("/api/pipeline/drafts?limit=2");
  assert.equal(draftInbox.response.status, 200);
  assert.equal(draftInbox.body.counts.returned, 2);
  assert.equal(draftInbox.body.counts.totalDrafts, 5);
  assert.equal(draftInbox.body.items[0].company, "Example Publisher");
  assert.equal(draftInbox.body.items[0].email, "alex@example.org");

  const duplicateCompanyApproval = await request(`/api/pipeline/jobs/${pipelineSmokeId}/approve`, {
    method: "POST",
    body: JSON.stringify({
      confirm: `APPROVE PIPELINE ${pipelineSmokeId}`,
      draftIndexes: [0, 1],
      recipientEvidence: [],
    }),
  });
  assert.equal(duplicateCompanyApproval.response.status, 422);
  assert.match(duplicateCompanyApproval.body.error, /同一公司|收件人必须/);
  const invalidEvidenceApproval = await request(`/api/pipeline/jobs/${pipelineSmokeId}/approve`, {
    method: "POST",
    body: JSON.stringify({
      confirm: `APPROVE PIPELINE ${pipelineSmokeId}`,
      draftIndexes: [0],
      recipientEvidence: [{ deliverableConfirmed: true, currentEmploymentConfirmed: true, sources: ["not-a-url", "also-not-a-url"] }],
    }),
  });
  assert.equal(invalidEvidenceApproval.response.status, 422);
  assert.match(invalidEvidenceApproval.body.error, /来源证据/);
  const raceApproval = await request(`/api/pipeline/jobs/${racePipelineId}/approve`, {
    method: "POST",
    body: JSON.stringify({
      confirm: `APPROVE PIPELINE ${racePipelineId}`,
      reviewer: "smoke-owner",
      draftIndexes: [0],
      recipientEvidence: [{
        deliverableConfirmed: true,
        currentEmploymentConfirmed: true,
        sources: ["https://example.org/source-1", "https://example.org/source-2"],
      }],
    }),
  });
  assert.equal(raceApproval.response.status, 200);
  const dailyBatch = await request("/api/pipeline/daily-batch?limit=200");
  assert.equal(dailyBatch.response.status, 200);
  assert.ok(dailyBatch.body.selected.length >= 1 && dailyBatch.body.selected.length <= 2);
  assert.equal(dailyBatch.body.sendsRequireApproval, true);
  const centralOnlyBatch = await request("/api/pipeline/daily-batch?limit=200&central=1");
  assert.equal(centralOnlyBatch.response.status, 200);
  assert.equal(centralOnlyBatch.body.centralOnly, true);
  assert.equal(centralOnlyBatch.body.sendsRequireApproval, false);
  assert.equal(centralOnlyBatch.body.selected.length, 2);
  const centralBatchWithoutConfirmation = await request("/api/pipeline/central-batch/send", {
    method: "POST",
    body: JSON.stringify({ reviewer: "smoke-test" }),
  });
  assert.equal(centralBatchWithoutConfirmation.response.status, 428);
  const pipelineSimulation = await request(`/api/pipeline/jobs/${pipelineSmokeId}/simulate-send`, {
    method: "POST",
    body: JSON.stringify({ confirm: `SIMULATE SEND PIPELINE ${pipelineSmokeId}`, simulation: true }),
  });
  assert.equal(pipelineSimulation.response.status, 200);
  assert.equal(pipelineSimulation.body.simulation, true);
  assert.equal(pipelineSimulation.body.smtp, false);
  assert.equal(pipelineSimulation.body.outboxCreated, 0);
  assert.equal(pipelineSimulation.body.stage, "approval");
  const pipelineApproval = await request(`/api/pipeline/jobs/${pipelineSmokeId}/approve`, {
    method: "POST",
    body: JSON.stringify({
      confirm: `APPROVE PIPELINE ${pipelineSmokeId}`,
      reviewer: "smoke-owner",
      draftIndexes: [0],
      recipientEvidence: [{
        deliverableConfirmed: true,
        currentEmploymentConfirmed: true,
        sources: ["https://example.org/source-1", "https://example.org/source-2"],
      }],
    }),
  });
  assert.equal(pipelineApproval.response.status, 200);
  assert.equal(pipelineApproval.body.currentStage, "sending");
  const [pipelineSend, raceSend] = await Promise.all([
    request(`/api/pipeline/jobs/${pipelineSmokeId}/send`, {
      method: "POST",
      body: JSON.stringify({ confirm: `SEND PIPELINE ${pipelineSmokeId}` }),
    }),
    request(`/api/pipeline/jobs/${racePipelineId}/send`, {
      method: "POST",
      body: JSON.stringify({ confirm: `SEND PIPELINE ${racePipelineId}` }),
    }),
  ]);
  const acceptedPipelineSend = [pipelineSend, raceSend].find((result) => result.response.status === 200);
  const duplicatePipelineSend = [pipelineSend, raceSend].find((result) => [409, 423].includes(result.response.status));
  assert.ok(acceptedPipelineSend);
  assert.ok(duplicatePipelineSend);
  assert.equal(acceptedPipelineSend.body.delivery.accepted, 1);
  assert.ok([duplicatePipelineSend.body.error, ...(duplicatePipelineSend.body.details || [])].some((item) => /发件箱中|重复/.test(item)));
  assert.equal(acceptedPipelineSend.body.currentStage, "feedback");
  const managedCycleAfterSending = await request("/api/managed-cycle");
  assert.equal(managedCycleAfterSending.body.collectionLocked, true);
  assert.ok(managedCycleAfterSending.body.productionSends >= 1);
  const currentDayBatch = await request("/api/pipeline/daily-batch?limit=200&central=1");
  assert.equal(currentDayBatch.body.selected.length, 1);
  assert.equal(currentDayBatch.body.reserveMode, false);
  const reserveBatch = await request("/api/pipeline/daily-batch?limit=200&reserve=1");
  assert.equal(reserveBatch.body.selected.length, 2);
  assert.equal(reserveBatch.body.reserveMode, true);
  const inventory = await request("/api/pipeline/inventory?limit=200");
  assert.equal(inventory.response.status, 200);
  assert.equal(inventory.body.inventory.totalCompanies, inventory.body.selectedCompanyCount);
  assert.equal(
    inventory.body.draftPool.remaining,
    inventory.body.draftPool.total - inventory.body.draftPool.sent,
  );
  assert.equal(inventory.body.inventory.ready, inventory.body.inventory.totalCompanies >= inventory.body.inventory.target);
  assert.ok(Number.isInteger(inventory.body.currentSendableCount));
  assert.ok(["collecting", "drafting", "sending", "aborted", "circuit_open", "ended"].includes(inventory.body.dailyStatus.code));

  const aiDraft = await request("/api/ai/draft", {
    method: "POST",
    body: JSON.stringify({
      scenario: "first_touch",
      hsCode: "4903000",
      productFocus: "Children's picture and activity books.",
      buyerCompany: "{{company}}",
      buyerEvidence: "Buyer imports illustrated books.",
      companyBusiness: "Book printing, binding, packaging, and finishing.",
      senderCompany: "DaKings Printing Company",
      language: "English",
    }),
  });
  assert.equal(aiDraft.response.status, 200);
  assert.equal(aiDraft.body.model, "gpt-5.6-sol-test");
  assert.match(aiDraft.body.subject, /\{\{company\}\}/);
  assert.equal(aiRequestBody.model, "gpt-5.6-sol");
  assert.equal(aiRequestBody.reasoning.effort, "none");
  assert.equal(aiRequestBody.text.format.type, "json_schema");
  assert.deepEqual(aiRequestBody.text.format.schema.required, ["subject", "body"]);
  assert.match(aiRequestBody.input, /4903000/);
  assert.match(aiRequestBody.instructions, /Never mention the HS code/);
  assert.match(aiRequestBody.instructions, /structural blueprint/);
  assert.match(aiRequestBody.instructions, /company voice using we\/our/);
  assert.doesNotMatch(aiDraft.body.body, /\b(?:I am|I'm|my name is)\b/i);
  await new Promise((resolve) => setTimeout(resolve, 260));
  const aiDrafts = await request("/api/ai/drafts", {
    method: "POST",
    body: JSON.stringify({
      scenarios: ["first_touch", "factory_proof"],
      hsCode: "4903000",
      productFocus: "Children's picture and activity books.",
      buyerCompany: "{{company}}",
      buyerEvidence: "Buyer imports illustrated books.",
      companyBusiness: "Book printing, binding, packaging, and finishing.",
      senderCompany: "DaKings Printing Company",
      language: "English",
    }),
  });
  assert.equal(aiDrafts.response.status, 200);
  assert.deepEqual(aiDrafts.body.drafts.map((draft) => draft.scenario), ["first_touch", "factory_proof"]);
  const healthAfterAi = await request("/api/health");
  assert.equal(healthAfterAi.body.ai.reachable, true);
  assert.ok(healthAfterAi.body.ai.lastAttemptAt);
  assert.ok(healthAfterAi.body.ai.lastSuccessAt);

  const options = await request("/api/options");
  assert.equal(options.body.emailScenarios.length, 5);
  assert.equal(options.body.emailAssets.length, 9);
  assert.ok(options.body.emailClaims.some((item) => item.id === "open_account_terms"));
  assert.equal(options.body.emailTemplate.version, "2026-08-19");

  const summary = await request("/api/summary");
  assert.equal(summary.response.status, 200);
  assert.equal(summary.body.buyerCount, Number(sourceFixture.raw_buyer_count));
  assert.equal(summary.body.uniqueContacts, Number(sourceFixture.contact_summary.unique_contacts));
  assert.equal(summary.body.uniqueEmails, Number(sourceFixture.contact_summary.unique_emails));
  assert.equal(summary.body.sendingEnabled, false);

  const quality = await request("/api/quality");
  assert.equal(quality.response.status, 200);
  assert.equal(quality.body.metrics.buyers, sourceFixture.all_buyers.length);
  assert.equal(quality.body.metrics.validationCounts.unverified, quality.body.metrics.uniqueEmails);
  assert.ok(quality.body.metrics.validationLinkCounts.unverified >= quality.body.metrics.validationCounts.unverified);
  assert.equal(quality.body.safeToSend, false);
  assert.ok(Array.isArray(quality.body.issues));

  const contactQuality = await request("/api/contact-quality");
  assert.equal(contactQuality.body.counts.unverified, quality.body.metrics.uniqueEmails);
  assert.ok(contactQuality.body.linkCounts.unverified >= contactQuality.body.counts.unverified);

  const buyers = await request("/api/buyers?country=Mexico&pageSize=5");
  assert.equal(buyers.response.status, 200);
  assert.equal(buyers.body.items.length, 5);
  assert.ok(buyers.body.items.every((item) => item.country === "Mexico"));

  const contacts = await request("/api/contacts?priority=A-采购%2F运营&emailOnly=true&pageSize=10");
  assert.equal(contacts.response.status, 200);
  assert.ok(contacts.body.items.every((item) => item.email && item.priority === "A-采购/运营"));
  const contactEmail = contacts.body.items[0].email;

  const syntaxValidation = await request("/api/contact-quality/validate", {
    method: "POST",
    body: JSON.stringify({ email: contactEmail, mode: "syntax" }),
  });
  assert.equal(syntaxValidation.response.status, 200);
  assert.equal(syntaxValidation.body.results[0].status, "syntax_valid");
  assert.equal(syntaxValidation.body.results[0].emailHash, undefined);

  const invalidValidation = await request("/api/contact-quality/validate", {
    method: "POST",
    body: JSON.stringify({ email: "not-an-email", mode: "syntax" }),
  });
  assert.equal(invalidValidation.body.results[0].status, "invalid");

  const batchValidation = await request("/api/contact-quality/validate", {
    method: "POST",
    body: JSON.stringify({ contactIds: contacts.body.items.slice(0, 2).map((item) => item.id), mode: "syntax" }),
  });
  assert.equal(batchValidation.response.status, 200);
  assert.equal(batchValidation.body.processed, 2);
  assert.ok(batchValidation.body.uniqueDomains >= 1);

  const rejectedManualDeliverable = await request("/api/contact-quality/status", {
    method: "POST",
    body: JSON.stringify({ email: contactEmail, status: "deliverable", evidence: "untraceable note" }),
  });
  assert.equal(rejectedManualDeliverable.response.status, 422);
  const manualDeliverable = await request("/api/contact-quality/status", {
    method: "POST",
    body: JSON.stringify({ email: contactEmail, status: "deliverable", evidence: "https://evidence.example/contact-record" }),
  });
  assert.equal(manualDeliverable.response.status, 200);
  assert.equal(manualDeliverable.body.status, "deliverable");

  const suppression = await request("/api/suppressions", {
    method: "POST",
    body: JSON.stringify({ email: contactEmail, reason: "manual", source: "smoke-test" }),
  });
  assert.equal(suppression.response.status, 201);
  const suppressions = await request("/api/suppressions");
  assert.equal(suppressions.body.count, 1);
  assert.equal(suppressions.body.items[0].fingerprint.length, 12);

  const rejectedFeedback = await request("/api/feedback/events", {
    method: "POST",
    body: JSON.stringify({ eventId: "evt-feedback-1", type: "complaint", email: contactEmail }),
  });
  assert.equal(rejectedFeedback.response.status, 401);
  const feedback = await request("/api/feedback/events", {
    method: "POST",
    headers: { "x-feedback-secret": "test-feedback-secret", "x-feedback-source": "smoke-provider" },
    body: JSON.stringify({ eventId: "evt-feedback-1", type: "complaint", email: contactEmail }),
  });
  assert.equal(feedback.response.status, 202);
  assert.equal(feedback.body.suppressed, true);
  assert.equal(feedback.body.recipientFingerprint.length, 12);
  const trippedCircuit = await request("/api/delivery-circuit");
  assert.equal(trippedCircuit.body.open, true);
  assert.equal(trippedCircuit.body.reason, "complaint");
  const duplicateFeedback = await request("/api/feedback/events", {
    method: "POST",
    headers: { "x-feedback-secret": "test-feedback-secret", "x-feedback-source": "smoke-provider" },
    body: JSON.stringify({ eventId: "evt-feedback-1", type: "complaint", email: contactEmail }),
  });
  assert.equal(duplicateFeedback.response.status, 200);
  assert.equal(duplicateFeedback.body.duplicate, true);
  const sameIdDifferentSource = await request("/api/feedback/events", {
    method: "POST",
    headers: { "x-feedback-secret": "test-feedback-secret", "x-feedback-source": "secondary-provider" },
    body: JSON.stringify({ eventId: "evt-feedback-1", type: "reply", email: "reply-source@example.test" }),
  });
  assert.equal(sameIdDifferentSource.response.status, 202);
  assert.equal(sameIdDifferentSource.body.duplicate, false);
  assert.equal(sameIdDifferentSource.body.suppressed, false);

  const feedbackCases = [
    ["unsubscribe", true],
    ["hard_bounce", true],
    ["soft_bounce", false],
    ["reply", false],
    ["auto_reply", false],
  ];
  for (const [type, shouldSuppress] of feedbackCases) {
    const event = await request("/api/feedback/events", {
      method: "POST",
      headers: { "x-feedback-secret": "test-feedback-secret", "x-feedback-source": "fault-injection" },
      body: JSON.stringify({
        eventId: `evt-${type}`,
        type,
        email: `${type.replace("_", "-")}@example.test`,
        occurredAt: "2026-08-04T12:00:00Z",
      }),
    });
    assert.equal(event.response.status, 202);
    assert.equal(event.body.suppressed, shouldSuppress);
  }

  const hashOnlyFeedback = await request("/api/feedback/events", {
    method: "POST",
    headers: { "x-feedback-secret": "test-feedback-secret", "x-feedback-source": "privacy-provider" },
    body: JSON.stringify({ eventId: "evt-hash-only", type: "reply", recipientHash: "a".repeat(64) }),
  });
  assert.equal(hashOnlyFeedback.response.status, 202);
  assert.equal(hashOnlyFeedback.body.recipientFingerprint, "a".repeat(12));
  assert.equal(hashOnlyFeedback.body.suppressed, false);

  const invalidFeedbackType = await request("/api/feedback/events", {
    method: "POST",
    headers: { "x-feedback-secret": "test-feedback-secret" },
    body: JSON.stringify({ eventId: "evt-invalid-type", type: "delivered", email: "invalid-type@example.test" }),
  });
  assert.equal(invalidFeedbackType.response.status, 422);
  const missingRecipientFeedback = await request("/api/feedback/events", {
    method: "POST",
    headers: { "x-feedback-secret": "test-feedback-secret" },
    body: JSON.stringify({ eventId: "evt-missing-recipient", type: "reply" }),
  });
  assert.equal(missingRecipientFeedback.response.status, 422);

  const feedbackHealth = await request("/api/health");
  assert.equal(feedbackHealth.body.feedback.eventCount, 8);
  const feedbackRuntime = JSON.parse(await fs.readFile(runtimeStatePath, "utf8"));
  assert.equal(feedbackRuntime.feedback.events.length, 8);
  assert.equal(JSON.stringify(feedbackRuntime).includes(contactEmail), false);
  const rejectedCircuitRecovery = await request("/api/delivery-circuit/recover", { method: "POST", body: "{}" });
  assert.equal(rejectedCircuitRecovery.response.status, 428);
  const recoveredCircuit = await request("/api/delivery-circuit/recover", {
    method: "POST",
    body: JSON.stringify({ confirm: "RECOVER DELIVERY" }),
  });
  assert.equal(recoveredCircuit.body.open, false);

  const task = await request("/api/ops/tasks", {
    method: "POST",
    body: JSON.stringify({
      hsCode: "4903000",
      direction: "buyer",
      countries: ["United States"],
      budgets: { buyerEntriesDaily: 2, companyDetailsDaily: 1, contactPagesDaily: 2 },
    }),
  });
  assert.equal(task.response.status, 201);
  assert.equal(task.body.safetyState, "READY");
  assert.equal(task.body.automation.mode, "supervised");
  assert.equal(task.body.budgets.emailSendsDaily, 20);
  const pipelineInitial = await request("/api/pipeline");
  assert.equal(pipelineInitial.body.jobs.length, 4);
  const pipelineJob = pipelineInitial.body.jobs.find((item) => item.currentStage === "discovery");
  assert.equal(pipelineJob.status, "waiting_input");
  const pipelineResume = await request(`/api/pipeline/jobs/${pipelineJob.id}/resume`, {
    method: "POST",
    body: JSON.stringify({ inputReference: "smoke://netease/hscode/4903000/page-1" }),
  });
  assert.equal(pipelineResume.body.status, "queued");
  const pipelineClaim = await request("/api/pipeline/claim-next", {
    method: "POST",
    body: JSON.stringify({ owner: "smoke-worker", leaseSeconds: 60 }),
  });
  assert.equal(pipelineClaim.body.job.status, "running");
  assert.equal(pipelineClaim.body.job.leaseOwner, "smoke-worker");
  const pipelineStage = await request(`/api/pipeline/jobs/${pipelineJob.id}/stage`, {
    method: "POST",
    body: JSON.stringify({
      owner: "smoke-worker",
      stage: "discovery",
      outcome: "completed",
      artifact: { reference: "smoke://artifact/discovery.json", counts: { buyers: 50000 } },
    }),
  });
  assert.equal(pipelineStage.body.status, "queued");
  assert.equal(pipelineStage.body.currentStage, "trade_normalization");
  assert.equal(pipelineStage.body.artifacts[0].counts.buyers, 50000);

  const workerPipeline = await request("/api/pipeline/jobs", {
    method: "POST",
    body: JSON.stringify({ hsCode: "4903000", direction: "buyer", countries: [] }),
  });
  assert.equal(workerPipeline.response.status, 201);
  const workerResume = await request(`/api/pipeline/jobs/${workerPipeline.body.id}/resume`, {
    method: "POST",
    body: JSON.stringify({ inputReference: workerInputPath }),
  });
  assert.equal(workerResume.body.status, "queued");
  const workerRun = spawn(process.execPath, [path.join(appDir, "pipeline-worker.mjs"), "--drain", "--max-jobs", "4"], {
    cwd: appDir,
    env: {
      ...process.env,
      PIPELINE_API_BASE: base,
      PIPELINE_INPUT_ROOT: testDir,
      PIPELINE_ARTIFACT_DIR: workerArtifactDir,
      PIPELINE_WORKER_OWNER: "smoke-pipeline-worker",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let workerStdout = "";
  let workerStderr = "";
  workerRun.stdout.on("data", (chunk) => { workerStdout += chunk.toString("utf8"); });
  workerRun.stderr.on("data", (chunk) => { workerStderr += chunk.toString("utf8"); });
  const workerExit = await new Promise((resolve) => workerRun.once("exit", resolve));
  assert.equal(workerExit, 0, workerStderr);
  const workerSummary = JSON.parse(workerStdout.trim());
  assert.equal(workerSummary.processed.length, 4, `${workerStdout}\n${workerStderr}`);
  const workerPipelineAfter = await request("/api/pipeline");
  const processedWorkerJob = workerPipelineAfter.body.jobs.find((item) => item.id === workerPipeline.body.id);
  assert.equal(processedWorkerJob.status, "waiting_input");
  assert.equal(processedWorkerJob.currentStage, "contact_enrichment");
  assert.equal(processedWorkerJob.artifacts.filter((item) => item.stage === "discovery").length, 1);
  assert.equal(processedWorkerJob.artifacts.filter((item) => item.stage === "trade_normalization").length, 1);
  assert.equal(processedWorkerJob.artifacts.filter((item) => item.stage === "buyer_matching").length, 1);
  const buyerArtifactReference = processedWorkerJob.artifacts.find((item) => item.stage === "buyer_matching").reference;
  const buyerArtifact = JSON.parse(await fs.readFile(fileURLToPath(buyerArtifactReference), "utf8"));
  assert.equal(buyerArtifact.buyers.length, 2);
  assert.equal(buyerArtifact.buyers.find((item) => item.company === "Example Freight LLC").entityType, "logistics_or_intermediary");
  assert.equal(buyerArtifact.buyers.find((item) => item.company === "Example Freight LLC").retained, true);
  const taskAction = await request(`/api/ops/tasks/${task.body.id}/actions`, {
    method: "POST",
    body: JSON.stringify({ type: "company_detail", count: 1, signal: "none", idempotencyKey: "smoke:item-1:company_detail", checkpoint: { company: "Example Buyer", page: 1 } }),
  });
  assert.equal(taskAction.body.counters.companyDetails, 1);
  const duplicateTaskAction = await request(`/api/ops/tasks/${task.body.id}/actions`, {
    method: "POST",
    body: JSON.stringify({ type: "company_detail", count: 1, signal: "none", idempotencyKey: "smoke:item-1:company_detail" }),
  });
  assert.equal(duplicateTaskAction.body.counters.companyDetails, 1);
  const budgetBlocked = await request(`/api/ops/tasks/${task.body.id}/actions`, {
    method: "POST",
    body: JSON.stringify({ type: "company_detail", count: 1, signal: "none" }),
  });
  assert.equal(budgetBlocked.response.status, 429);
  const budgetAudit = await request(`/api/ops/tasks/${task.body.id}`);
  assert.equal(budgetAudit.body.audit[0].type, "budget_rejected");
  assert.equal(budgetAudit.body.audit[0].requestedAction, "company_detail");
  assert.equal(budgetAudit.body.audit[0].requestedCount, 1);
  assert.equal(budgetAudit.body.audit[0].budget, 1);
  const safetySignal = await request(`/api/ops/tasks/${task.body.id}/actions`, {
    method: "POST",
    body: JSON.stringify({ type: "checkpoint", count: 1, signal: "http_429" }),
  });
  assert.equal(safetySignal.body.safetyState, "CIRCUIT_OPEN");
  const recover = await request(`/api/ops/tasks/${task.body.id}/recover`, {
    method: "POST",
    body: JSON.stringify({ confirm: `RECOVER ${task.body.id}` }),
  });
  assert.equal(recover.body.safetyState, "HUMAN_RECOVERY");

  const collectionInit = await request("/api/contact-queues/initialize", {
    method: "POST",
    body: JSON.stringify({
      key: "smoke-buyers",
      label: "Smoke buyer contacts",
      sources: [{
        sourceId: "smoke",
        path: path.relative(path.resolve(appDir, ".."), contactCollectionSourcePath),
      }],
      processedResultPaths: [],
      processedNames: ["Alpha Books"],
      config: { batchSize: 2, minDelayMs: 2000, maxDelayMs: 4000, leaseSeconds: 60, maxAttempts: 2 },
    }),
  });
  assert.equal(collectionInit.response.status, 201);
  assert.equal(collectionInit.body.counts.total, 3);
  assert.equal(collectionInit.body.counts.completed, 1);
  assert.equal(collectionInit.body.counts.pending, 2);
  const collectionClaim = await request(`/api/contact-queues/${collectionInit.body.id}/claim`, {
    method: "POST",
    body: JSON.stringify({ owner: "smoke-desktop" }),
  });
  assert.equal(collectionClaim.response.status, 200);
  assert.equal(collectionClaim.body.batch.items.length, 2);
  const collectionComplete = await request(`/api/contact-queues/${collectionInit.body.id}/batches/${collectionClaim.body.batch.id}/complete`, {
    method: "POST",
    body: JSON.stringify({
      owner: "smoke-desktop",
      rawResults: [
        { query: collectionClaim.body.batch.items[0].companyName, status: "ok", contacts: [{ cells: ["", "Buyer", "buyer@example.test"] }] },
        { query: collectionClaim.body.batch.items[1].companyName, status: "no_result", contacts: [] },
      ],
    }),
  });
  assert.equal(collectionComplete.response.status, 200);
  assert.equal(collectionComplete.body.queue.status, "completed");
  assert.equal(collectionComplete.body.queue.counts.contactRows, 1);
  assert.match(collectionComplete.body.artifactReference, /^app\/tests\/\.contact-collection-artifacts-/);
  const collectionReport = await request(`/api/contact-queues/${collectionInit.body.id}/boundary-report`);
  assert.equal(collectionReport.response.status, 200);
  assert.equal(collectionReport.body.implementation.concurrency, 1);
  assert.ok(collectionReport.body.stopRules.immediate.includes("http_429"));

  const created = await request("/api/campaigns", {
    method: "POST",
    body: JSON.stringify({
      name: "Smoke test",
      subject: "Hello {{company}}",
      body: validCampaignBody,
      brief: validBrief,
      filters: { countries: [], priorities: [], includeLowConfidence: false },
      compliance: {},
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.status, "draft");
  assert.ok(created.body.estimatedRecipients > 0);

  const backup = await request("/api/local-backup");
  assert.equal(backup.response.status, 200);
  assert.equal(backup.body.scope, "local_control_state_only");
  assert.equal(backup.body.integrity.algorithm, "sha256");
  assert.equal(backup.body.integrity.digest.length, 64);
  assert.equal(backup.body.stores.campaigns.length, 1);
  assert.ok(backup.body.stores.contactValidation.records.every((item) => item.email === undefined));
  assert.ok(backup.body.stores.suppressions.records.every((item) => item.email === undefined));

  const backupValidation = await request("/api/local-backup/validate", {
    method: "POST",
    body: JSON.stringify(backup.body),
  });
  assert.equal(backupValidation.response.status, 200);
  assert.equal(backupValidation.body.valid, true);
  assert.equal(backupValidation.body.counts.operationTasks, 1);

  const tamperedBackup = structuredClone(backup.body);
  tamperedBackup.stores.operations.version = 999;
  const tamperedValidation = await request("/api/local-backup/validate", {
    method: "POST",
    body: JSON.stringify(tamperedBackup),
  });
  assert.equal(tamperedValidation.response.status, 422);
  assert.equal(tamperedValidation.body.valid, false);
  assert.ok(tamperedValidation.body.errors.includes("备份完整性摘要不匹配"));

  const secondTask = await request("/api/ops/tasks", {
    method: "POST",
    body: JSON.stringify({
      hsCode: "4903001",
      direction: "buyer",
      countries: ["Canada"],
      budgets: { buyerEntriesDaily: 100, companyDetailsDaily: 5, contactPagesDaily: 25, emailSendsDaily: 20 },
      automation: { mode: "managed", confirm: "AUTHORIZE MANAGED 4903001", authorizedBy: "smoke-owner" },
    }),
  });
  assert.equal(secondTask.response.status, 201);
  assert.equal(secondTask.body.automation.mode, "managed");
  assert.equal(secondTask.body.automation.authorizedBy, "smoke-owner");
  assert.equal(secondTask.body.counters.qualifiedCompanies, 0);
  const synchronizedTask = await request(`/api/ops/tasks/${secondTask.body.id}`, {
    method: "PUT",
    body: JSON.stringify({ budgets: { companyDetailsDaily: 40, contactPagesDaily: 200, emailSendsDaily: 200 }, confirm: "AUTHORIZE MANAGED 4903001" }),
  });
  assert.equal(synchronizedTask.body.budgets.companyDetailsDaily, 100);
  assert.equal(synchronizedTask.body.budgets.emailSendsDaily, 200);
  const managedBeyondLegacyBudget = await request(`/api/ops/tasks/${secondTask.body.id}/actions`, {
    method: "POST",
    body: JSON.stringify({ type: "buyer_entry", count: 500, signal: "none", idempotencyKey: "smoke:managed-buyers-1" }),
  });
  assert.equal(managedBeyondLegacyBudget.response.status, 200);
  assert.equal(managedBeyondLegacyBudget.body.counters.buyerEntries, 500);
  const managedCircuit = await request(`/api/ops/tasks/${secondTask.body.id}/actions`, {
    method: "POST",
    body: JSON.stringify({ type: "checkpoint", count: 1, signal: "http_429" }),
  });
  assert.equal(managedCircuit.body.safetyState, "CIRCUIT_OPEN");
  const managedRecovery = await request(`/api/ops/tasks/${secondTask.body.id}/recover`, {
    method: "POST",
    body: JSON.stringify({ verification: "netease_business_page_ready" }),
  });
  assert.equal(managedRecovery.body.safetyState, "RUNNING");
  assert.equal(managedRecovery.body.status, "active");
  assert.equal(managedRecovery.body.budgets.companyDetailsDaily, 100);
  const qualifiedCompanyAction = await request(`/api/ops/tasks/${secondTask.body.id}/actions`, {
    method: "POST",
    body: JSON.stringify({ type: "qualified_company", count: 1, signal: "none", idempotencyKey: "smoke:qualified-company-1" }),
  });
  assert.equal(qualifiedCompanyAction.body.counters.qualifiedCompanies, 1);
  const attachedPipeline = await request("/api/pipeline/jobs", {
    method: "POST",
    body: JSON.stringify({ operationTaskId: secondTask.body.id }),
  });
  assert.equal(attachedPipeline.response.status, 201);
  assert.equal(attachedPipeline.body.operationTaskId, secondTask.body.id);
  assert.equal(attachedPipeline.body.automation.mode, "managed");
  const mergePreview = await request("/api/local-backup/preview", {
    method: "POST",
    body: JSON.stringify(backup.body),
  });
  assert.equal(mergePreview.response.status, 200);
  assert.equal(mergePreview.body.current.operationTasks, 2);
  assert.equal(mergePreview.body.incoming.operationTasks, 1);
  assert.equal(mergePreview.body.effective.operationTasks, 2);
  assert.match(mergePreview.body.confirmation, /^MERGE [A-F0-9]{12}$/);
  const rejectedMerge = await request("/api/local-backup/merge", {
    method: "POST",
    body: JSON.stringify({ backup: backup.body, confirm: "MERGE WRONG" }),
  });
  assert.equal(rejectedMerge.response.status, 409);
  const mergedBackup = await request("/api/local-backup/merge", {
    method: "POST",
    body: JSON.stringify({ backup: backup.body, confirm: mergePreview.body.confirmation }),
  });
  assert.equal(mergedBackup.response.status, 200);
  assert.equal(mergedBackup.body.mode, "current_wins_add_only");
  assert.equal(mergedBackup.body.counts.operationTasks, 2);
  assert.match(mergedBackup.body.rollbackFile, /^rollback-.*\.json$/);
  const tasksAfterMerge = await request("/api/ops/tasks");
  assert.equal(tasksAfterMerge.body.items.length, 2);
  assert.ok(tasksAfterMerge.body.items.some((item) => item.id === secondTask.body.id));

  const preview = await request(`/api/campaigns/${created.body.id}/preview`, { method: "POST", body: "{}" });
  assert.equal(preview.response.status, 200);
  assert.ok(preview.body.items.length > 0);
  assert.match(preview.body.warning, /不会发送|unverified/);

  const review = await request(`/api/campaigns/${created.body.id}/submit-review`, { method: "POST", body: "{}" });
  assert.equal(review.response.status, 200);
  assert.equal(review.body.status, "review");

  const schedule = await request(`/api/campaigns/${created.body.id}/simulate-schedule`, { method: "POST", body: "{}" });
  assert.equal(schedule.response.status, 200);
  assert.equal(schedule.body.status, "simulated_scheduled");
  assert.equal(schedule.body.sendingLocked, true);

  const edited = await request(`/api/campaigns/${created.body.id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: "Smoke test edited",
      subject: "Updated {{company}}",
      body: validCampaignBody,
      brief: validBrief,
      filters: { countries: [], priorities: [], includeLowConfidence: false },
      compliance: {},
    }),
  });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.body.status, "draft");
  assert.equal(edited.body.scheduleAt, null);
  assert.equal(edited.body.recipientSnapshot, null);

  const send = await request("/api/send", { method: "POST", body: "{}" });
  assert.equal(send.response.status, 423);
  assert.equal(send.body.sendingEnabled, false);

  const smtpCampaign = await request("/api/campaigns", {
    method: "POST",
    body: JSON.stringify({
      name: "SMTP smoke test",
      subject: "Hello {{company}}",
      body: validCampaignBody,
      brief: validBrief,
      filters: { countries: ["Mexico"], priorities: ["A-采购/运营"], includeLowConfidence: false },
      compliance: {
        senderDomainVerified: true,
        unsubscribeConfigured: true,
        physicalAddressConfigured: true,
        suppressionListChecked: true,
      },
    }),
  });
  const smtpReview = await request(`/api/campaigns/${smtpCampaign.body.id}/submit-review`, { method: "POST", body: "{}" });
  assert.equal(smtpReview.response.status, 200);
  const rejectedApprove = await request(`/api/campaigns/${smtpCampaign.body.id}/approve`, {
    method: "POST",
    body: JSON.stringify({ confirm: "APPROVE" }),
  });
  assert.equal(rejectedApprove.response.status, 428);
  const blockedReviewSend = await request(`/api/campaigns/${smtpCampaign.body.id}/send`, {
    method: "POST",
    body: JSON.stringify({ confirm: `SEND ${smtpCampaign.body.id}` }),
  });
  assert.equal(blockedReviewSend.response.status, 423);
  const approval = await request(`/api/campaigns/${smtpCampaign.body.id}/approve`, {
    method: "POST",
    body: JSON.stringify({ confirm: `APPROVE ${smtpCampaign.body.id}`, reviewer: "smoke-test" }),
  });
  assert.equal(approval.response.status, 200);
  assert.equal(approval.body.status, "approved");
  const restrictedProfile = await request("/api/sender-profile", {
    method: "PUT",
    body: JSON.stringify({ senderEmail: "sender@restricted.test" }),
  });
  assert.equal(restrictedProfile.response.status, 200);
  const policyBlockedSend = await request(`/api/campaigns/${smtpCampaign.body.id}/send`, {
    method: "POST",
    body: JSON.stringify({ confirm: `SEND ${smtpCampaign.body.id}` }),
  });
  assert.equal(policyBlockedSend.response.status, 423);
  assert.ok(policyBlockedSend.body.details.includes("当前发件域名只允许正常商务通信，不允许营销或开发信"));
  const allowedProfile = await request("/api/sender-profile", {
    method: "PUT",
    body: JSON.stringify({ senderEmail: "sender@example.test" }),
  });
  assert.equal(allowedProfile.response.status, 200);
  const rejectedSend = await request(`/api/campaigns/${smtpCampaign.body.id}/send`, {
    method: "POST",
    body: JSON.stringify({ confirm: "SEND" }),
  });
  assert.equal(rejectedSend.response.status, 428);
  const concurrentSends = await Promise.all([
    request(`/api/campaigns/${smtpCampaign.body.id}/send`, {
      method: "POST",
      body: JSON.stringify({ confirm: `SEND ${smtpCampaign.body.id}` }),
    }),
    request(`/api/campaigns/${smtpCampaign.body.id}/send`, {
      method: "POST",
      body: JSON.stringify({ confirm: `SEND ${smtpCampaign.body.id}` }),
    }),
  ]);
  const smtpSend = concurrentSends.find((result) => result.response.status === 200);
  const duplicateSend = concurrentSends.find((result) => result.response.status === 409);
  assert.ok(smtpSend);
  assert.ok(duplicateSend);
  assert.match(duplicateSend.body.error, /重复请求|执行中/);
  assert.equal(smtpSend.response.status, 200);
  assert.ok(smtpSend.body.batch.sent >= 1 && smtpSend.body.batch.sent <= 2);
  assert.equal(smtpSend.body.batch.failed, 0);
  assert.equal(smtpMessages.length, smtpSend.body.batch.sent + 1);
  assert.doesNotMatch(smtpMessages[0], /https:\/\/example\.test\/unsubscribe/);
  assert.match(smtpMessages[0], /Reply-To: (?:maggie1|reply)@example\.test/);
  assert.match(smtpMessages[0], /List-Unsubscribe: <mailto:unsubscribe@example\.test\?subject=unsubscribe>/);
  const outbox = await request("/api/outbox");
  assert.equal(outbox.body.counts.accepted, smtpSend.body.batch.sent + 1);
  assert.equal(outbox.body.counts.uncertain, 0);
  assert.ok(outbox.body.items.every((item) => item.recipientFingerprint.length === 12));
  const rawOutbox = JSON.parse(await fs.readFile(outboxPath, "utf8"));
  const matchedFeedback = await request("/api/feedback/events", {
    method: "POST",
    headers: { "x-feedback-secret": "test-feedback-secret", "x-feedback-source": "smtp-adapter" },
    body: JSON.stringify({
      eventId: "evt-outbox-match",
      type: "soft_bounce",
      recipientHash: rawOutbox.entries[0].recipientHash,
      messageId: rawOutbox.entries[0].messageId,
    }),
  });
  assert.equal(matchedFeedback.response.status, 202);
  assert.equal(matchedFeedback.body.outboxMatched, true);
  assert.equal(matchedFeedback.body.suppressed, false);
  const matchedOutboxAfterFeedback = JSON.parse(await fs.readFile(outboxPath, "utf8"));
  assert.ok(matchedOutboxAfterFeedback.entries[0].events.some((item) => item.type === "feedback_soft_bounce"));

  const duplicateCampaign = await request("/api/campaigns", {
    method: "POST",
    body: JSON.stringify({
      name: "Cross-campaign duplicate guard",
      subject: "Hello again {{company}}",
      body: validCampaignBody,
      brief: validBrief,
      filters: { countries: ["Mexico"], priorities: ["A-采购/运营"], includeLowConfidence: false },
      compliance: {},
    }),
  });
  assert.equal(duplicateCampaign.body.sendableRecipients, 0);
  assert.ok(duplicateCampaign.body.sendBlockers.includes("没有通过发送门槛的收件人"));

  const imageCampaign = await request("/api/campaigns", {
    method: "POST",
    body: JSON.stringify({
      name: "Inline image smoke test",
      subject: "Children's book printing for {{company}}",
      body: validCampaignBody,
      brief: validBrief,
      approvedClaims: ["portfolio_images"],
      assetIds: ["children_books"],
      assetRightsConfirmed: true,
      filters: { countries: ["United States"], priorities: ["B-管理层"], includeLowConfidence: false },
      compliance: {
        senderDomainVerified: true,
        unsubscribeConfigured: true,
        physicalAddressConfigured: true,
        suppressionListChecked: true,
      },
    }),
  });
  const imagePreview = await request(`/api/campaigns/${imageCampaign.body.id}/preview`, { method: "POST", body: "{}" });
  assert.equal(imagePreview.body.assets.length, 1);
  assert.deepEqual(imagePreview.body.contentErrors, []);
  await request(`/api/campaigns/${imageCampaign.body.id}/submit-review`, { method: "POST", body: "{}" });
  const imageApproval = await request(`/api/campaigns/${imageCampaign.body.id}/approve`, {
    method: "POST",
    body: JSON.stringify({ confirm: `APPROVE ${imageCampaign.body.id}`, reviewer: "smoke-test" }),
  });
  assert.equal(imageApproval.response.status, 200);
  const imageSend = await request(`/api/campaigns/${imageCampaign.body.id}/send`, {
    method: "POST",
    body: JSON.stringify({ confirm: `SEND ${imageCampaign.body.id}` }),
  });
  assert.ok(imageSend.body.batch.sent >= 1);
  const imageMessage = smtpMessages.at(-1);
  const interventionAlert = await request("/api/ops/intervention-alert", {
    method: "POST",
    body: JSON.stringify({ code: "smoke_manual_gate", title: "Smoke manual gate", details: "CAPTCHA", instructions: "Complete the visible check." }),
  });
  assert.equal(interventionAlert.response.status, 200);
  assert.equal(interventionAlert.body.status, "accepted");
  assert.equal(interventionAlert.body.daily.used, 5);
  const duplicateAlert = await request("/api/ops/intervention-alert", {
    method: "POST",
    body: JSON.stringify({ code: "smoke_manual_gate", title: "Smoke manual gate", instructions: "Complete the visible check." }),
  });
  assert.equal(duplicateAlert.response.status, 200);
  assert.equal(duplicateAlert.body.duplicate, true);
  const dailyLimitReached = await request("/api/health");
  assert.equal(dailyLimitReached.body.delivery.daily.used, 5);
  assert.equal(dailyLimitReached.body.delivery.daily.remaining, 0);
  assert.match(imageMessage, /Content-Type: multipart\/related/);
  assert.match(imageMessage, /Content-ID: <dakings_asset_1>/);

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /DaKings Prospect Ops/);

  const replacementTask = await request("/api/ops/tasks", {
    method: "POST",
    body: JSON.stringify({
      hsCode: "4903002",
      direction: "buyer",
      countries: [],
      automation: { mode: "managed", confirm: "AUTHORIZE MANAGED 4903002", authorizedBy: "overview-plan-owner" },
    }),
  });
  assert.equal(replacementTask.response.status, 201);
  const replacedTask = await request(`/api/ops/tasks/${secondTask.body.id}`);
  assert.equal(replacedTask.body.status, "cancelled");
  const pipelineAfterReplacement = await request("/api/pipeline");
  assert.equal(pipelineAfterReplacement.body.jobs.find((item) => item.id === attachedPipeline.body.id).status, "paused");

  console.log(JSON.stringify({ ok: true, buyerCount: summary.body.buyerCount, uniqueContacts: summary.body.uniqueContacts, campaignFlow: "draft -> review -> simulated_scheduled", smtpDeliverySmoke: "confirmed batch" }, null, 2));
} finally {
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => mockOpenAi.close(resolve));
  await new Promise((resolve) => mockSmtp.close(resolve));
  await fs.rm(campaignPath, { force: true });
  await fs.rm(validationPath, { force: true });
  await fs.rm(suppressionPath, { force: true });
  await fs.rm(operationsPath, { force: true });
  await fs.rm(contactCollectionPath, { force: true });
  await fs.rm(contactCollectionSourcePath, { force: true });
  await fs.rm(contactCollectionArtifactDir, { recursive: true, force: true });
  await fs.rm(pipelinePath, { force: true });
  await fs.rm(pipelineArtifactDir, { recursive: true, force: true });
  await fs.rm(outboxPath, { force: true });
  await fs.rm(runtimeStatePath, { force: true });
  await fs.rm(senderProfilePath, { force: true });
  await fs.rm(senderAccountsPath, { force: true });
  await fs.rm(mailboxAccountsPath, { force: true });
  await fs.rm(mailboxStorePath, { force: true });
  await fs.rm(mailboxReplyPath, { force: true });
  await fs.rm(hmacSecretPath, { force: true });
  await fs.rm(workerInputPath, { force: true });
  await fs.rm(workerArtifactDir, { recursive: true, force: true });
  await fs.rm(localBackupDir, { recursive: true, force: true });
}
