import { BrowserClient } from "../src/browserClient.js";
import { loadConfig } from "../src/config.js";
import { createDebugLogger } from "../src/logger.js";
import { UserOverviewService } from "../src/userOverviewService.js";
import { publicConsistencyResult, publicConsistencySummary } from "../src/complaintConsistencyOutput.js";

const ownerId = String(process.argv[2] || "").trim();
const userIds = String(process.argv[3] || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!ownerId || userIds.length === 0) {
  console.error("用法：node scripts/validate-complaint-consistency.mjs <网站用户ID> <用户ID1,用户ID2,...>");
  process.exit(2);
}

const config = loadConfig(process.env.CONFIG || "config/default.json");
const browserClient = new BrowserClient(config);
const logger = createDebugLogger(config);
const service = new UserOverviewService({ config, browserClient, logger });
const results = [];

try {
  for (const userId of userIds) {
    const complaintOnly = await service.fetchOverview({ userId, mode: "complaint" }, ownerId);
    const all = await service.fetchOverview({ userId, mode: "all" }, ownerId);
    const complaintOnlySummary = summarize(complaintOnly, userId);
    const allSummary = summarize(all, userId);
    const consistent = complaintOnlySummary.count === allSummary.count
      && complaintOnlySummary.technicalFailure === allSummary.technicalFailure
      && complaintOnlySummary.userIdMatched === allSummary.userIdMatched
      && complaintOnlySummary.isolatedPage
      && allSummary.isolatedPage;

    const item = { consistent, complaintOnly: complaintOnlySummary, all: allSummary };
    results.push(item);
    console.log(JSON.stringify(publicConsistencyResult(results.length, consistent, complaintOnlySummary, allSummary)));
  }
} finally {
  await browserClient.close().catch(() => {});
}

const summary = publicConsistencySummary(results);
console.log(JSON.stringify(summary));
if (summary.failed > 0) process.exitCode = 1;

function summarize(result, expectedUserId) {
  const complaints = Array.isArray(result?.overview?.complaints) ? result.overview.complaints : [];
  const diagnostics = result?.overview?.complaintSummary?.diagnostics || {};
  const resultIds = collectUserIds(complaints);
  const userIdMatched = diagnostics.complaintResultUserIdMatched === true
    || complaints.length === 0
    || resultIds.size === 0
    || [...resultIds].every((value) => value === expectedUserId);
  return {
    count: complaints.length,
    isolatedPage: diagnostics.complaintPageIsolated === true,
    filterPairFound: diagnostics.complaintFilterPairFound === true,
    userIdStable: diagnostics.complaintUserIdStable === true,
    queryClicked: diagnostics.complaintQueryClicked === true,
    resultChanged: diagnostics.complaintResultChanged === true,
    userIdMatched,
    technicalFailure: diagnostics.technicalFailure === true
  };
}

function collectUserIds(value, output = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectUserIds(item, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, item] of Object.entries(value)) {
    if (/user.?id/i.test(key) && item !== null && item !== undefined) {
      const normalized = String(item).trim().replace(/\.0$/, "");
      if (normalized) output.add(normalized);
      continue;
    }
    collectUserIds(item, output);
  }
  return output;
}
