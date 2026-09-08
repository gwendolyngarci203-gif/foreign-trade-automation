const ITEM_STATUSES = new Set(["pending", "leased", "completed", "failed", "skipped"]);
const QUEUE_STATUSES = new Set(["ready", "running", "paused", "circuit_open", "completed"]);

export const COLLECTION_SIGNALS = new Set([
  "none",
  "captcha",
  "frequent_operation",
  "permission",
  "http_403",
  "http_429",
  "structure_error",
  "duplicate_page",
  "page_stuck",
  "control_timeout",
  "browser_disconnected",
  "auth_required",
]);

export const SEVERE_PLATFORM_SIGNALS = new Set([
  "captcha",
  "frequent_operation",
  "permission",
  "http_403",
  "http_429",
]);

export const STRUCTURE_SIGNALS = new Set(["structure_error", "duplicate_page", "page_stuck"]);

function integer(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

function nowIso(now) {
  return now instanceof Date ? now.toISOString() : new Date(now || Date.now()).toISOString();
}

export function normalizeCompanyName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function companyNameIssue(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name) return "missing_company_name";
  if (name.length > 180) return "company_name_too_long";
  if (name.length < 110) return "";
  const tokens = name.toUpperCase().split(" ").map((token) => token.replace(/[^A-Z0-9]/g, "")).filter((token) => token.length > 2);
  const repeatedToken = tokens.some((token, index) => tokens.indexOf(token) !== index && tokens.filter((item) => item === token).length >= 3);
  const addressMarker = /\b(?:ROAD|STREET|AVENUE|DIVISION|DISTRICT|KAMPALA|CENTRAL|BLOCK|BUILDING|FLOOR)\b/i.test(name);
  return addressMarker && (repeatedToken || /\d/.test(name)) ? "likely_concatenated_buyer_row" : "";
}

export function cleanCollectionConfig(input = {}) {
  const minDelayMs = integer(input.minDelayMs, 15000, 1500, 120000);
  return {
    batchSize: integer(input.batchSize, 20, 1, 50),
    minDelayMs,
    maxDelayMs: integer(input.maxDelayMs, Math.max(minDelayMs, 25000), minDelayMs, 180000),
    leaseSeconds: integer(input.leaseSeconds, 1800, 60, 7200),
    maxAttempts: integer(input.maxAttempts, 3, 1, 8),
  };
}

function sourceEntries(sources) {
  const merged = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    const sourceId = String(source.sourceId || source.label || "source").trim().slice(0, 120) || "source";
    const buyers = Array.isArray(source.buyers) ? source.buyers : [];
    buyers.forEach((value, sourceIndex) => {
      const companyName = typeof value === "string"
        ? value
        : String(value?.company || value?.buyer || value?.name || "");
      const key = normalizeCompanyName(companyName);
      if (!key) return;
      const existing = merged.get(key);
      if (existing) {
        if (!existing.sourceIds.includes(sourceId)) existing.sourceIds.push(sourceId);
        return;
      }
      merged.set(key, {
        companyName: String(companyName).trim().replace(/\s+/g, " "),
        normalizedName: key,
        issue: companyNameIssue(companyName),
        sourceIds: [sourceId],
        sourceIndex,
      });
    });
  }
  return [...merged.values()];
}

function queueCounts(queue) {
  const counts = Object.fromEntries([...ITEM_STATUSES].map((status) => [status, 0]));
  let contactRows = 0;
  let contactRowsTotal = 0;
  let continuing = 0;
  for (const item of queue.items || []) {
    counts[item.status] = (counts[item.status] || 0) + 1;
    contactRows += Number(item.contactRows || 0);
    contactRowsTotal += Number(item.contactTotal || 0);
    if (item.status === "completed" && item.contactComplete === false) continuing += 1;
  }
  return {
    total: (queue.items || []).length,
    ...counts,
    processed: counts.completed + counts.skipped,
    // A company with a usable first contact page stays completed for inventory
    // purposes, while its continuation remains claimable on a later batch.
    continuing,
    remaining: counts.pending + counts.leased + continuing,
    contactRows,
    contactRowsTotal,
  };
}

