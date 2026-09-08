import test from "node:test";
import assert from "node:assert/strict";

import {
  decideQueryResultTerminal,
  isQichatQueryPageReady,
  isMeaningfulMiddleRecordText,
  isStablePersonSnapshot,
  matchPersonIdentity
} from "../src/qlchatClient.js";
import { resolveContextHeartbeatStage } from "../src/qlchatDomClient.js";
import { resolveRowHardTimeoutMs } from "../src/qlchatDomClient.js";

test("未明确配置时不使用60秒整行强制中断", () => {
  assert.equal(resolveRowHardTimeoutMs({}), 0);
  assert.equal(resolveRowHardTimeoutMs({ ui: {} }), 0);
});

test("显式配置整行超时时仍保留该保护", () => {
  assert.equal(resolveRowHardTimeoutMs({ ui: { rowHardTimeoutMs: 90000 } }), 90000);
});

test("心跳优先显示客户端当前真实阶段", () => {
  assert.equal(resolveContextHeartbeatStage({
    getProgressStage: () => "等待查询结果（候选 2/3）"
  }), "等待查询结果（候选 2/3）");
});

test("客户端未报告阶段时使用上下文流程默认文案", () => {
  assert.equal(resolveContextHeartbeatStage({}), "正在读取聊天上下文");
});

test("页面仅有标题文字但查询控件未加载时不得通过登录预检", () => {
  assert.equal(isQichatQueryPageReady({
    bodyText: "私聊记录 关键词 查询",
    personInputVisible: false,
    keywordInputVisible: false,
    searchButtonVisible: false
  }), false);
});

test("人员、关键词和查询按钮全部可用时通过登录预检", () => {
  assert.equal(isQichatQueryPageReady({
    bodyText: "私聊记录 关键词 查询",
    personInputVisible: true,
    keywordInputVisible: true,
    searchButtonVisible: true
  }), true);
});

test("当前用户会话卡片出现后可以立即确认查询成功", () => {
  assert.deepEqual(decideQueryResultTerminal({
    elapsedMs: 200,
    currentUserMatched: true,
    relatedRecords: 1
  }), { terminal: true, kind: "current-user-records" });
});

test("无关用户的相关记录不能冒充当前查询结果", () => {
  assert.equal(decideQueryResultTerminal({
    elapsedMs: 2000,
    currentUserMatched: false,
    relatedRecords: 4
  }).terminal, false);
});

test("瞬时空结果不能在96毫秒内被误判为明确0条", () => {
  assert.equal(decideQueryResultTerminal({
    elapsedMs: 96,
    explicitEmpty: true,
    emptyStableHits: 1,
    resultChanged: true
  }).terminal, false);
});

test("空结果稳定1.5秒仍不能作为候选终态", () => {
  assert.equal(decideQueryResultTerminal({
    elapsedMs: 1500,
    explicitEmpty: true,
    emptyStableHits: 3,
    resultChanged: true
  }).terminal, false);
});

test("空结果稳定6秒后只作为当前候选失败终态", () => {
  assert.deepEqual(decideQueryResultTerminal({
    elapsedMs: 6000,
    explicitEmpty: true,
    emptyStableHits: 5,
    resultChanged: true
  }), { terminal: true, kind: "candidate-empty" });
});

test("旧页面空态未刷新时等待超过6秒也不能作为候选终态", () => {
  assert.equal(decideQueryResultTerminal({
    elapsedMs: 8000,
    explicitEmpty: true,
    emptyStableHits: 20,
    resultChanged: false
  }).terminal, false);
});

test("用户ID校验提示出现时不能把页面判为查询终态", () => {
  assert.equal(decideQueryResultTerminal({
    elapsedMs: 2000,
    explicitEmpty: true,
    emptyStableHits: 5,
    validationError: true
  }).terminal, false);
});

test("人员姓名完全一致时使用一级匹配", () => {
  const result = matchPersonIdentity("健康吃瘦-书林老师", "健康吃瘦-书林老师 @兴趣岛");
  assert.equal(result.matchLevel, 1);
});

test("去除老师等角色后缀后可以匹配", () => {
  const result = matchPersonIdentity("陈玄威老师", "陈玄威 @兴趣岛");
  assert.equal(result.matchLevel, 2);
});

test("同名前缀候选可以作为最后一级候选", () => {
  const result = matchPersonIdentity("谭广飞", "谭广 @兴趣岛");
  assert.equal(result.matchLevel, 3);
});

test("上一行无关人员必须拒绝点击", () => {
  const result = matchPersonIdentity("张爽", "短视频-小盈老师33 @兴趣岛");
  assert.equal(result.matchLevel, 0);
});

test("人员列表签名未变化时不能通过刷新闸门", () => {
  assert.equal(isStablePersonSnapshot({
    beforeSignature: "小盈老师",
    afterSignature: "小盈老师",
    candidates: [{ text: "张爽" }],
    stableHits: 3
  }), false);
});

test("连续行是同一人员时允许稳定的当前身份通过刷新闸门", () => {
  assert.equal(isStablePersonSnapshot({
    beforeSignature: "张爽 @兴趣岛",
    afterSignature: "张爽 @兴趣岛",
    expectedName: "张爽",
    candidates: [{ text: "张爽 @兴趣岛" }],
    stableHits: 3
  }), true);
});

test("列表签名未变化时无关人员仍不能通过刷新闸门", () => {
  assert.equal(isStablePersonSnapshot({
    beforeSignature: "小盈老师 @兴趣岛",
    afterSignature: "小盈老师 @兴趣岛",
    expectedName: "张爽",
    candidates: [{ text: "小盈老师 @兴趣岛" }],
    stableHits: 3
  }), false);
});

test("新人员列表连续稳定三次后才通过刷新闸门", () => {
  assert.equal(isStablePersonSnapshot({
    beforeSignature: "小盈老师",
    afterSignature: "张爽",
    candidates: [{ text: "张爽" }],
    stableHits: 2
  }), false);
  assert.equal(isStablePersonSnapshot({
    beforeSignature: "小盈老师",
    afterSignature: "张爽",
    candidates: [{ text: "张爽" }],
    stableHits: 3
  }), true);
});

test("中间栏省略栏头时，时间戳和当前关键词正文仍能确认记录已展开", () => {
  const text = [
    "撒娇的女孩",
    "2026-07-16 18:44:47",
    "不要再群发广告给我了，你发一次，我投诉一次"
  ].join("\n");
  assert.equal(isMeaningfulMiddleRecordText(text, "投诉"), true);
});

test("中间栏没有时间戳时不能仅凭关键词判定已展开", () => {
  assert.equal(isMeaningfulMiddleRecordText("关键词：投诉 查询", "投诉"), false);
});

test("中间栏旧关键词记录不能冒充当前查询结果", () => {
  const text = [
    "2026-07-16 18:44:47",
    "已经申请退款，请等待处理"
  ].join("\n");
  assert.equal(isMeaningfulMiddleRecordText(text, "投诉"), false);
});
