/**
 * 预算模块的**确定性**断言。
 *
 * ★ 刻意**不**断言墙钟(不写 `elapsed < 150 ms` 这类 CI 噪声):
 *   时间预算用可注入的 `now`,条数/字符上界用计数,让出次数用计数器 ——
 *   这些在任何机器上都取同一个值。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	AUTO_BUDGET_MS,
	BUDGET_ERROR_NAME,
	COMPACT_MAX_DOCS,
	COMPACT_MAX_SOURCE_CHARS,
	COMPACT_TAIL_WINDOW,
	TOOL_BUDGET_MS,
	createBudget
} from "../lib/budget.js";
import { createRedactionContext, publish } from "../lib/publish.js";

test("时间预算:可注入单调时钟;到期不抛错(由循环收尾)", () => {
	let clock = 0;
	const budget = createBudget({ deadlineMs: 100, now: () => clock });
	assert.equal(budget.timeExpired(), false);
	assert.equal(budget.remainingMs(), 100);
	clock = 99;
	assert.equal(budget.timeExpired(), false);
	clock = 100;
	assert.equal(budget.timeExpired(), true);
	assert.equal(budget.remainingMs(), 0);
	assert.equal(budget.shouldStop(), "time");
	// ★ 时间到期**不抛**:已经算好的部分结果还要带标注发布。
	assert.doesNotThrow(() => budget.check());
});

test("确定性上界:条数与源字符数都与机器速度无关", () => {
	const budget = createBudget({ maxDocs: 2, maxSourceChars: 10 });
	assert.equal(budget.admit(4), true);
	assert.equal(budget.admit(6), true);
	assert.equal(budget.admit(1), false, "第三条必须被拒(与耗时无关)");
	assert.deepEqual([budget.stats().docs, budget.stats().chars], [2, 10]);
	assert.equal(budget.stats().stoppedBy, "docs");

	const chars = createBudget({ maxDocs: 10, maxSourceChars: 5 });
	assert.equal(chars.admit(6), false);
	assert.equal(chars.stats().stoppedBy, "chars");
	assert.equal(chars.stats().docs, 0, "被拒的文档不计数,也不消耗字符额度");
	assert.equal(chars.admit(5), true);
});

test("末尾窗口可越过条数上限,但源字符上限仍然生效", () => {
	const budget = createBudget({ maxDocs: 1, maxSourceChars: 10 });
	assert.equal(budget.admit(1), true);
	assert.equal(budget.admit(1), false);
	assert.equal(budget.admit(1, { ignoreDocCap: true }), true, "末尾窗口越过条数上限");
	assert.equal(budget.admit(100, { ignoreDocCap: true }), false, "但不越过源字符上限");
	// 总上界 = maxDocs + 固定窗口 ⇒ 仍是确定性常量
	assert.ok(COMPACT_TAIL_WINDOW > 0 && Number.isInteger(COMPACT_TAIL_WINDOW));
});

test("取消/封存:check 抛错,发布闸门只拦封存", () => {
	const controller = new AbortController();
	const budget = createBudget({ signal: controller.signal });
	assert.doesNotThrow(() => budget.check());
	controller.abort();
	assert.equal(budget.shouldStop(), "signal");
	assert.throws(() => budget.check(), (error) => error.name === BUDGET_ERROR_NAME && error.reason === "signal");
	// ★ 已被取消、但结果尚未返回:带中止标注的部分结果**仍然要发布**(既有语义)。
	assert.doesNotThrow(() => budget.assertPublishable());
	budget.seal();
	assert.throws(() => budget.assertPublishable(), (error) => error.reason === "sealed");
	assert.throws(() => budget.check(), (error) => error.reason === "sealed");
});

test("预算错误消息绝不回显调用方数据(signal.reason)", () => {
	const controller = new AbortController();
	controller.abort(new Error("password=SYNTHETIC-SECRET-9x"));
	const budget = createBudget({ signal: controller.signal, label: "recall_history" });
	assert.throws(() => budget.check(), (error) => {
		assert.equal(String(error.message).includes("SYNTHETIC-SECRET"), false);
		return true;
	});
});

test("yieldNow:让出次数可数;封存后拒绝继续让出", async () => {
	let yields = 0;
	const budget = createBudget({ yieldFn: async () => { yields += 1; } });
	await budget.yieldNow();
	await budget.yieldNow();
	assert.equal(yields, 2);
	assert.equal(budget.stats().yields, 2);
	budget.seal();
	await assert.rejects(() => budget.yieldNow(), (error) => error.reason === "sealed");
});

test("封存后:发布与脱敏都不再产出,统计也不再变化", () => {
	const budget = createBudget();
	const redaction = createRedactionContext({ budget });
	redaction.text("password=SYNTHETIC-ONE");
	const before = redaction.snapshot();
	assert.equal(before.count, 1);

	budget.seal();
	assert.throws(() => redaction.text("password=SYNTHETIC-TWO"), (error) => error.reason === "sealed");
	assert.throws(() => publish("正文", { budget }), (error) => error.reason === "sealed");
	assert.deepEqual(redaction.snapshot(), before, "封存之后统计不得再变(第二次 text 在脱敏前就被拒)");
	// 失败提示走**另一份**不带预算的 context:失败信息仍然能发布(工具语义要求)。
	assert.ok(publish("提示", { kind: "notice" }).text.length > 0);
});

test("常量契约:自动 8s < 工具 20s,上界均为正", () => {
	assert.equal(AUTO_BUDGET_MS, 8000);
	assert.equal(TOOL_BUDGET_MS, 20000);
	assert.ok(AUTO_BUDGET_MS < TOOL_BUDGET_MS);
	assert.ok(COMPACT_MAX_DOCS > 0);
	assert.ok(COMPACT_MAX_SOURCE_CHARS > 0);
});

test("零截止(deadlineMs: 0)在第一次检查前就已过期", () => {
	const budget = createBudget({ deadlineMs: 0 });
	assert.equal(budget.timeExpired(), true);
	assert.equal(budget.shouldStop(), "time");
	assert.equal(budget.remainingMs(), 0);
});
