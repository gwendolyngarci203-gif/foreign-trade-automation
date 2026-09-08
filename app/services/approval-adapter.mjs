import { evaluateAutoApproval } from "../auto-approval.mjs";
import { createEventEnvelope, inheritEventEnvelope } from "../observability.mjs";

function text(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

/** Pure adapter: decision result to an approval transition command. */
export function buildApprovalAdapterResult({ job, artifact, context = {} } = {}) {
  if (!job || typeof job !== "object" || !text(job.id, 200)) {
    throw new TypeError("job.id is required");
  }
  const decision = evaluateAutoApproval(job, artifact);
  const parent = context.traceId
    ? { id: job.id, observability: createEventEnvelope({
      classification: context.classification || "production",
      origin: context.origin || "approval_route",
      runType: context.runType || "production",
      createdBy: context.createdBy || "approval-adapter",
      traceId: context.traceId,
      createdAt: context.createdAt,
    }) }
    : job;
  const observability = inheritEventEnvelope(parent, { origin: "approval_event", createdBy: "approval-adapter" });
  const audit = {
    type: decision.decision === "approved" ? "pipeline_auto_approved" : "pipeline_auto_approval_rejected",
    jobId: text(job.id),
    draftIndexes: decision.draftIndexes,
    hardFailCount: decision.hardFails.length,
    softWarningCount: decision.softWarnings.length,
    observability,
  };
  return {
    decision: {
      decision: decision.decision,
      draftIndexes: decision.draftIndexes,
      hardFails: decision.hardFails,
      softWarnings: decision.softWarnings,
      drafts: decision.drafts,
    },
    audit,
    transitionRequest: decision.decision === "approved"
      ? { action: "complete_approval", jobId: text(job.id), nextStage: "sending", nextStatus: "waiting_input", requiresExplicitSend: true }
      : { action: "record_approval_rejection", jobId: text(job.id), nextStage: "approval", nextStatus: "waiting_input", requiresExplicitSend: true },
  };
}
