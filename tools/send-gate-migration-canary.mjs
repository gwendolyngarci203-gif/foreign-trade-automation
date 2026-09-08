import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pipelinePath = path.join(root, "deploy", "runtime-data", "pipeline.json");
const targetId = process.argv[2] || "pipe_2bd8c12f-d31f-419b-927f-b5fbcfe0531d";
const normalize = (value) => String(value || "").trim().toLowerCase();
const stableId = (...parts) => crypto.createHash("sha1").update(parts.map((part) => String(part || "")).join("|")).digest("hex").slice(0, 16);
const emailFingerprint = (value) => crypto.createHash("sha256").update(normalize(value)).digest("hex");
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalize(value));
const sourceUrl = (value) => /^https?:\/\/[^\s]+$/i.test(String(value || ""));

const pipeline = JSON.parse(await fs.readFile(pipelinePath, "utf8"));
const job = (pipeline.jobs || []).find((item) => item.id === targetId);
if (!job) throw new Error(`job not found: ${targetId}`);
const draftRef = [...(job.artifacts || [])].reverse().find((item) => item.stage === "drafting")?.reference;
if (!draftRef?.startsWith("file://")) throw new Error("draft artifact reference unavailable");
const draftArtifact = JSON.parse(await fs.readFile(new URL(draftRef), "utf8"));
const draft = draftArtifact.drafts?.[job.approval?.draftIndexes?.[0] ?? 0];
if (!draft) throw new Error("approved draft unavailable");
let contact = null;
for (const ref of [...(job.artifacts || [])].reverse().filter((item) => item.stage === "contact_enrichment")) {
  try {
    const artifact = JSON.parse(await fs.readFile(new URL(ref.reference), "utf8"));
    contact = [...(artifact.people || []), ...(artifact.companyContacts || [])].find((item) => normalize(item.email) === normalize(draft.email));
    if (contact) break;
  } catch { /* continue to the next artifact */ }
}
const companySource = String(contact?.source || contact?.website || "").trim();
const contactSources = (Array.isArray(contact?.evidenceSources) ? contact.evidenceSources : Array.isArray(draft.evidenceSources) ? draft.evidenceSources : []).filter(sourceUrl);
const oldHardFails = [];
if (!validEmail(draft.email)) oldHardFails.push("missing_recipient");
if (!String(draft.company || "").trim()) oldHardFails.push("missing_company");
if (!String(draft.subject || "").trim() || !String(draft.body || "").trim()) oldHardFails.push("empty_subject_body");
if (job.approval?.recipientEvidence?.length !== 1 || !(job.approval.recipientEvidence || [])[0]?.deliverableConfirmed || !(job.approval.recipientEvidence || [])[0]?.currentEmploymentConfirmed) oldHardFails.push("strict_recipient_evidence");
const newHardFails = [];
if (!validEmail(draft.email)) newHardFails.push("EMAIL_INVALID");
if (!String(draft.company || "").trim()) newHardFails.push("COMPANY_MISSING");
if (!companySource) newHardFails.push("COMPANY_SOURCE_MISSING");
if (!contactSources.length) newHardFails.push("CONTACT_SOURCE_MISSING");
if (!String(draftArtifact.productFocus || "").trim() || !String(draftArtifact.hsCode || job.hsCode || "").trim()) newHardFails.push("PRODUCT_RELEVANCE_FAIL");
const evidenceLevel = companySource && contactSources.length ? "A" : (companySource || contactSources.length ? "B" : "C");
const warnings = [];
if (draft.deliverableConfirmed !== true) warnings.push("DELIVERABLE_UNCONFIRMED");
if (draft.currentEmploymentConfirmed !== true) warnings.push("EMPLOYMENT_UNCONFIRMED");
if (!String(draft.contactRole || draft.role || draft.title || "").trim()) warnings.push("ROLE_MISSING");
if (!String(draft.companySize || "").trim()) warnings.push("COMPANY_SIZE_UNKNOWN");
if (contactSources.length < 2) warnings.push("LOW_EVIDENCE_COUNT");
const result = {
  targetId,
  oldRule: { decision: oldHardFails.length ? "rejected" : "approved", hardFails: oldHardFails },
  newRule: { decision: newHardFails.length ? "rejected" : "approved", hardFails: newHardFails, evidenceLevel, warnings },
  recipient: { present: validEmail(draft.email), fingerprint: emailFingerprint(draft.email).slice(0, 12) },
  idempotencyKey: stableId("outbox", targetId, normalize(draft.email)),
  artifact: { reference: draftRef, schemaVersion: draftArtifact.schemaVersion, kind: draftArtifact.kind, productContext: Boolean(String(draftArtifact.productFocus || "").trim()) },
  sideEffects: { outboxCreated: false, smtp: false, send: false },
};
console.log(JSON.stringify(result, null, 2));
