const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLACEHOLDER_PATTERN = /\{\{[^}]+\}\}|\$\{[^}]+\}|\[(?:placeholder|待填写[^\]]*)\]|\b(?:TODO|TBD)\b/i;

function text(value, max = 1000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeHsCode(value) {
  return text(value, 20).replace(/\D/g, "");
}

function result(draftIndex, hardFails = [], softWarnings = []) {
  return {
    draftIndex,
    approved: hardFails.length === 0,
    hardFails: [...new Set(hardFails)],
    softWarnings: [...new Set(softWarnings)],
  };
}

/** Pure, PII-free approval decision for a pipeline drafting artifact. */
export function evaluateAutoApproval(job, artifact) {
  const hardFails = [];
  const softWarnings = [];
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)
    || artifact.schemaVersion !== 1 || artifact.kind !== "pipeline-email-drafts"
    || !Array.isArray(artifact.drafts)) {
    return { decision: "rejected", draftIndexes: [], hardFails: ["SCHEMA_ERROR"], softWarnings: [], drafts: [] };
  }
  const jobHs = normalizeHsCode(job?.hsCode);
  const artifactHs = normalizeHsCode(artifact.hsCode);
  if (!jobHs || !artifactHs || jobHs !== artifactHs || !text(artifact.productFocus, 500)) hardFails.push("PRODUCT_MISMATCH");
  if (!artifact.drafts.length) hardFails.push("SCHEMA_ERROR");

  const drafts = artifact.drafts.map((draft, index) => {
    const fails = [];
    const warnings = [];
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
      fails.push("SCHEMA_ERROR");
      return result(index, fails, warnings);
    }
    if (!EMAIL_PATTERN.test(text(draft.email, 320))) fails.push("MISSING_RECIPIENT");
    if (!text(draft.company, 300)) fails.push("MISSING_COMPANY");
    if (!text(draft.subject, 500) || !text(draft.body, 12000)) fails.push("EMPTY_SUBJECT_OR_BODY");
    if (PLACEHOLDER_PATTERN.test(`${draft.subject || ""}\n${draft.body || ""}`)) fails.push("PLACEHOLDER_LEAK");
    if (!text(draft.contactRole, 200)) warnings.push("MISSING_ROLE");
    if (!Array.isArray(draft.evidenceSources) || draft.evidenceSources.length < 2) warnings.push("INCOMPLETE_EVIDENCE");
    if (!text(draft.companySize, 80)) warnings.push("UNKNOWN_COMPANY_SIZE");
    return result(index, fails, warnings);
  });
  for (const item of drafts) {
    hardFails.push(...item.hardFails);
    softWarnings.push(...item.softWarnings);
  }
  const approved = hardFails.length === 0;
  return {
    decision: approved ? "approved" : "rejected",
    draftIndexes: approved ? drafts.map((item) => item.draftIndex) : [],
    hardFails: [...new Set(hardFails)],
    softWarnings: [...new Set(softWarnings)],
    drafts,
  };
}