function ensureQueue(queue) {
  if (!QUEUE_STATUSES.has(queue.status)) queue.status = "paused";
  queue.items = Array.isArray(queue.items) ? queue.items : [];
  queue.batches = Array.isArray(queue.batches) ? queue.batches : [];
  queue.audit = Array.isArray(queue.audit) ? queue.audit : [];
  queue.config = cleanCollectionConfig(queue.config);
  queue.consecutiveStructureErrors = integer(queue.consecutiveStructureErrors, 0, 0, 1000);
  for (const item of queue.items) {
    item.contactRows = integer(item.contactRows, 0, 0, 100000);
    item.contactTotal = integer(item.contactTotal, 0, 0, 1000000);
    item.contactPage = integer(item.contactPage, 0, 0, 1000000);
    item.contactPageSize = integer(item.contactPageSize, 0, 0, 100000);
    item.contactNextPage = integer(item.contactNextPage, item.contactPage ? item.contactPage + 1 : 1, 1, 1000000);
    item.contactPagesCollected = integer(item.contactPagesCollected, item.contactPage ? 1 : 0, 0, 1000000);
    item.lastContactRowsDelta = integer(item.lastContactRowsDelta, 0, 0, 100000);
    item.contactArtifacts = Array.isArray(item.contactArtifacts) ? item.contactArtifacts : [];
    if (typeof item.contactComplete !== "boolean") item.contactComplete = true;
  }
  return queue;
}

function addAudit(queue, entry) {
  queue.audit = [...(queue.audit || []), entry].slice(-2000);
}

export function createOrSyncQueue(existing, input, now = new Date()) {
  const at = nowIso(now);
  const processed = new Set((input.processedNames || []).map(normalizeCompanyName).filter(Boolean));
  const entries = sourceEntries(input.sources);
  const queue = existing ? ensureQueue(existing) : {
    id: String(input.id || "").trim(),
    key: String(input.key || "").trim().slice(0, 120),
    label: String(input.label || "联系人采集队列").trim().slice(0, 200),
    status: "ready",
    safetyState: "READY",
    config: cleanCollectionConfig(input.config),
    items: [],
    batches: [],
    activeBatchId: "",
    leaseOwner: "",
    leaseExpiresAt: null,
    consecutiveStructureErrors: 0,
    lastBoundary: null,
    createdAt: at,
    updatedAt: at,
    audit: [],
  };

  if (!queue.id) throw new Error("queue id is required");
  queue.key = String(input.key || queue.key || "").trim().slice(0, 120);
  queue.label = String(input.label || queue.label || "联系人采集队列").trim().slice(0, 200);
  queue.config = cleanCollectionConfig({ ...queue.config, ...(input.config || {}) });
  const byName = new Map((queue.items || []).map((item) => [normalizeCompanyName(item.companyName), item]));
  let added = 0;
  let markedCompleted = 0;

  for (const entry of entries) {
    const current = byName.get(entry.normalizedName);
    if (current) {
      current.sourceIds = [...new Set([...(current.sourceIds || []), ...entry.sourceIds])];
      if (entry.issue && !["completed", "skipped"].includes(current.status)) {
        current.status = "skipped";
        current.lastOutcome = "invalid_source";
        current.lastError = entry.issue;
        current.completedAt = at;
      }
      if (processed.has(entry.normalizedName) && !["completed", "skipped"].includes(current.status)) {
        current.status = "completed";
        current.completedAt = at;
        current.lastOutcome = "imported_existing_result";
        markedCompleted += 1;
      }
      continue;
    }
    const item = {
      id: `item_${queue.items.length + 1}`,
      companyName: entry.companyName,
      normalizedName: entry.normalizedName,
      sourceIds: entry.sourceIds,
      sourceIndex: entry.sourceIndex,
      status: processed.has(entry.normalizedName) ? "completed" : entry.issue ? "skipped" : "pending",
      attempts: 0,
      leaseOwner: "",
      leaseExpiresAt: null,
      lastSignal: "none",
      lastError: entry.issue || "",
      contactRows: 0,
      contactTotal: 0,
      contactPage: 0,
      contactPageSize: 0,
      contactNextPage: 1,
      contactPagesCollected: 0,
      lastContactRowsDelta: 0,
      contactComplete: true,
      contactArtifacts: [],
      artifactReference: "",
      completedAt: processed.has(entry.normalizedName) || entry.issue ? at : null,
      updatedAt: at,
    };
    if (item.status === "completed") item.lastOutcome = "imported_existing_result";
    if (item.status === "skipped") item.lastOutcome = "invalid_source";
    queue.items.push(item);
    byName.set(entry.normalizedName, item);
    added += 1;
  }

  if (queueCounts(queue).remaining === 0 && queue.items.length) {
    queue.status = "completed";
    queue.safetyState = "READY";
  } else if (queue.status === "completed") {
    queue.status = "ready";
  }
  queue.updatedAt = at;
  addAudit(queue, { at, type: existing ? "queue_synced" : "queue_created", added, markedCompleted, total: queue.items.length });
  return queue;
}

