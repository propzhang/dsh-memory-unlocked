/**
 * 触发词检索词的句末边界 —— 中文全角问号 `？`(U+FF1F)的边界测试。
 *
 * `firstSentenceAfter` 的句末字符类是 `[。!?！？;；]`,同时覆盖 ASCII `?` 与 U+FF1F。
 * 因此 `大记忆恢复术 发布脚本在哪？后面还有一段` 的检索词是 `发布脚本在哪`,
 * 而不是整段 `发布脚本在哪？后面还有一段`。
 *
 * 本文件锁定四件事:
 *   ① `？` 与 ASCII `?` 在句末边界上**等价**;
 *   ② 只取**第一句/第一行**,后面的内容不得进入检索词;
 *   ③ 触发词后**只有**句末标点时回落为空检索词(按"没有关键词"处理);
 *   ④ 英文点不参与切分:`deploy.ps1`、`/opt/release/publish.sh` 不被误截。
 *
 * 另加两条**真实插件**路径的端到端断言:
 *   · 正配对:历史里真的含精确检索词 `发布脚本在哪` ⇒ 自动回顾能定位到路径;
 *   · 负向能力边界:历史只有 `发布脚本在 /opt/...` 时,自然问句 `发布脚本在哪`
 *     **不是**它的子串 ⇒ 0 命中。这是词法/语义限制,边界本身按预期保留。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";
import { INJECTED_ID_PREFIX, findTrigger, firstSentenceAfter } from "../lib/recall.js";
import { fakeCtx, fakeSessionQuery, sessionRecord, userMessage } from "./helpers.mjs";

const ME = "sess-current-boundary";
const CWD = "C:\\work";
const AGENT = { id: ME, session: { header: { id: ME, cwd: CWD } } };

/**
 * 假的后端:索引禁用(强制扫描兜底),只有一个会话、一条历史事件。
 * 文本匹配按**子串**(对插件最有利的扫描语义;真实宿主可能是 FTS token 匹配)。
 */
function historyQuery(historyText) {
	const events = [{ sessionId: ME, seq: 5, type: "user/message", time: 1000, surface: "shadowed", text: historyText }];
	const fake = fakeSessionQuery({
		async searchSessions(request) {
			fake.calls.searchSessions.push(request);
			const error = new Error("full-text search disabled");
			error.code = "SESSION_QUERY_SEARCH_DISABLED";
			throw error;
		},
		async listSessions() {
			fake.calls.listSessions += 1;
			return [sessionRecord(ME, { cwd: CWD })];
		},
		async filterEvents(sessionId, filters) {
			fake.calls.filterEvents.push({ sessionId, filters });
			const text = filters?.find((filter) => filter?.kind === "text")?.text;
			if (typeof text !== "string") return [];
			return events.filter((event) => event.sessionId === sessionId && event.text.includes(text));
		}
	});
	return fake;
}

/** 走真实 `apply()` + 真实 `agent/pre-step` 监听器,只替换 `ctx.sessionQuery`。 */
async function autoInject(fake, message, turn = 1) {
	const { ctx, listeners } = fakeCtx({ sessionQuery: fake.sq });
	apply(ctx, {});
	const listener = listeners.get("agent/pre-step");
	assert.equal(typeof listener, "function", "pre-step 监听器必须注册");
	const decision = { kind: "enter", messages: [userMessage(message)] };
	const out = await listener({ messages: decision.messages, agent: AGENT, turn, signal: undefined }, async () => decision);
	const injected = out.messages.filter((item) => typeof item?.id === "string" && item.id.startsWith(INJECTED_ID_PREFIX));
	return {
		injected,
		text: injected.length > 0 ? String(injected[injected.length - 1]?.content?.[0]?.text ?? "") : ""
	};
}

/* ------------------------------------------------------------------ *
 * ① 全角问号 / ASCII 问号等价
 * ------------------------------------------------------------------ */

test("★ 全角问号 U+FF1F 与 ASCII ? 等价地结束检索词", () => {
	assert.equal(firstSentenceAfter(" 发布脚本在哪？后面还有一段不该进查询的话"), "发布脚本在哪");
	assert.equal(firstSentenceAfter(" 发布脚本在哪?后面还有一段不该进查询的话"), "发布脚本在哪");
	assert.equal(
		firstSentenceAfter(" 发布脚本在哪？后面"),
		firstSentenceAfter(" 发布脚本在哪?后面"),
		"同一位置的全角/半角问号必须切出同一个检索词"
	);
});

