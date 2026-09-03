import assert from "node:assert/strict";
import { emailFingerprint, mergeRecord, qualifyRecord } from "../../tools/reprocess-managed-history.mjs";

const validation = new Map([[emailFingerprint("buyer@example.test"), "domain_valid"]]);
const suppressions = new Set([emailFingerprint("blocked@example.test")]);

const generic = qualifyRecord({ company: "Acme Co", email: "buyer@example.test", source: "NetEase" }, validation, suppressions);
assert.equal(generic.qualificationStatus, "qualified");
assert.equal(generic.contactNameFallback, "Purchasing Team");
assert.equal(generic.domainStatus, "validated");
assert.equal(qualifyRecord({ company: "Acme Co", email: "blocked@example.test", source: "NetEase" }, validation, suppressions).qualificationStatus, "rejected");

const merged = mergeRecord(generic, { ...generic, name: "Purchasing Team", evidenceSources: ["https://example.test"] });
assert.equal(merged.name, "Purchasing Team");
assert.deepEqual(merged.evidenceSources, ["https://example.test"]);

console.log(JSON.stringify({ ok: true, check: "reprocess-managed-history-unit" }));
