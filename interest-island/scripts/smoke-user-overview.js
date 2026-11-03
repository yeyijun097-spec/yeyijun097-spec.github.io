import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractAllOrderDetails } from "../src/userOverviewService.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultFixturePath = resolve(scriptDirectory, "../tests/fixtures/long-order-dom.html");
const failureFixturePath = resolve(scriptDirectory, "../tests/fixtures/order-detail-failure.json");

function readAttributes(openingTag) {
  return Object.fromEntries(
    [...openingTag.matchAll(/\s(data-[\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value])
  );
}

export function parseLongOrderDom(html) {
  return [...html.matchAll(/<article\b[^>]*class="[^"]*\border-row\b[^"]*"[^>]*>/g)]
    .map(([openingTag]) => readAttributes(openingTag))
    .map((attributes) => ({
      orderId: attributes["data-order-id"] || "",
      productName: attributes["data-product-name"] || "",
      productType: attributes["data-product-type"] || "",
      time: attributes["data-order-time"] || "",
      layout: attributes["data-layout"] || "",
      detailState: attributes["data-detail-state"] || "ready",
      sourceScrollTop: Number(attributes["data-scroll-top"] || 0),
      virtualIndex: Number(attributes["data-virtual-index"] || 0)
    }))
    .sort((left, right) => left.virtualIndex - right.virtualIndex);
}

export async function runFixtureQuery(fixturePath = defaultFixturePath, { count } = {}) {
  const resolvedFixturePath = resolve(process.cwd(), fixturePath);
  const [html, failureFixture] = await Promise.all([
    readFile(resolvedFixturePath, "utf8"),
    readFile(failureFixturePath, "utf8")
  ]);
  const candidates = parseLongOrderDom(html).slice(0, count);
  const failures = new Map(JSON.parse(failureFixture).failures.map((failure) => [failure.orderId, failure]));
  const activeVirtualWindows = new Set();
  const page = { waitForTimeout: async () => {} };

  return extractAllOrderDetails(page, { ui: { afterClickWaitMs: 0 } }, {}, candidates, [], {
    includeRefunds: false,
    returnToOrderList: async ({ candidate }) => {
      activeVirtualWindows.add(candidate.sourceScrollTop);
      return true;
    },
    openOrderDetail: async ({ candidate }) => {
      const failure = failures.get(candidate.orderId);
      if (failure || !activeVirtualWindows.has(candidate.sourceScrollTop)) return { opened: false };
      return {
        opened: true,
        snapshot: {
          matched: true,
          productName: candidate.productName,
          text: `订单详情 订单信息 商品信息 主订单ID：${candidate.orderId} 商品名称：${candidate.productName} 下单时间：${candidate.time} 字段布局：${candidate.layout}`,
          pairs: []
        }
      };
    },
    probeOrderDetailOpen: async ({ candidate }) => ({
      reason: failures.get(candidate.orderId)?.reason || "详情抽屉未打开"
    }),
    logger: { writeJson: () => "tests/fixtures/order-detail-failure.json" }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = await runFixtureQuery(defaultFixturePath, { count: 28 });
  const failures = rows.filter((row) => !row.detailOpened);
  console.log(`订单冒烟完成：${rows.length} 条，失败 ${failures.length} 条`);
  for (const row of failures) console.log(`${row.orderId}: ${row.error}`);
}
