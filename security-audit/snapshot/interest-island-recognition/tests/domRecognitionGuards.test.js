import test from "node:test";
import assert from "node:assert/strict";

import {
  isDeterministicDomEmpty,
  shouldRetryDomRecognition
} from "../src/domRecognitionGuards.js";
import { isOrderDetailPanelTextReady, isOrderDetailTextReady, resolveScopedOrderDetail, shouldRetryOrderDetailClick, waitForChanceSearchControls } from "../src/chanceAssDomClient.js";
import { recoverQichatPage } from "../src/qlchatClient.js";
import { QichatDomClient } from "../src/qlchatDomClient.js";

function strictEmptyEntry(overrides = {}) {
  return {
    contextSource: "dom",
    contextOpened: false,
    relatedRecords: 0,
    invalidContext: false,
    domPersonListRefreshed: true,
    domPersonIdentityVerified: true,
    domCandidateAttemptDetails: [{
      personText: "张爽 @兴趣岛",
      personMatchLevel: 1,
      personClickSucceeded: true,
      selectedPersonVerified: true,
      keywords: [{
        keyword: "投诉",
        formVerified: true,
        queryClicked: true,
        resultTerminal: true,
        relatedRecords: 0
      }]
    }],
    ...overrides
  };
}

test("全部身份和查询终态验证通过时仍不接受零结果为业务终态", () => {
  const entry = strictEmptyEntry();
  assert.equal(isDeterministicDomEmpty(entry), false);
  assert.equal(shouldRetryDomRecognition(entry), true);
});

test("错误人员得到零条不能作为确定性空结果", () => {
  const entry = strictEmptyEntry({
    domCandidateAttemptDetails: [{
      personText: "短视频-小盈老师33 @兴趣岛",
      personMatchLevel: 0,
      personClickSucceeded: true,
      selectedPersonVerified: true,
      keywords: [{
        keyword: "投诉",
        formVerified: true,
        queryClicked: true,
        resultTerminal: true,
        relatedRecords: 0
      }]
    }]
  });
  assert.equal(isDeterministicDomEmpty(entry), false);
  assert.equal(shouldRetryDomRecognition(entry), true);
});

test("查询结果没有进入明确终态时必须重跑", () => {
  const entry = strictEmptyEntry();
  entry.domCandidateAttemptDetails[0].keywords[0].resultTerminal = false;
  assert.equal(isDeterministicDomEmpty(entry), false);
  assert.equal(shouldRetryDomRecognition(entry), true);
});

test("查到相关记录但右侧未打开时必须重跑", () => {
  const entry = strictEmptyEntry({ relatedRecords: 1 });
  assert.equal(shouldRetryDomRecognition(entry), true);
});

test("右侧已打开但会话用户ID未验证时按无效上下文重跑", () => {
  const entry = strictEmptyEntry({
    contextOpened: true,
    relatedRecords: 1,
    domSelectedPersonVerified: true,
    domConversationUserIdVerified: false,
    domQueryFormVerified: true,
    domQueryResultTerminal: true,
    domRightBubbleVerified: true
  });
  assert.equal(shouldRetryDomRecognition(entry), true);
});

test("人员、用户ID、查询和右侧气泡全部验证后不重跑", () => {
  const entry = strictEmptyEntry({
    contextOpened: true,
    relatedRecords: 1,
    domSelectedPersonVerified: true,
    domConversationUserIdVerified: true,
    domQueryFormVerified: true,
    domQueryResultTerminal: true,
    domRightBubbleVerified: true
  });
  assert.equal(shouldRetryDomRecognition(entry), false);
});

test("订单详情中所属品类位于订单信息区域时写入 S", () => {
  const result = resolveScopedOrderDetail({
    expectedOrderId: "9000000778949211",
    roots: [{
      panelOrderId: "9000000778949211",
      productSectionFound: false,
      fields: [
        { section: "订单信息", label: "主订单ID", value: "9000000778949211" },
        { section: "订单信息", label: "所属品类", value: "太极" }
      ]
    }]
  });
  assert.equal(result.category, "太极");
});

test("订单详情不含商品信息标题但有当前订单所属品类时视为已就绪", () => {
  assert.equal(isOrderDetailTextReady({
    expectedOrderId: "9000000778949211",
    text: "订单信息 主订单ID：9000000778949211 商品名称：静坐内观 所属品类：太极"
  }), true);
});

