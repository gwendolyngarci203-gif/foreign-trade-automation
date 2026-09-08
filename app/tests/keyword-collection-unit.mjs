import assert from "node:assert/strict";
import {
  buildKeywordSearchUrl,
  countryBusinessCollectionManifest,
  countryBusinessDiscoveryArtifact,
  keywordCollectionManifest,
  marketTargetDiscoveryInputs,
  validateBusinessKeywords,
  validateCountry,
  validateKeyword,
} from "../keyword-collection.mjs";
import { normalizeTrades, validateDiscovery } from "../pipeline-worker.mjs";

assert.equal(validateKeyword("  board   games "), "board games");
assert.match(buildKeywordSearchUrl("board games"), /keyword=board%20games/);
assert.throws(() => validateKeyword("x"), /至少需要2个字符/);
assert.deepEqual(keywordCollectionManifest({ keyword: "board games", direction: "supplier" }).framework, "contact-collection-queue");
assert.equal(validateCountry("  Poland "), "Poland");
assert.deepEqual(validateBusinessKeywords("board games, books, paper packaging"), ["board games", "books", "paper packaging"]);
const countryBusiness = countryBusinessCollectionManifest({ country: "Poland", businessScope: "board games, books, paper packaging" });
assert.equal(countryBusiness.mode, "country_business");
assert.equal(countryBusiness.country, "Poland");
assert.match(countryBusiness.searchUrl, /keyword=board%20games%20books%20paper%20packaging/);
assert.throws(() => countryBusinessCollectionManifest({ country: "Poland", businessScope: "" }), /至少需要一个业务范围关键词/);
const profile = { country: "Poland", industryKeywords: ["board games"], excludeKeywords: ["freight", "forwarder", "logistics"], direction: "buyer" };
assert.deepEqual(marketTargetDiscoveryInputs(profile), []);
const [discoveryInput] = marketTargetDiscoveryInputs({ ...profile, enabled: true });
const artifact = countryBusinessDiscoveryArtifact({
  ...discoveryInput,
  pageNumber: 1,
  sourceRows: 2,
  records: [
    { company: "Polish Games Sp. z o.o.", country: "Poland", page: 1, row: 1, cells: ["board games"] },
    { company: "Warsaw Freight Sp. z o.o.", country: "Poland", page: 1, row: 2, cells: ["freight"] },
  ],
});
assert.equal(artifact.kind, "netease-country-business-discovery");
assert.equal(artifact.country, "Poland");
assert.equal(artifact.records.length, 1);
const pipelineDiscovery = validateDiscovery(artifact);
assert.equal(pipelineDiscovery.country, "Poland");
assert.equal(normalizeTrades(pipelineDiscovery).records.length, 1);
console.log(JSON.stringify({ ok: true, check: "keyword-collection-unit" }));
