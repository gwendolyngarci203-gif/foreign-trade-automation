import assert from "node:assert/strict";
import fs from "node:fs";
import { buildApprovalAdapterResult } from "../services/approval-adapter.mjs";

const server = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(server, /auto-approve/);
assert.match(server, /buildApprovalAdapterResult/);
assert.doesNotMatch(server.slice(server.indexOf("if (action === \"auto-approve\")"), server.indexOf("} else if (action === \"approve\")")), /prepareOutboxEntry|sendSmtpMessage|transitionOutbox/);
const job = { id: "pipe_integration", hsCode: "4903000", currentStage: "approval", status: "waiting_input" };
const artifact = { schemaVersion: 1, kind: "pipeline-email-drafts", hsCode: "4903000", productFocus: "books", drafts: [{ company: "Example", contactRole: "Buyer", email: "a@example.com", subject: "Hello", body: "Body", evidenceSources: ["https://a.example", "https://b.example"], companySize: "small" }] };
const result = buildApprovalAdapterResult({ job, artifact, context: { traceId: "trace_integration" } });
assert.equal(result.decision.decision, "approved");
assert.equal(result.transitionRequest.nextStage, "sending");
assert.equal(result.transitionRequest.requiresExplicitSend, true);
console.log("approval adapter integration unit passed");