export function releaseExpiredLease(queue, now = new Date()) {
  ensureQueue(queue);
  if (!queue.leaseExpiresAt || Date.parse(queue.leaseExpiresAt) > new Date(now).getTime()) return false;
  const at = nowIso(now);
  const activeBatch = queue.batches.find((batch) => batch.id === queue.activeBatchId);
  for (const item of queue.items) {
    if (item.status === "leased" && item.leaseOwner === queue.leaseOwner) {
      item.status = "pending";
      item.leaseOwner = "";
      item.leaseExpiresAt = null;
      item.lastError = "lease_expired";
      item.updatedAt = at;
    }
  }
  if (activeBatch && activeBatch.status === "running") {
    activeBatch.status = "expired";
    activeBatch.completedAt = at;
  }
  addAudit(queue, { at, type: "lease_expired", batchId: queue.activeBatchId, owner: queue.leaseOwner });
  queue.activeBatchId = "";
  queue.leaseOwner = "";
  queue.leaseExpiresAt = null;
  if (queue.status === "running") queue.status = "ready";
  queue.updatedAt = at;
  return true;
}

export function claimBatch(queue, input, now = new Date()) {
  ensureQueue(queue);
  releaseExpiredLease(queue, now);
  if (["paused", "circuit_open", "completed"].includes(queue.status)) {
    const error = new Error(`queue is ${queue.status}`);
    error.status = queue.status === "circuit_open" ? 423 : 409;
    throw error;
  }
  if (queue.activeBatchId) {
    const error = new Error("queue already has an active batch");
    error.status = 409;
    throw error;
  }
  const owner = String(input.owner || "").trim().slice(0, 120);
  if (!owner) {
    const error = new Error("owner is required");
    error.status = 422;
    throw error;
  }
  const size = integer(input.batchSize, queue.config.batchSize, 1, 50);
  // Keep a locally failing company from blocking the queue head. Control-layer
  // failures are retriable, but rotate them behind untouched items so the
  // worker can continue making progress without increasing request pressure.
  const pending = queue.items
    .filter((item) => item.status === "pending" || (item.status === "completed" && item.contactComplete === false))
    .sort((a, b) => {
      const aControlError = ["control_timeout", "browser_disconnected"].includes(a.lastSignal) ? 1 : 0;
      const bControlError = ["control_timeout", "browser_disconnected"].includes(b.lastSignal) ? 1 : 0;
      if (aControlError !== bControlError) return aControlError - bControlError;
      return String(a.updatedAt || "").localeCompare(String(b.updatedAt || ""));
    })
    .slice(0, size);
  if (!pending.length) {
    queue.status = queueCounts(queue).remaining ? "ready" : "completed";
    return null;
  }
  const at = nowIso(now);
  const leaseSeconds = integer(input.leaseSeconds, queue.config.leaseSeconds, 60, 7200);
  const leaseExpiresAt = new Date(new Date(now).getTime() + leaseSeconds * 1000).toISOString();
  const batch = {
    id: String(input.batchId || "").trim(),
    owner,
    itemIds: pending.map((item) => item.id),
    status: "running",
    createdAt: at,
    leaseExpiresAt,
    completedAt: null,
    artifactReference: "",
  };
  if (!batch.id) throw new Error("batch id is required");
  for (const item of pending) {
    item.status = "leased";
    item.attempts = Number(item.attempts || 0) + 1;
    item.leaseOwner = owner;
    item.leaseExpiresAt = leaseExpiresAt;
    item.updatedAt = at;
  }
  queue.batches.push(batch);
  queue.batches = queue.batches.slice(-500);
  queue.activeBatchId = batch.id;
  queue.leaseOwner = owner;
  queue.leaseExpiresAt = leaseExpiresAt;
  queue.status = "running";
  queue.safetyState = "RUNNING";
  queue.updatedAt = at;
  addAudit(queue, { at, type: "batch_claimed", batchId: batch.id, owner, count: pending.length });
  return {
    ...batch,
    config: { ...queue.config },
    items: pending.map((item) => ({
      id: item.id,
      companyName: item.companyName,
      sourceIds: item.sourceIds,
      attempt: item.attempts,
      contactPage: item.contactNextPage || 1,
      contactTotal: item.contactTotal || 0,
      contactRows: item.contactRows || 0,
      contactComplete: item.contactComplete !== false,
    })),
  };
}