/* ------------------------------------------------------------------ *
 * ② 第一句 + 多行
 * ------------------------------------------------------------------ */

test("★ 只取第一句:问号后的同行文字与下一行都不得进入检索词", () => {
	assert.equal(firstSentenceAfter(" 上次部署脚本在哪？\n顺便看看备份"), "上次部署脚本在哪");
	assert.equal(firstSentenceAfter(" 上次部署脚本在哪？顺便看看备份"), "上次部署脚本在哪");
	assert.equal(firstSentenceAfter(" 第一行没有句末标点\n第二行也不该进查询"), "第一行没有句末标点");
});

/* ------------------------------------------------------------------ *
 * ③ 只有问号 ⇒ 空检索词
 * ------------------------------------------------------------------ */

test("★ 触发词后只有句末标点 ⇒ 检索词为空(按没有关键词处理)", () => {
	assert.equal(firstSentenceAfter(" ？"), "");
	assert.equal(firstSentenceAfter(" ？！"), "");
	assert.equal(firstSentenceAfter(" 。？!！;；"), "");
	assert.equal(findTrigger([userMessage("大记忆恢复术 ？")]).keyword, "", "只有问号时不能把标点当关键词");
	assert.equal(findTrigger([userMessage("大记忆恢复术 ？后面还有一段")]).keyword, "", "问号后的正文也不得成为关键词");
});

/* ------------------------------------------------------------------ *
 * ④ 英文点不参与切分
 * ------------------------------------------------------------------ */

test("★ `deploy.ps1` 与路径不被英文点误截(只切句末标点,不切 `.`)", () => {
	assert.equal(firstSentenceAfter(" 部署脚本 deploy.ps1 在哪？继续"), "部署脚本 deploy.ps1 在哪");
	assert.equal(firstSentenceAfter(" 部署脚本 deploy.ps1 在哪?继续"), "部署脚本 deploy.ps1 在哪");
	assert.equal(firstSentenceAfter(" 请运行 deploy.ps1 然后重启"), "请运行 deploy.ps1 然后重启");
	assert.equal(firstSentenceAfter(" 脚本在 /opt/release/publish.sh？之后"), "脚本在 /opt/release/publish.sh");
	assert.equal(firstSentenceAfter(" 脚本在 /opt/release/publish.sh 之后"), "脚本在 /opt/release/publish.sh 之后");
});

/* ------------------------------------------------------------------ *
 * ⑤ 真实插件端到端:正配对
 * ------------------------------------------------------------------ */

test("★ 真实插件 auto 正配对:历史含精确检索词时,`？` 被截断而不进入检索词", async () => {
	// 历史里真的含 `发布脚本在哪`(后面跟一个 ASCII ? 只是正文),这是"精确查询"的正配对。
	const fake = historyQuery("发布脚本在哪? 在 /opt/release/publish.sh");
	const result = await autoInject(fake, "大记忆恢复术 发布脚本在哪？");
	assert.equal(result.injected.length, 1, "触发词应注入一条回顾消息");
	assert.ok(result.text.includes("查询:「发布脚本在哪」"), `检索词必须已去掉全角问号,实际:\n${result.text}`);
	assert.equal(result.text.includes("查询:「发布脚本在哪？」"), false, "检索词不得带着 U+FF1F");
	assert.ok(result.text.includes("/opt/release/publish.sh"), "正配对必须能定位到历史里的路径");
});

/* ------------------------------------------------------------------ *
 * ⑥ 真实插件端到端:自然问句 ≠ 关键词(负向能力边界)
 * ------------------------------------------------------------------ */

test("★ 真实插件 auto 负向边界:历史只有路径时,自然问句仍 0 命中(词法限制)", async () => {
	const fake = historyQuery("发布脚本在 /opt/release/publish.sh");
	const result = await autoInject(fake, "大记忆恢复术 发布脚本在哪？");
	assert.equal(result.injected.length, 1, "即使 0 命中,自动回顾也应如实注入一条「没有命中」");
	assert.ok(result.text.includes("没有命中的片段"), "0 命中要如实披露");
	assert.equal(result.text.includes("/opt/release/publish.sh"), false, "历史里的路径不得凭空出现");
	// 去掉 `？` 只影响标点切分;`发布脚本在哪` 仍不是 `发布脚本在 /opt/...` 的子串,
	// 那需要查询归一化/多词 OR/语义检索,不属于标点边界这条路径。
	assert.equal(firstSentenceAfter(" 发布脚本在哪？"), "发布脚本在哪");
});