test("订单详情不含任何分区标题但有当前订单所属品类时视为已就绪", () => {
  assert.equal(isOrderDetailTextReady({
    expectedOrderId: "9000000778949211",
    text: "主订单ID：9000000778949211 所属品类：太极"
  }), true);
});

test("详情框已出现但所属品类仍在加载时不得再次点击", () => {
  assert.equal(isOrderDetailPanelTextReady({
    expectedOrderId: "9000000778949211",
    text: "主订单ID：9000000778949211 商品名称：静坐内观"
  }), true);
});

test("不含分区标题的当前订单详情容器可读取所属品类", () => {
  const result = resolveScopedOrderDetail({
    expectedOrderId: "9000000789293167",
    roots: [{
      panelOrderId: "9000000789293167",
      orderIds: ["9000000789293167"],
      fields: [
        { label: "主订单ID", value: "9000000789293167" },
        { label: "所属品类", value: "健康食养" }
      ]
    }]
  });
  assert.equal(result.category, "健康食养");
});

test("详情容器混入其他订单ID时不得写入所属品类", () => {
  const result = resolveScopedOrderDetail({
    expectedOrderId: "9000000789293167",
    roots: [{
      panelOrderId: "9000000789293167",
      orderIds: ["9000000789293167", "9000000789293168"],
      fields: [
        { label: "主订单ID", value: "9000000789293167" },
        { label: "所属品类", value: "健康食养" }
      ]
    }]
  });
  assert.equal(result.category, "");
});

test("仅坐标点击但未验证详情打开时必须继续尝试", () => {
  assert.equal(shouldRetryOrderDetailClick({
    domClickTriggered: true,
    detailOpened: false
  }), true);
});

test("机会管理筛选器在 FineBI 重绘期间暂不可见时应等待到可定位", async () => {
  let calls = 0;
  const delays = [];
  const controls = await waitForChanceSearchControls({
    findControls: async () => {
      calls += 1;
      return calls === 3 ? { inputId: "user-id", modeId: "identity", queryId: "query" } : null;
    },
    sleep: async (ms) => { delays.push(ms); },
    attempts: 4,
    delayMs: 100
  });
  assert.deepEqual(controls, { inputId: "user-id", modeId: "identity", queryId: "query" });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 100]);
});

test("机会管理筛选器已出现但用户ID模式尚未就绪时继续等待重绘", async () => {
  let finds = 0;
  let validations = 0;
  const delays = [];
  const controls = await waitForChanceSearchControls({
    findControls: async () => ({ inputId: `user-id-${finds += 1}`, modeId: "identity", queryId: "query" }),
    acceptControls: async () => {
      validations += 1;
      return validations === 3;
    },
    sleep: async (ms) => { delays.push(ms); },
    attempts: 4,
    delayMs: 100
  });
  assert.deepEqual(controls, { inputId: "user-id-3", modeId: "identity", queryId: "query" });
  assert.equal(finds, 3);
  assert.equal(validations, 3);
  assert.deepEqual(delays, [100, 100]);
});

test("恢复查询页时优先复用现有业务页面", async () => {
  const calls = [];
  const stalePage = {
    isClosed: () => false,
    close: async () => calls.push("close"),
    setDefaultTimeout: () => calls.push("timeout"),
    goto: async () => calls.push("goto")
  };
  const page = {
    setDefaultTimeout: () => calls.push("timeout"),
    goto: async () => calls.push("goto")
  };
  const result = await recoverQichatPage({
    context: { newPage: async () => { calls.push("newPage"); return page; } },
    currentPage: stalePage,
    url: "https://example.test/workWechat/chatRecordPlatform",
    timeoutMs: 30000,
    isReady: async () => { calls.push("ready"); return true; }
  });
  assert.equal(result.ok, true);
  assert.equal(result.stage, "ready");
  assert.equal(result.reused, true);
  assert.deepEqual(calls, ["timeout", "goto", "ready"]);
});

test("聊天页恢复失败时保留失败阶段而不误报已恢复", async () => {
  let rejectWork;
  const client = {
    config: { ui: { rowHardTimeoutMs: 100 } },
    fetchContext: () => new Promise((_, reject) => { rejectWork = reject; }),
    abortCurrentPage: async () => rejectWork(new Error("page closed")),
    recoverPage: async () => ({ ok: false, stage: "navigate", error: "导航失败" })
  };
  const result = await new QichatDomClient(client).fetchContext({ rowNumber: 8 });
  assert.equal(result.chatPageReset.readyAfter, false);
  assert.equal(result.chatPageReset.recoveryStage, "navigate");
  assert.match(result.error, /页面恢复失败/);
});
