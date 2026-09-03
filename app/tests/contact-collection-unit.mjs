import assert from "node:assert/strict";

import {
  claimBatch,
  collectionBoundaryReport,
  collectionQueueView,
  completeBatch,
  createOrSyncQueue,
  releaseExpiredLease,
  setQueueState,
} from "../contact-collection.mjs";

const start = new Date("2026-08-11T00:00:00.000Z");
const queue = createOrSyncQueue(null, {
  id: "collection_test",
  key: "test",
  label: "Test buyers",
  sources: [
    { sourceId: "a", buyers: ["Alpha Co", "Beta Co", "Shared Co"] },
    { sourceId: "b", buyers: ["Shared   Co", "Gamma Co"] },
  ],
  processedNames: ["ALPHA CO"],
  config: { batchSize: 2, minDelayMs: 2000, maxDelayMs: 4000, leaseSeconds: 60, maxAttempts: 2 },
}, start);

let view = collectionQueueView(queue, { now: start });
assert.equal(view.counts.total, 4);
assert.equal(view.counts.completed, 1);
assert.equal(view.counts.pending, 3);
assert.deepEqual(queue.items.find((item) => item.companyName === "Shared Co").sourceIds, ["a", "b"]);

const batch = claimBatch(queue, { owner: "desktop", batchId: "batch_1" }, start);
assert.equal(batch.items.length, 2);
assert.equal(collectionQueueView(queue, { now: start }).counts.leased, 2);

completeBatch(queue, batch.id, {
  owner: "desktop",
  artifactReference: "outputs/batch-1.json",
  results: [
    { itemId: batch.items[0].id, outcome: "ok", signal: "none", contactRows: 12 },
    { itemId: batch.items[1].id, outcome: "error", signal: "control_timeout", error: "CDP timeout" },
  ],
}, new Date("2026-08-11T00:01:00.000Z"));
view = collectionQueueView(queue, { now: new Date("2026-08-11T00:01:00.000Z") });
assert.equal(view.safetyState, "THROTTLED");
assert.equal(view.counts.completed, 2);
assert.equal(view.counts.pending, 2);
assert.equal(view.counts.contactRows, 12);
assert.equal(view.lastBoundary.category, "control_layer");

const leased = claimBatch(queue, { owner: "desktop", batchId: "batch_expire", batchSize: 1, leaseSeconds: 60 }, new Date("2026-08-11T00:02:00.000Z"));
assert.equal(leased.items.length, 1);
assert.equal(releaseExpiredLease(queue, new Date("2026-08-11T00:03:01.000Z")), true);
assert.equal(collectionQueueView(queue, { now: new Date("2026-08-11T00:03:01.000Z") }).counts.leased, 0);

const circuitQueue = createOrSyncQueue(null, {
  id: "collection_circuit",
  key: "circuit",
  sources: [{ sourceId: "a", buyers: ["One", "Two", "Three"] }],
  config: { batchSize: 3 },
}, start);
const circuitBatch = claimBatch(circuitQueue, { owner: "desktop", batchId: "batch_circuit" }, start);
completeBatch(circuitQueue, circuitBatch.id, {
  owner: "desktop",
  results: circuitBatch.items.map((item) => ({ itemId: item.id, outcome: "error", signal: "structure_error" })),
}, new Date("2026-08-11T00:00:30.000Z"));
assert.equal(circuitQueue.status, "circuit_open");
assert.equal(circuitQueue.lastBoundary.category, "page_structure");
assert.throws(() => claimBatch(circuitQueue, { owner: "desktop", batchId: "blocked" }, start), /circuit_open/);
setQueueState(circuitQueue, "resume", { confirm: "RECOVER COLLECTION collection_circuit" }, start);
assert.equal(circuitQueue.status, "ready");
assert.equal(circuitQueue.safetyState, "HUMAN_RECOVERY");

const severeQueue = createOrSyncQueue(null, {
  id: "collection_severe",
  key: "severe",
  sources: [{ sourceId: "a", buyers: ["Only"] }],
}, start);
const severeBatch = claimBatch(severeQueue, { owner: "desktop", batchId: "batch_severe" }, start);
completeBatch(severeQueue, severeBatch.id, {
  owner: "desktop",
  results: [{ itemId: severeBatch.items[0].id, outcome: "error", signal: "http_429" }],
}, start);
assert.equal(severeQueue.status, "circuit_open");
assert.equal(severeQueue.lastBoundary.category, "platform");
assert.deepEqual(collectionBoundaryReport(severeQueue).stopRules.immediate.includes("http_429"), true);

