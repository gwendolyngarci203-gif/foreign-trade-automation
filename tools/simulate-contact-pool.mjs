#!/usr/bin/env node
const value = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : Number(process.argv[index + 1]);
};
const days = value("--days", 30);
const startReady = value("--start-ready", 87);
const duplicateRate = value("--duplicate-rate", 16 / 722);
const poolTarget = value("--pool-target", 5000);
if (!Number.isInteger(days) || days < 1 || !Number.isFinite(startReady) || startReady < 0 || duplicateRate < 0 || duplicateRate >= 1 || poolTarget < 1) throw new Error("invalid simulation input");

const results = [];
for (const collectedDaily of [100, 500, 1000]) {
  for (const sendDaily of [100, 200, 500]) {
    let ready = startReady; let sent = 0; let duplicates = 0; let collected = 0; let collectionDays = 0;
    for (let day = 0; day < days; day += 1) {
      if (ready < poolTarget) {
        const duplicateCount = Math.round(collectedDaily * duplicateRate);
        duplicates += duplicateCount;
        collected += collectedDaily;
        collectionDays += 1;
        ready += collectedDaily - duplicateCount;
      }
      const delivered = Math.min(sendDaily, ready);
      ready -= delivered;
      sent += delivered;
    }
    results.push({ collectedDaily, sendDaily, days, collectionDays, collected, duplicates, duplicateRate, sent, ready });
  }
}
console.log(JSON.stringify({ assumptions: { startReady, poolTarget, duplicateRate, suppressionAndQualityRulesRemainExternal: true }, results }, null, 2));