export function completeBatch(queue, batchId, input, now = new Date()) {
  ensureQueue(queue);
  const batch = queue.batches.find((item) => item.id === batchId);
  if (!batch) {
    const error = new Error("batch not found");
    error.status = 404;
    throw error;
  }
  const owner = String(input.owner || "").trim().slice(0, 120);
  if (batch.owner !== owner) {
    const error = new Error("batch lease owner mismatch");
    error.status = 409;
    throw error;
  }
  if (batch.status !== "running") {
    const error = new Error(`batch is ${batch.status}`);
    error.status = 409;
    throw error;
  }
  const at = nowIso(now);
  const results = Array.isArray(input.results) ? input.results : [];
  const byId = new Map(queue.items.map((item) => [item.id, item]));
  const reported = new Set();
  let severeSignal = "";
  let structureSignals = 0;
  let controlErrors = 0;

  for (const result of results) {
    const item = byId.get(String(result.itemId || ""));
    if (!item || !batch.itemIds.includes(item.id)) continue;
    reported.add(item.id);
    const reportedSignal = COLLECTION_SIGNALS.has(String(result.signal || "none")) ? String(result.signal || "none") : "structure_error";
    const continuationExhausted = reportedSignal === "control_timeout"
      && Number(item.contactRows || 0) > 0
      && /Requested contact page is unavailable/.test(String(result.error || ""));
    const controllerFailure = ["control_timeout", "browser_disconnected"].includes(reportedSignal);
    const signal = continuationExhausted ? "none" : reportedSignal;
    const outcome = continuationExhausted
      ? "ok"
      : (["ok", "no_result", "skipped", "partial", "error"].includes(result.outcome) ? result.outcome : "error");
    item.lastSignal = signal;
    item.lastError = continuationExhausted ? "" : String(result.error || "").slice(0, 500);
    const contactRowsDelta = integer(result.contactRowsDelta, integer(result.contactRows, 0, 0, 100000), 0, 100000);
    item.lastContactRowsDelta = contactRowsDelta;
    item.contactRows = Math.min(1000000, Number(item.contactRows || 0) + contactRowsDelta);
    item.contactTotal = Math.max(Number(item.contactTotal || 0), integer(result.contactTotal, 0, 0, 1000000));
    if (!controllerFailure) {
      item.contactPage = Math.max(Number(item.contactPage || 0), integer(result.contactPage, 0, 0, 1000000));
      item.contactPageSize = integer(result.contactPageSize, Number(item.contactPageSize || 0), 0, 100000);
      item.contactNextPage = integer(result.contactNextPage, item.contactPage ? item.contactPage + 1 : 1, 1, 1000000);
      item.contactPagesCollected = Math.max(Number(item.contactPagesCollected || 0), integer(result.contactPagesCollected, item.contactPage ? item.contactPage : 0, 0, 1000000));
    }
    item.contactComplete = continuationExhausted || (controllerFailure ? item.contactComplete : result.contactComplete !== false);
    item.artifactReference = String(input.artifactReference || result.artifactReference || "").slice(0, 500);
    if (item.artifactReference && !item.contactArtifacts.includes(item.artifactReference)) {
      item.contactArtifacts = [...item.contactArtifacts, item.artifactReference].slice(-100);
    }
    item.lastOutcome = outcome;
    item.leaseOwner = "";
    item.leaseExpiresAt = null;
    item.updatedAt = at;
    if (SEVERE_PLATFORM_SIGNALS.has(signal)) severeSignal ||= signal;
    if (STRUCTURE_SIGNALS.has(signal)) structureSignals += 1;
    if (["control_timeout", "browser_disconnected", "auth_required"].includes(signal)) controlErrors += 1;

    // A local controller loss says nothing about the target company or the
    // platform. Return the item to the queue without spending its retry budget.
    if (["control_timeout", "browser_disconnected"].includes(signal)) {
      item.attempts = Math.max(0, Number(item.attempts || 0) - 1);
      item.status = "pending";
    } else if (outcome === "partial" || (outcome === "ok" && item.contactComplete === false)) {
      // Keep the company usable and claimable; the next batch starts at the
      // persisted contactNextPage instead of discarding the remaining pages.
      item.status = "completed";
      item.attempts = 0;
      item.completedAt = item.completedAt || at;
    } else if (outcome === "ok" || outcome === "no_result") {
      item.status = "completed";
      item.contactComplete = true;
      item.completedAt = at;
    } else if (outcome === "skipped") {
      item.status = "skipped";
      item.completedAt = at;
    } else if (item.attempts >= queue.config.maxAttempts) {
      item.status = "failed";
    } else {
      item.status = "pending";
    }
  }

  for (const itemId of batch.itemIds) {
    if (reported.has(itemId)) continue;
    const item = byId.get(itemId);
    if (!item) continue;
    item.status = item.attempts >= queue.config.maxAttempts ? "failed" : "pending";
    item.leaseOwner = "";
    item.leaseExpiresAt = null;
    item.lastSignal = "control_timeout";
    item.lastError = "batch_completed_without_item_result";
    item.updatedAt = at;
    controlErrors += 1;
  }

  queue.consecutiveStructureErrors = structureSignals > 0
    ? queue.consecutiveStructureErrors + structureSignals
    : 0;
  if (severeSignal || queue.consecutiveStructureErrors >= 3) {
    const signal = severeSignal || "structure_error";
    queue.status = "circuit_open";
    queue.safetyState = "CIRCUIT_OPEN";
    queue.lastBoundary = { at, signal, category: severeSignal ? "platform" : "page_structure", batchId };
  } else {
    const counts = queueCounts(queue);
    queue.status = counts.remaining ? "ready" : "completed";
    queue.safetyState = controlErrors || structureSignals ? "THROTTLED" : "READY";
    if (controlErrors || structureSignals) {
      queue.lastBoundary = {
        at,
        signal: controlErrors ? "control_error" : "structure_error",
        category: controlErrors ? "control_layer" : "page_structure",
        batchId,
      };
    }
  }
  batch.status = queue.status === "circuit_open" ? "circuit_open" : "completed";
  batch.completedAt = at;
  batch.artifactReference = String(input.artifactReference || "").slice(0, 500);
  queue.activeBatchId = "";
  queue.leaseOwner = "";
  queue.leaseExpiresAt = null;
  queue.updatedAt = at;
  addAudit(queue, {
    at,
    type: "batch_completed",
    batchId,
    reported: reported.size,
    severeSignal: severeSignal || "none",
    structureSignals,
    controlErrors,
    safetyState: queue.safetyState,
    continuationCount: queueCounts(queue).continuing,
  });
  return collectionQueueView(queue, { includeItems: false });
}