const partialQueue = createOrSyncQueue(null, {
  id: "collection_partial",
  key: "partial",
  sources: [{ sourceId: "a", buyers: ["Paged Buyer"] }],
}, start);
const firstPage = claimBatch(partialQueue, { owner: "desktop", batchId: "batch_partial_1" }, start);
completeBatch(partialQueue, firstPage.id, {
  owner: "desktop",
  artifactReference: "tmp/page-1.json",
  results: [{
    itemId: firstPage.items[0].id,
    outcome: "partial",
    signal: "none",
    contactRowsDelta: 20,
    contactTotal: 45,
    contactPage: 1,
    contactPageSize: 20,
    contactNextPage: 2,
    contactPagesCollected: 1,
    contactComplete: false,
  }],
}, new Date("2026-08-11T00:01:00.000Z"));
view = collectionQueueView(partialQueue, { now: new Date("2026-08-11T00:01:00.000Z") });
assert.equal(view.counts.completed, 1);
assert.equal(view.counts.continuing, 1);
assert.equal(view.counts.remaining, 1);
assert.equal(partialQueue.items[0].contactRows, 20);
assert.equal(partialQueue.items[0].contactNextPage, 2);
const secondPage = claimBatch(partialQueue, { owner: "desktop", batchId: "batch_partial_2" }, new Date("2026-08-11T00:02:00.000Z"));
assert.equal(secondPage.items[0].contactPage, 2);
completeBatch(partialQueue, secondPage.id, {
  owner: "desktop",
  artifactReference: "tmp/page-2.json",
  results: [{
    itemId: secondPage.items[0].id,
    outcome: "ok",
    signal: "none",
    contactRowsDelta: 25,
    contactTotal: 45,
    contactPage: 2,
    contactPageSize: 25,
    contactNextPage: 2,
    contactPagesCollected: 2,
    contactComplete: true,
  }],
}, new Date("2026-08-11T00:03:00.000Z"));
view = collectionQueueView(partialQueue, { now: new Date("2026-08-11T00:03:00.000Z") });
assert.equal(view.counts.remaining, 0);
assert.equal(view.counts.contactRows, 45);
assert.equal(partialQueue.items[0].contactComplete, true);

const exhaustedQueue = createOrSyncQueue(null, {
  id: "collection_exhausted_continuation",
  key: "exhausted-continuation",
  sources: [{ sourceId: "a", buyers: ["One-page Buyer"] }],
}, start);
const exhaustedFirst = claimBatch(exhaustedQueue, { owner: "desktop", batchId: "batch_exhausted_1" }, start);
completeBatch(exhaustedQueue, exhaustedFirst.id, {
  owner: "desktop",
  results: [{ itemId: exhaustedFirst.items[0].id, outcome: "partial", signal: "none", contactRowsDelta: 40, contactPage: 1, contactNextPage: 2, contactComplete: false }],
}, new Date("2026-08-11T00:01:00.000Z"));
const exhaustedSecond = claimBatch(exhaustedQueue, { owner: "desktop", batchId: "batch_exhausted_2" }, new Date("2026-08-11T00:02:00.000Z"));
completeBatch(exhaustedQueue, exhaustedSecond.id, {
  owner: "desktop",
  results: [{ itemId: exhaustedSecond.items[0].id, outcome: "error", signal: "control_timeout", error: "temporary CDP timeout" }],
}, new Date("2026-08-11T00:03:00.000Z"));
assert.equal(exhaustedQueue.items[0].contactNextPage, 2);
assert.equal(exhaustedQueue.items[0].contactComplete, false);
const exhaustedThird = claimBatch(exhaustedQueue, { owner: "desktop", batchId: "batch_exhausted_3" }, new Date("2026-08-11T00:04:00.000Z"));
completeBatch(exhaustedQueue, exhaustedThird.id, {
  owner: "desktop",
  results: [{ itemId: exhaustedThird.items[0].id, outcome: "error", signal: "control_timeout", error: "Requested contact page is unavailable" }],
}, new Date("2026-08-11T00:05:00.000Z"));
view = collectionQueueView(exhaustedQueue, { now: new Date("2026-08-11T00:05:00.000Z") });
assert.equal(view.counts.remaining, 0);
assert.equal(view.counts.contactRows, 40);
assert.equal(view.safetyState, "READY");
assert.equal(exhaustedQueue.items[0].contactPage, 1);

console.log(JSON.stringify({ ok: true, total: view.counts.total, completed: view.counts.completed, circuit: circuitQueue.status }));
