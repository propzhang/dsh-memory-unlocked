/**
 * 契约形状测试。
 *
 * 这组测试把 `readTitle` 的三种返回值形状都覆盖一遍,避免只依赖单一契约:
 * 裸字符串、`{ title }` 对象、以及 `{ title: { title } }` 嵌套形状。文档与源码
 * 对形状的描述可能不一致,测试以实际契约形状为准。
 *
 * 实测(宿主检查接口 + 安装包后端)的真实形状是三条不同的调用路径:
 *   readTitle → SessionTitleSnapshot = { title: string, eventSeq, ... }
 *   readTitleSnapshot → { session, title?: SessionTitleSnapshot }
 *   readTitleSnapshots → [{ sessionId, status, value|reason }]
 * 所以这里**三条都测**,并且要求任何意外形状都返回 undefined 而不是抛。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	clampInt,
	extractText,
	normalizeEventWindow,
	normalizeSearchHit,
	normalizeSessionRecord,
	pickTitle,
	pickTitleFromObservation,
	pickTitleFromObservationResult,
	titleMapFromResults
} from "../lib/normalize.js";

test("pickTitle 吃三种形状:裸字符串 / {title} / {title:{title}}", () => {
	assert.equal(pickTitle("会话标题"), "会话标题");
	assert.equal(pickTitle({ title: "会话标题" }), "会话标题");
	assert.equal(pickTitle({ title: { title: "会话标题" } }), "会话标题");
	// 再兜一层(某些后端可能包成 snapshot)
	assert.equal(pickTitle({ snapshot: { title: "会话标题" } }), "会话标题");
});

test("pickTitle 对意外形状返回 undefined,绝不抛", () => {
	for (const value of [undefined, null, 42, [], {}, { title: 42 }, { title: {} }, true]) {
		assert.equal(pickTitle(value), undefined, `输入 ${JSON.stringify(value)} 应为 undefined`);
	}
});

test("pickTitleFromObservation 对应 readTitleSnapshot 的 { session, title? }", () => {
	assert.equal(pickTitleFromObservation({ session: { id: "s1" }, title: { title: "T", eventSeq: 3 } }), "T");
	assert.equal(pickTitleFromObservation({ session: { id: "s1" } }), undefined);   // 无标题事件
	assert.equal(pickTitleFromObservation(undefined), undefined);
});

test("pickTitleFromObservationResult:先看 status,rejected 不炸", () => {
	const fulfilled = {
		sessionId: "s1",
		status: "fulfilled",
		value: { session: { id: "s1" }, title: { title: "真标题", eventSeq: 9 } }
	};
	const rejected = { sessionId: "s2", status: "rejected", reason: new Error("boom") };
	assert.equal(pickTitleFromObservationResult(fulfilled), "真标题");
	assert.equal(pickTitleFromObservationResult(rejected), undefined);   // ★ 不能抛
	assert.equal(pickTitleFromObservationResult({ sessionId: "s3", value: { title: { title: "无状态版本" } } }), "无状态版本");
	assert.equal(pickTitleFromObservationResult(null), undefined);
});

test("titleMapFromResults 折成 Map,失败的会话不进 Map", () => {
	const map = titleMapFromResults([
		{ sessionId: "a", status: "fulfilled", value: { session: { id: "a" }, title: { title: "A" } } },
		{ sessionId: "b", status: "rejected", reason: "x" },
		{ sessionId: "c", status: "fulfilled", value: { session: { id: "c" } } }
	]);
	assert.equal(map.size, 1);
	assert.equal(map.get("a"), "A");
	assert.equal(map.has("b"), false);
	assert.equal(map.has("c"), false);
});

test("normalizeSearchHit ★ 保留 seq(钻取链的命门)", () => {
	const hit = {
		header: { id: "s1", cwd: "C:\\w", createdAt: 1000, origin: "subagent" },
		live: true,
		persisted: false,
		bestMatch: { sessionId: "s1", seq: 42, type: "assistant/message", time: 2000, surface: "current", snippet: "片段" }
	};
	const plain = normalizeSearchHit(hit);
	assert.equal(plain.sessionId, "s1");
	assert.equal(plain.seq, 42, "★ seq 必须被带出来");
	assert.equal(plain.snippet, "片段");
	assert.equal(plain.live, true);
	assert.equal(plain.isSubagent, true);
	// 缺 seq 时是 null 而不是崩溃
	assert.equal(normalizeSearchHit({ header: { id: "s2" }, bestMatch: {} }).seq, null);
});

test("normalizeSessionRecord 只为需要的字段建新对象", () => {
	const record = normalizeSessionRecord({ header: { id: "s", cwd: "C:\\x", createdAt: 5, origin: "subagent" }, live: false, persisted: true });
	assert.deepEqual(record, {
		sessionId: "s", cwd: "C:\\x", createdAt: 5, parentSession: null, isSubagent: true, live: false, persisted: true
	});
});

test("extractText:三种事件形状都能取到文本", () => {
	// user/message:消息就在 data 上
	assert.equal(extractText({ type: "user/message", data: { role: "user", content: [{ type: "text", text: "你好" }] } }), "你好");
	// assistant/message:包一层 data.message
	assert.equal(extractText({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "回复" }] } } }), "回复");
	// tool/result:同样包一层,并且有 tool-call 块
	assert.equal(
		extractText({ type: "tool/result", data: { message: { content: [{ type: "text", text: "结果" }, { type: "tool-call", name: "bash" }] } } }),
		"结果\n[调用工具 bash]"
	);
	// 未知形状 → 空串,绝不抛
	assert.equal(extractText({ type: "session/end-seed", data: { weird: 1 } }), "");
	assert.equal(extractText(undefined), "");
	assert.equal(extractText({ type: "x", data: { text: "兜底 text" } }), "兜底 text");
});

test("normalizeEventWindow 把 readEvent 的窗口拍平(含 startSeq/endSeq)", () => {
	const window = {
		session: { id: "s1" },
		inheritedEventCount: 2,
		startSeq: 5,
		endSeq: 7,
		events: [
			{ sessionId: "s1", seq: 5, type: "user/message", time: 10, surface: "current", data: { content: [{ type: "text", text: "五" }] } },
			{ sessionId: "s1", seq: 6, type: "assistant/message", time: 11, surface: "current", data: { message: { content: [{ type: "text", text: "六" }] } } },
			{ sessionId: "s1", seq: 7, type: "user/message", time: 12, surface: "current", data: { content: [{ type: "text", text: "七" }] } }
		]
	};
	const flat = normalizeEventWindow(window);
	assert.equal(flat.sessionId, "s1");
	assert.equal(flat.startSeq, 5);
	assert.equal(flat.endSeq, 7);
	assert.equal(flat.events.length, 3);
	assert.deepEqual(flat.events.map((event) => event.seq), [5, 6, 7]);
	assert.deepEqual(flat.events.map((event) => event.text), ["五", "六", "七"]);
});

test("clampInt 夹边界,非法值回落", () => {
	assert.equal(clampInt(5, 1, 10, 3), 5);
	assert.equal(clampInt(0, 1, 10, 3), 1);
	assert.equal(clampInt(99, 1, 10, 3), 10);
	assert.equal(clampInt("x", 1, 10, 3), 3);
	assert.equal(clampInt(1.5, 1, 10, 3), 3);
	assert.equal(clampInt(undefined, 1, 10, 3), 3);
});
