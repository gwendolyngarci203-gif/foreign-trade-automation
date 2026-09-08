const CLASSIFICATIONS = new Set(["production", "canary", "test", "recovery", "system"]);
const PRODUCTION_RUN_TYPES = new Set(["production"]);
const NON_BILLABLE_CLASSIFICATIONS = new Set(["canary", "test", "recovery", "system"]);

export const OBSERVABILITY_SCHEMA_VERSION = 1;
export const OBSERVABILITY_CLASSIFICATIONS = Object.freeze([...CLASSIFICATIONS]);

function text(value) {
  return String(value ?? "").trim();
}

function validIso(value) {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}

export function createEventEnvelope(input = {}) {
  const classification = text(input.classification) || "system";
  const runType = text(input.runType) || classification;
  const billable = classification === "production" && PRODUCTION_RUN_TYPES.has(runType);
  return {
    classification,
    origin: text(input.origin) || "unknown",
    runType,
    isBillableProduction: classification === "production" ? Boolean(input.isBillableProduction ?? billable) : false,
    createdBy: text(input.createdBy) || "system",
    traceId: text(input.traceId),
    createdAt: text(input.createdAt) || new Date().toISOString(),
    schemaVersion: Number(input.schemaVersion || OBSERVABILITY_SCHEMA_VERSION),
  };
}

export function inheritEventEnvelope(parent = {}, input = {}) {
  const parentEnvelope = parent.observability || parent;
  return createEventEnvelope({
    ...parentEnvelope,
    ...input,
    classification: input.classification || parentEnvelope.classification || "production",
    runType: input.runType || parentEnvelope.runType || "production",
    traceId: input.traceId || parentEnvelope.traceId || `trace_${text(parent.id || parent.eventId || "unknown")}`,
    createdBy: input.createdBy || parentEnvelope.createdBy || "system",
  });
}

export function validateEventEnvelope(event = {}) {
  const errors = [];
  if (!CLASSIFICATIONS.has(event.classification)) errors.push("classification_invalid");
  if (!text(event.origin)) errors.push("origin_missing");
  if (!text(event.runType)) errors.push("runType_missing");
  if (!text(event.createdBy)) errors.push("createdBy_missing");
  if (!text(event.traceId)) errors.push("traceId_missing");
  if (!validIso(event.createdAt)) errors.push("createdAt_invalid");
  if (Number(event.schemaVersion) !== OBSERVABILITY_SCHEMA_VERSION) errors.push("schemaVersion_invalid");
  const expectedBillable = event.classification === "production" && PRODUCTION_RUN_TYPES.has(event.runType);
  if (Boolean(event.isBillableProduction) !== expectedBillable) errors.push("isBillableProduction_invalid");
  return { valid: errors.length === 0, errors };
}

function knownLegacyClassification(entity = {}, kind = "") {
  const raw = JSON.stringify(entity).toLowerCase();
  if (raw.includes("system_alert_canary") || raw.includes("intervention_alert")) return { classification: "system", rule: "legacy_system_alert_kind_v1", confidence: "high" };
  if (raw.includes("sandbox") || raw.includes("test") || raw.includes("phase12")) return { classification: "canary", rule: "legacy_canary_marker_v1", confidence: "high" };
  if (kind === "feedback" && /(reply|bounce|complaint|unsubscribe)/.test(raw)) return { classification: "production", rule: "legacy_feedback_default_v1", confidence: "low" };
  return { classification: "unknown_legacy", rule: "legacy_unclassified_v1", confidence: "low" };
}

export function legacyClassificationView(entity, kind = "event") {
  if (entity?.classification && CLASSIFICATIONS.has(entity.classification)) {
    return { classification: entity.classification, rule: "native_envelope_v1", confidence: "high", readOnly: true };
  }
  const mapped = knownLegacyClassification(entity, kind);
  return { ...mapped, readOnly: true };
}

function isSameDay(value, businessDate, businessDateFor) {
  return value && businessDateFor(new Date(value)) === businessDate;
}

function metricBucket() {
  return { draft: 0, approved: 0, outbox: 0, sent: 0, failed: 0, canary: 0, sandbox: 0, testQuota: 0, retry: 0, recovered: 0, intervention: 0 };
}

