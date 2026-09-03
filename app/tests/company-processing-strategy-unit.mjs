import assert from "node:assert/strict";
import { resolveCompanyProcessingStrategy } from "../company-processing-strategy.mjs";

assert.deepEqual(resolveCompanyProcessingStrategy({ legacyTarget: 100 }), {
  enabled: false,
  strategy: "fixed",
  label: "固定模式",
  dailyCompanyTarget: 100,
  fallback: "validEmailCompaniesDaily",
});
assert.equal(resolveCompanyProcessingStrategy({ legacyTarget: 80 }, { enabled: false, target: 120 }).dailyCompanyTarget, 80);
assert.equal(resolveCompanyProcessingStrategy({ legacyTarget: 100 }, { enabled: true, target: 100 }).dailyCompanyTarget, 100);

console.log("company processing strategy unit passed");