export function setQueueState(queue, action, input = {}, now = new Date()) {
  ensureQueue(queue);
  const at = nowIso(now);
  if (action === "pause") {
    if (queue.activeBatchId) {
      const error = new Error("cannot pause an active batch; complete or expire the lease first");
      error.status = 409;
      throw error;
    }
    queue.status = "paused";
    queue.safetyState = "READY";
  } else if (action === "resume") {
    if (queue.status === "circuit_open") {
      const expected = `RECOVER COLLECTION ${queue.id}`;
      if (input.confirm !== expected) {
        const error = new Error(`confirmation required: ${expected}`);
        error.status = 428;
        throw error;
      }
      queue.consecutiveStructureErrors = 0;
      queue.safetyState = "HUMAN_RECOVERY";
    }
    queue.status = queueCounts(queue).remaining ? "ready" : "completed";
  } else {
    const error = new Error("unsupported queue action");
    error.status = 422;
    throw error;
  }
  queue.updatedAt = at;
  addAudit(queue, { at, type: `queue_${action}`, safetyState: queue.safetyState });
  return collectionQueueView(queue, { includeItems: false });
}

export function requeueFailedItems(queue, input = {}, now = new Date()) {
  ensureQueue(queue);
  if (queue.activeBatchId) {
    const error = new Error("cannot retry failed items while a batch is active");
    error.status = 409;
    throw error;
  }
  const expected = `RETRY FAILED ${queue.id}`;
  if (input.confirm !== expected) {
    const error = new Error(`confirmation required: ${expected}`);
    error.status = 428;
    throw error;
  }
  const at = nowIso(now);
  const requested = new Set(Array.isArray(input.itemIds) ? input.itemIds.map(String) : []);
  const failed = queue.items.filter((item) => item.status === "failed" && (!requested.size || requested.has(item.id)));
  for (const item of failed) {
    item.status = "pending";
    item.attempts = 0;
    item.leaseOwner = "";
    item.leaseExpiresAt = null;
    item.lastSignal = "none";
    item.lastError = "";
    item.completedAt = null;
    item.updatedAt = at;
    item.lastOutcome = "failed_item_requeued";
  }
  if (failed.length) {
    queue.status = "ready";
    queue.safetyState = "READY";
    queue.updatedAt = at;
  }
  addAudit(queue, { at, type: "failed_items_requeued", count: failed.length, itemIds: failed.map((item) => item.id) });
  return collectionQueueView(queue, { includeItems: false });
}