export function buildClassifiedMetrics({ jobs = [], outboxEntries = [], feedbackEvents = [], businessDate, businessDateFor = (date) => date.toISOString().slice(0, 10) } = {}) {
  const production = metricBucket();
  const canaryTest = metricBucket();
  const recovery = metricBucket();
  const legacyMappings = [];
  const addMapping = (entity, kind) => {
    const view = legacyClassificationView(entity, kind);
    if (!entity?.classification) legacyMappings.push({ rawEventId: entity?.id || entity?.eventId || null, ...view });
    return view.classification;
  };
  for (const job of jobs) {
    const classification = addMapping(job, "job");
    const bucket = classification === "production" ? production : canaryTest;
    for (const artifact of job.artifacts || []) {
      if (artifact.stage === "drafting" && isSameDay(artifact.at, businessDate, businessDateFor)) bucket.draft += Math.max(0, Number(artifact.counts?.draftedContacts || 0));
    }
    for (const event of job.audit || []) {
      const type = String(event.type || "");
      if (!isSameDay(event.at, businessDate, businessDateFor)) continue;
      if (type === "pipeline_auto_approved") bucket.approved += Math.max(1, Number(event.draftIndexes?.length || 0));
      if (/retry|requeued/.test(type)) recovery.retry += 1;
      if (/recovered/.test(type)) recovery.recovered += 1;
    }
  }
  for (const entry of outboxEntries) {
    const classification = addMapping(entry, "outbox");
    const bucket = classification === "production" ? production : canaryTest;
    if (!isSameDay(entry.createdAt, businessDate, businessDateFor)) continue;
    bucket.outbox += 1;
    if (classification === "canary") bucket.canary += 1;
    if (classification === "test") bucket.sandbox += 1;
    for (const event of entry.events || []) {
      if (!isSameDay(event.at, businessDate, businessDateFor)) continue;
      if (event.status === "accepted") bucket.sent += 1;
      if (event.status === "failed") bucket.failed += 1;
      if (/retry|requeued/.test(String(event.type || ""))) recovery.retry += 1;
    }
  }
  for (const event of feedbackEvents) {
    const classification = addMapping(event, "feedback");
    if (!isSameDay(event.createdAt || event.at, businessDate, businessDateFor)) continue;
    if (classification === "production") production.feedback = (production.feedback || 0) + 1;
    else if (classification !== "unknown_legacy") canaryTest.feedback = (canaryTest.feedback || 0) + 1;
  }
  return {
    production: { draft: production.draft, approved: production.approved, outbox: production.outbox, sent: production.sent, failed: production.failed },
    canaryTest: { canary: canaryTest.canary, sandbox: canaryTest.sandbox, testQuota: canaryTest.testQuota },
    recovery: { retry: recovery.retry, recovered: recovery.recovered, intervention: recovery.intervention },
    legacyClassificationView: legacyMappings,
    mappingCount: legacyMappings.length,
  };
}

export function reconcileMetrics(raw = {}, classified = {}, legacyMappedMetrics = {}) {
  const rawMetricValues = {
    draft: Number(raw.draftsGenerated || 0),
    approval: Number(raw.autoApproved || 0),
    outbox: Number(raw.outboxCreated || 0),
    accepted: Number(raw.accepted || 0),
    failed: Number(raw.failed || 0),
    retry: Number(raw.retries || 0),
  };
  const classifiedMetricValues = {
    draft: Number(classified.production?.draft || 0),
    approval: Number(classified.production?.approved || 0),
    outbox: Number(classified.production?.outbox || 0),
    accepted: Number(classified.production?.sent || 0),
    failed: Number(classified.production?.failed || 0),
    retry: Number(classified.recovery?.retry || 0),
  };
  const metricReconciliation = Object.fromEntries(Object.keys(rawMetricValues).map((metric) => {
    const rawValue = rawMetricValues[metric];
    const classifiedValue = classifiedMetricValues[metric];
    return [metric, { raw: rawValue, classified: classifiedValue, difference: rawValue - classifiedValue, reason: rawValue === classifiedValue ? "matched" : "legacy_or_unclassified_event" }];
  }));
  const rawTotal = Object.values(rawMetricValues).reduce((sum, value) => sum + value, 0);
  const classifiedTotal = Object.values(classifiedMetricValues).reduce((sum, value) => sum + value, 0);
  const legacyTotal = Number(legacyMappedMetrics.total || 0);
  return {
    rawTotal,
    classifiedTotal,
    legacyMappedTotal: legacyTotal,
    difference: rawTotal - classifiedTotal - legacyTotal,
    differenceReasons: rawTotal === classifiedTotal + legacyTotal ? [] : ["unclassified_or_legacy_event_requires_review"],
    metricReconciliation,
    mappingRule: "legacy_mapping_v1",
    readOnly: true,
  };
}

export const NON_BILLABLE = NON_BILLABLE_CLASSIFICATIONS;