export function collectionQueueView(queue, options = {}) {
  ensureQueue(queue);
  releaseExpiredLease(queue, options.now || new Date());
  const counts = queueCounts(queue);
  const view = {
    id: queue.id,
    key: queue.key,
    label: queue.label,
    status: queue.status,
    safetyState: queue.safetyState,
    config: { ...queue.config },
    counts,
    progressPct: counts.total ? Math.round((counts.processed / counts.total) * 10000) / 100 : 0,
    activeBatchId: queue.activeBatchId,
    leaseOwner: queue.leaseOwner,
    leaseExpiresAt: queue.leaseExpiresAt,
    consecutiveStructureErrors: queue.consecutiveStructureErrors,
    lastBoundary: queue.lastBoundary,
    createdAt: queue.createdAt,
    updatedAt: queue.updatedAt,
    audit: (queue.audit || []).slice(-100).reverse(),
    recentBatches: (queue.batches || []).slice(-20).reverse(),
  };
  if (options.includeItems) view.items = queue.items;
  return view;
}

export function collectionBoundaryReport(queue) {
  ensureQueue(queue);
  const boundaries = (queue.audit || []).filter((entry) =>
    entry.type === "lease_expired"
    || entry.type === "batch_completed" && (entry.severeSignal !== "none" || entry.structureSignals || entry.controlErrors));
  return {
    generatedAt: new Date().toISOString(),
    queue: collectionQueueView(queue),
    stopRules: {
      immediate: [...SEVERE_PLATFORM_SIGNALS],
      consecutiveStructureFailures: 3,
      controlLayerErrors: "release lease and retry; not treated as a NetEase platform alarm",
      maxAttemptsPerCompany: queue.config.maxAttempts,
    },
    observedBoundaries: boundaries,
    implementation: {
      concurrency: 1,
      visibleSessionRequired: true,
      minDelayMs: queue.config.minDelayMs,
      maxDelayMs: queue.config.maxDelayMs,
      batchSize: queue.config.batchSize,
      checkpoint: "after every submitted batch",
    },
  };
}
