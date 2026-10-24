/**
 * ★ 工作区范围 + 「被 compaction 挤掉的部分」—— 本插件的两项核心行为。
 *
 * 为什么单独立一个文件:`scope.test.mjs` 里的假 agent **故意不带 `session.header.cwd`**
 * (那是"拿不到 cwd"的对抗性用例),于是那些用例跑的是**退化模式**。
 * 它们仍然有效 —— 退化模式的范围比工作区**更窄**,断言一条都不该松 ——
 * 但它们**覆盖不到工作区这一层**,所以这里给 agent 带上 cwd 专门测。
 *
 * 本文件要守住的三件事:
 *   ① 范围 = 当前工作区(请求带 cwd 过滤器;扫描只碰同工作区的会话);
 *   ② **别的会话一律拒绝,而且要拒绝得干净**(不读、不回显);
 *   ③ 无关键词 / 不给 seq ⇒ 给"被 compaction 挤掉的部分",**不给本来就在上下文里的最近几条**。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";
import { DEFAULT_CONFIG, findTrigger, isInjectedMessage } from "../lib/recall.js";
import { isSelfToolCallDoc } from "../lib/search.js";
import { fakeCtx, fakeSessionQuery, sessionRecord, userMessage } from "./helpers.mjs";

const ME = "sess-current";
const SIBLING = "sess-same-workspace";
const STRANGER = "sess-other-workspace";
const SUBAGENT = "sess-subagent-in-workspace";
const CWD = "C:\\work\\project";

/** ★ 带 cwd 的 agent —— 这一层测试的关键(没它就只能测退化模式)。 */
const AGENT = { id: ME, session: { header: { id: ME, cwd: CWD } } };
/** 没有 cwd 的 agent:`SessionHeader.cwd` 是可选字段,必须能安全退化。 */
const AGENT_NO_CWD = { id: ME };

function setup({ config = {}, sessionQuery } = {}) {
	const { ctx, tools } = fakeCtx({ sessionQuery });
	apply(ctx, config);
	return { tools };
}

/* ------------------------------------------------------------------ *
 * ① 工作区范围
 * ------------------------------------------------------------------ */

test("★ 关键词检索:请求带 cwd 过滤器,扫描只解压同工作区、非子代理的会话", async () => {
	const fake = fakeSessionQuery({
		async searchSessions(request) { fake.calls.searchSessions.push(request); return { items: [] }; },
		async listSessions() {
			fake.calls.listSessions += 1;
			return [
				sessionRecord(ME, { cwd: CWD }),
				sessionRecord(SIBLING, { cwd: CWD }),
				sessionRecord(SUBAGENT, { cwd: CWD, origin: "subagent" }),
				sessionRecord(STRANGER, { cwd: "C:\\somewhere-else" })
			];
		},
		async filterEvents(sessionId, filters) {
			fake.calls.filterEvents.push({ sessionId, filters });
			return [{ sessionId, seq: 1, type: "user/message", time: 1, text: "命中正文" }];
		}
	});
	const { tools } = setup({ sessionQuery: fake.sq });
	const value = await tools.get("recall_history").execute({ query: "证书" }, { agent: AGENT });
	assert.equal(value.ok, true);
	// ★ 请求带的是 cwd 过滤器(工作区),不是 id 过滤器
	assert.deepEqual(fake.calls.searchSessions[0].sessionFilters, [{ kind: "cwd", values: [CWD] }],
		"★ 范围 = 当前工作区");
	// ★ 同工作区的另一个会话**可以**解压(这是工作区范围带来的行为)
	const touched = fake.calls.filterEvents.map((call) => call.sessionId);
	assert.ok(touched.includes(ME), "当前会话在范围内");
	assert.ok(touched.includes(SIBLING), "★ 同工作区的会话允许被读");
	assert.equal(touched.includes(SUBAGENT), false, "★ 子代理会话是实现噪音,不该被解压");
	assert.equal(touched.includes(STRANGER), false, "★ 别的工作区一律不碰");
	assert.equal(JSON.stringify(value).includes(STRANGER), false, "★ 别的工作区的 id 不得出现在输出里");
});

test("★ recall_expand({sessionId: 同工作区会话}) 允许展开(校验用 id + cwd 两个子句 AND)", async () => {
	const fake = fakeSessionQuery({
		async filterSessions(filters) { fake.calls.filterSessions.push(filters); return [sessionRecord(SIBLING, { cwd: CWD })]; },
		async readEvent(request) {
			fake.calls.readEvent.push(request);
			return { session: { id: request.sessionId }, inheritedEventCount: 0, startSeq: 5, endSeq: 5, target: null, events: [] };
		}
	});
	const { tools } = setup({ sessionQuery: fake.sq });
	const value = await tools.get("recall_expand").execute({ sessionId: SIBLING, seq: 5 }, { agent: AGENT });
	assert.equal(value.ok, true, "同工作区的会话应当允许展开");
	assert.deepEqual(fake.calls.filterSessions[0],
		[{ kind: "id", values: [SIBLING] }, { kind: "cwd", values: [CWD] }],
		"★ 判定必须同时限定 id 与 cwd");
});

test("★★ recall_expand({sessionId: 别的工作区}) → SESSION_OUT_OF_SCOPE,而且**一个字都不读**", async () => {
	const fake = fakeSessionQuery({
		async filterSessions(filters) { fake.calls.filterSessions.push(filters); return []; }   // 不属于本工作区
	});
	const { tools } = setup({ sessionQuery: fake.sq });
	const value = await tools.get("recall_expand").execute({ sessionId: STRANGER, seq: 1 }, { agent: AGENT });
	assert.equal(value.ok, false);
	assert.equal(value.error.code, "SESSION_OUT_OF_SCOPE");
	assert.equal(JSON.stringify(value).includes(STRANGER), false, "★ 不得回显请求的会话 id");
	assert.equal(fake.calls.readEvent.length, 0, "★ 绝不去读它");
	assert.equal(fake.calls.readSurface.length, 0, "★ 连表层都不读");
	assert.equal(fake.calls.filterEvents.length, 0, "★ 事件更不读");
});

test("★★ P4:filterSessions 返回非空数组不足以放行,必须本地复筛 id+cwd", async () => {
	// 敌意/有 bug 的后端可以无视过滤子句只返回非空数组 —— 记录自带 header.id/cwd,
	// 所以本地必须再核对一次(复用检索层的 normalizeWorkspacePath)。
	const hostileCwd = fakeSessionQuery({
		async filterSessions() { return [sessionRecord(SIBLING, { cwd: "C:\\somewhere-else" })]; }
	});
	const first = setup({ sessionQuery: hostileCwd.sq });
	const denied = await first.tools.get("recall_expand").execute({ sessionId: SIBLING, seq: 1 }, { agent: AGENT });
	assert.equal(denied.ok, false, "id 对但 cwd 不对 ⇒ 拒绝");
	assert.equal(denied.error.code, "SESSION_OUT_OF_SCOPE");
	assert.equal(hostileCwd.calls.readEvent.length, 0, "★ 拒绝发生在任何读取之前");

	const hostileId = fakeSessionQuery({
		async filterSessions() { return [sessionRecord(STRANGER, { cwd: CWD })]; }
	});
	const second = setup({ sessionQuery: hostileId.sq });
	const denied2 = await second.tools.get("recall_expand").execute({ sessionId: SIBLING, seq: 1 }, { agent: AGENT });
	assert.equal(denied2.ok, false, "cwd 对但 id 不对 ⇒ 拒绝");
	assert.equal(hostileId.calls.readEvent.length, 0);
});

test("★ cwd 未知 ⇒ 退化为『只读当前会话』(**更窄**),并如实说明收窄了", async () => {
	const fake = fakeSessionQuery({
		async searchSessions(request) { fake.calls.searchSessions.push(request); return { items: [] }; },
		async listSessions() {
			fake.calls.listSessions += 1;
			return [sessionRecord(ME, { cwd: CWD }), sessionRecord(SIBLING, { cwd: CWD })];
		},
		async filterEvents(sessionId, filters) {
			fake.calls.filterEvents.push({ sessionId, filters });
			return [{ sessionId, seq: 1, type: "user/message", time: 1, text: "命中正文" }];
		}
	});
	const { tools } = setup({ sessionQuery: fake.sq });
	const value = await tools.get("recall_history").execute({ query: "x" }, { agent: AGENT_NO_CWD });
	assert.equal(value.ok, true);
	// ★ 没有 cwd ⇒ 请求退化为 id 过滤器(**更窄**),绝不是"不加过滤器"
	assert.deepEqual(fake.calls.searchSessions[0].sessionFilters, [{ kind: "id", values: [ME] }]);
	assert.ok(value.published.text.includes("未拿到工作目录"), "★ 收窄这件事要如实写出来,不能让模型以为看到了全部");
	// 不知道 cwd 时,连"看起来同工作区"的另一个会话也不许碰
	assert.deepEqual(fake.calls.filterEvents.map((call) => call.sessionId), [ME]);
	// 连 cwd 都没有时,别的会话的展开也必须拒绝
	const refused = await tools.get("recall_expand").execute({ sessionId: SIBLING, seq: 1 }, { agent: AGENT_NO_CWD });
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "SESSION_OUT_OF_SCOPE");
});

/* ------------------------------------------------------------------ *
 * ② 「被 compaction 挤掉的部分」
 * ------------------------------------------------------------------ */

test("★ 无关键词:骨架按 seq 升序,并写出分类计数", async () => {
	const fake = fakeSessionQuery({
		async filterEvents(sessionId, filters) {
			fake.calls.filterEvents.push({ sessionId, filters });
			// ★ 故意乱序返回:实现必须自己按 seq 升序(最早的在前)。
			//   同时混入 current / log-only,验证"可恢复的只有 shadowed"。
			return [
				{ sessionId, seq: 30, type: "assistant/message", time: 300, surface: "shadowed", text: "被挤掉的第二段" },
				{ sessionId, seq: 10, type: "user/message", time: 100, surface: "shadowed", text: "被挤掉的第一段" },
				{ sessionId, seq: 40, type: "user/message", time: 400, surface: "current", text: "还在上下文里,不该出现" },
				{ sessionId, seq: 5, type: "tool/call", time: 50, surface: "log-only", text: "read\n{\"file_path\":\"x\"}" }
			];
		}
	});
	const { tools } = setup({ sessionQuery: fake.sq });
	const value = await tools.get("recall_history").execute({}, { agent: AGENT });
	assert.equal(value.ok, true);
	assert.equal(value.mode, "compacted");
	assert.deepEqual(fake.calls.filterEvents[0].filters, [{ kind: "surface", values: ["current", "shadowed", "log-only"] }],
		"★ 一次问全三种 surface(分类计数 + 只需一次整档重放)");
	const text = value.published.text;
	assert.ok(text.indexOf("被挤掉的第一段") < text.indexOf("被挤掉的第二段"), "★ 必须按时间正序(最早的在前)");
	assert.ok(text.includes("可见 1 条 / 被挤掉可恢复 2 条 / 不在表层(log-only)1 条"),
		"★ 要写出分类计数(回归要求)");
	assert.equal(text.includes("还在上下文里"), false,
		"★ current 的事件本来就在上下文里,不得当作可恢复内容输出");
});

test("★★ 被挤掉的都是工具结果/注入文本时:不得输出空骨架,要给出说明和 seq", async () => {
	const fake = fakeSessionQuery({
		async filterEvents(sessionId) {
			return [
				{ sessionId, seq: 10, type: "tool/result", time: 100, surface: "shadowed", text: "工具输出正文" },
				{ sessionId, seq: 11, type: "user/message", time: 200, surface: "shadowed",
					text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots." }
			];
		}
	});
	const { tools } = setup({ sessionQuery: fake.sq });
	const value = await tools.get("recall_history").execute({}, { agent: AGENT });
	assert.equal(value.ok, true);
	const text = value.published.text;
	assert.ok(text.includes("没有可进入骨架的文本"), "★ 骨架为空时必须如实解释原因,不能只留一个空标题");
	assert.ok(text.includes("seq=10") && text.includes("seq=11"), "★ 要给出可 recall_expand 的 seq");
	assert.equal(text.includes("工具输出正文"), false, "★ 工具结果正文仍不进骨架");
});

test("★★ 区间只有一条用户消息时:锚点排除后骨架也不能空白", async () => {
	const fake = fakeSessionQuery({
		async filterEvents(sessionId) {
			return [{ sessionId, seq: 10, type: "user/message", time: 100, surface: "shadowed", text: "唯一一句" }];
		}
	});
	const { tools } = setup({ sessionQuery: fake.sq });
	const value = await tools.get("recall_history").execute({}, { agent: AGENT });
	assert.equal(value.ok, true);
	const text = value.published.text;
	assert.ok(text.includes("唯一一句"), "★ 唯一一条用户消息仍要显示在锚点里");
	assert.ok(text.includes("seq=10"), "★ 骨架被锚点排除后,也要给出可展开的 seq,不能空白");
});

test("★ 一条都没被压缩掉 ⇒ 如实说,并**明确标注**地列出本工作区其它会话", async () => {
	const fake = fakeSessionQuery({
		async listSessions() {
			fake.calls.listSessions += 1;
			return [
				sessionRecord(ME, { cwd: CWD, createdAt: 9 }),
				sessionRecord(SIBLING, { cwd: CWD, createdAt: 8 }),
				sessionRecord(SUBAGENT, { cwd: CWD, createdAt: 7, origin: "subagent" }),
				sessionRecord(STRANGER, { cwd: "C:\\somewhere-else", createdAt: 6 })
			];
		}
		// filterEvents 用假件默认的"空数组" ⇒ shadowed = 0
	});
	const { tools } = setup({ sessionQuery: fake.sq });
	const value = await tools.get("recall_history").execute({}, { agent: AGENT });
	assert.equal(value.ok, true);
	const text = value.published.text;
	assert.ok(text.includes("该会话没有被压缩掉的内容"), "★ 没有可恢复内容就如实说,不编造回顾");
	assert.ok(text.includes(SIBLING), "★ 同工作区的其它会话可以列出");
	assert.equal(text.includes(SUBAGENT), false, "★ 子代理会话仍然不列");
	assert.equal(text.includes(STRANGER), false, "★ 别的工作区不列");
});

test("★ 给定 sessionId 但不给 seq:走压缩模式,**不得**返回'最近的 N 条'", async () => {
	const fake = fakeSessionQuery({
		async filterSessions(filters) { fake.calls.filterSessions.push(filters); return [sessionRecord(SIBLING, { cwd: CWD })]; },
		async readSurface(sessionId) {
			fake.calls.readSurface.push(sessionId);
			return {
				session: { id: sessionId }, inheritedEventCount: 0, capturedThroughSeq: 5,
				// ★ 这几条就是"本来就在上下文里"的东西:绝不能被当成回顾内容返回
				events: [{ sessionId, seq: 5, type: "user/message", time: 5, data: { content: [{ type: "text", text: "最近的表层事件(不该被返回)" }] } }]
			};
		}
	});
	const { tools } = setup({ sessionQuery: fake.sq });
	const value = await tools.get("recall_expand").execute({ sessionId: SIBLING }, { agent: AGENT });
	assert.equal(value.ok, true);
	assert.equal(value.mode, "compacted", "★ 不给 seq ⇒ 压缩模式,而不是'最近 N 条'");
	assert.equal(value.published.text.includes("最近的表层事件"), false,
		"★★ 明确的回归:指定 sessionId 但不给 seq 时,**不得**把'最近的 N 条'当结果返回");
});

/* ------------------------------------------------------------------ *
 * ②b ★ 文档级复筛:不听话的后端不得把别会话的正文漏进来
 * ------------------------------------------------------------------ */

test("★★ 扫描路径必须按文档自带的 sessionId 复筛(敌意后端不得漏出别会话正文)", async () => {
	const LEAK = "别的会话的机密正文";
	const fake = fakeSessionQuery({
		async searchSessions(request) { fake.calls.searchSessions.push(request); return { items: [] }; },
		async listSessions() {
			fake.calls.listSessions += 1;
			return [sessionRecord(ME, { cwd: CWD }), sessionRecord(SIBLING, { cwd: CWD })];
		},
		async filterEvents(sessionId, filters) {
			fake.calls.filterEvents.push({ sessionId, filters });
			// ★ 敌意后端:无论被问哪个会话,都回一条**别的会话**的文档。
			//   文档自带它**真实的** sessionId(= STRANGER),所以插件能独立核对。
			return [{ sessionId: STRANGER, seq: 1, type: "user/message", time: 1, surface: "current", text: LEAK }];
		}
	});
	const { tools } = setup({ sessionQuery: fake.sq });
	const value = await tools.get("recall_history").execute({ query: "证书" }, { agent: AGENT });
	assert.equal(value.ok, true);
	assert.ok(fake.calls.filterEvents.length > 0, "这个用例必须走到扫描路径");
	assert.equal(JSON.stringify(value).includes(LEAK), false,
		"★★ 文档 sessionId 与被问会话不符时必须丢弃 —— 否则敌意后端能把别会话正文喂进模型");
	assert.equal(JSON.stringify(value).includes(STRANGER), false, "★ 那个会话的 id 也不能出现");
});

test("★ 「被压缩掉的部分」同样要按文档 sessionId 复筛", async () => {
	const fake = fakeSessionQuery({
		async filterEvents(sessionId, filters) {
			fake.calls.filterEvents.push({ sessionId, filters });
			return [{ sessionId: STRANGER, seq: 1, type: "user/message", time: 1, surface: "shadowed", text: "别的会话的机密正文" }];
		}
	});
	const { tools } = setup({ sessionQuery: fake.sq });
	const value = await tools.get("recall_history").execute({}, { agent: AGENT });
	assert.equal(value.ok, true);
	assert.equal(value.published.text.includes("别的会话的机密正文"), false, "★ 不属于本会话的文档必须丢弃");
	assert.ok(value.published.text.includes("没有被压缩掉的内容"), "★ 丢弃之后应当如实说'没有可恢复内容',而不是拿别人的内容顶上");
});

/* ------------------------------------------------------------------ *
 * ②c ★ 骨架:覆盖整个区间,而不是"取前 N 字符"
 * ------------------------------------------------------------------ */

test("★★ 骨架必须覆盖【整个区间】:首条与末条用户消息都要在", async () => {
	// 回顾块可达数 MB,而发布预算 3000 字符 ⇒ 只发布**开头一小段**是不够的,
	// 于是「永远只看得到开头」。骨架要覆盖首末,而不只是"不超过字符上限"。
	const events = [];
	for (let i = 0; i < 300; i += 1) {
		events.push({ sessionId: ME, seq: 100 + i, type: "tool/call", time: 1000 + i, surface: "shadowed", text: `grep\n{"pattern":"p${i}"}` });
	}
	events.push({ sessionId: ME, seq: 13, type: "user/message", time: 10, surface: "shadowed", text: "第一条用户消息:读 plan.md" });
	events.push({ sessionId: ME, seq: 999, type: "user/message", time: 9000, surface: "shadowed", text: "最后一条用户消息:就这样" });
	const fake = fakeSessionQuery({ async filterEvents() { return events; } });
	const { tools } = setup({ sessionQuery: fake.sq, config: { maxInjectChars: 3000 } });
	const value = await tools.get("recall_history").execute({}, { agent: AGENT });
	assert.equal(value.ok, true);
	const text = value.published.text;
	assert.ok(text.includes("第一条用户消息"), "★★ 必须覆盖区间开头 —— 这正是'截断成前 N 字符'做不到的");
	assert.ok(text.includes("最后一条用户消息"), "★★ 必须覆盖区间末尾");
	assert.ok(text.includes("★ 区间首条用户消息 seq=13"), "★ 首条要带 seq 锚点(可直接 recall_expand)");
	assert.ok(text.includes("★ 区间末条用户消息 seq=999"), "★ 末条也要带 seq 锚点");
	// 骨架放不下时**折叠**(按用户消息分段),而不是把尾巴整段丢掉
	assert.ok(text.includes("按用户消息分段"), "★ 超预算时应当折叠成'用户消息分段',而不是空桶刷屏");
	assert.ok(text.includes("次工具调用"), "★ 每段要附该段的工具调用摘要");
	assert.ok(text.length <= 3000, "★ 最终仍要在发布预算内(超出的部分由 publish 如实标注)");
});

test("★ 宿主自产的运行时上下文不进骨架(噪声过滤)", async () => {
	const fake = fakeSessionQuery({
		async filterEvents() {
			return [
				{ sessionId: ME, seq: 1, type: "user/message", time: 1, surface: "shadowed", text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots." },
				{ sessionId: ME, seq: 2, type: "user/message", time: 2, surface: "shadowed", text: "Time sampled while preparing turn 3, step 1: 2026-01-01T00:00" },
				{ sessionId: ME, seq: 3, type: "user/message", time: 3, surface: "shadowed", text: "真正想说的话" }
			];
		}
	});
	const { tools } = setup({ sessionQuery: fake.sq });
	const text = (await tools.get("recall_history").execute({}, { agent: AGENT })).published.text;
	assert.equal(text.includes("Current runtime context"), false, "★ 运行时上下文是每轮重生成的噪声,不该进骨架");
	assert.equal(text.includes("Time sampled while preparing turn"), false, "★ 采样时间戳同样是噪声");
	assert.ok(text.includes("真正想说的话"), "★ 真正的内容要留着");
});

/* ------------------------------------------------------------------ *
 * ②d ★ "这句话是不是人说的"过滤器(骨架里大部分是 DSH 注入的噪声)
 * ------------------------------------------------------------------ */

test("★★ 五类 DSH 注入消息必须被判为'不是人说的'", () => {
	// 注入消息的 role 全都是 user,所以只能按内容识别
	const injected = [
		"This is an automatically generated checkpoint condensing an earlier span of the conversation.",
		"background job pwsh-0000 (pwsh: …)",
		"<goal_round> Objective: \"在示例机器上完成一项示例任务…\"",
		"Team message team-message-deadbeef-… from agent-runner",
		"Background subagent 00000000-… finished and will do no further work"
	];
	for (const text of injected) {
		assert.equal(isInjectedMessage(text), true, `必须判为注入:${text.slice(0, 36)}…`);
	}
	// 运行时上下文三件套也必须判为注入
	for (const text of [
		"Current runtime context. This snapshot supersedes earlier ones.",
		"Time sampled while preparing turn 3, step 1: 2026-01-01T00:00",
		"Current DSH file policy: workspace-write."
	]) {
		assert.equal(isInjectedMessage(text), true, `必须判为注入:${text.slice(0, 36)}…`);
	}
});

test("★★ 真话必须保留 —— 包括极短的 `?`(不许按长度误杀)", () => {
	for (const text of ["?", "继续", "安装", "先这样,继续", "好,就按这个来"]) {
		assert.equal(isInjectedMessage(text), false, `必须判为人说的:${text}`);
	}
});

test("★★ 反例护栏:讨论本插件时出现的 compaction/subagent/checkpoint 不得把真话误判为注入", () => {
	// ★ 这里刻意保留了更窄的标记集合:若把 subagent / checkpoint / compaction /
	//   tool call 也算特征词,"≥2 个即排除"会把下面这句**真话**误杀 ——
	//   而它恰恰是最需要出现在骨架里的那句话(误杀真话比漏掉一条注入严重得多)。
	const real = "这是一段讨论骨架噪声的话:里面同时出现 subagent 的任务书、"
		+ "checkpoint 摘要、compaction 说明,还有一堆 tool call 噪声";
	assert.equal(isInjectedMessage(real), false, "★★ 讨论这些词的真话必须保留");
});

test("★★ 同一个 seq 不得在输出里出现两次(锚点已从正文剔除)", async () => {
	// 造很多用户消息逼到抽样层:这一层不得把区间首条**再印一遍**
	const events = [];
	for (let i = 0; i < 80; i += 1) {
		events.push({ sessionId: ME, seq: 10 + i, type: "user/message", time: 1000 + i, surface: "shadowed", text: `第 ${i} 条用户消息` });
	}
	const fake = fakeSessionQuery({ async filterEvents() { return events; } });
	const { tools } = setup({ sessionQuery: fake.sq, config: { maxInjectChars: 700 } });
	const text = (await tools.get("recall_history").execute({}, { agent: AGENT })).published.text;
	// 只统计"列表行"和"锚点行"里的 seq(区间范围行描述的是范围,不算列表)
	const listed = [];
	for (const line of text.split("\n")) {
		const hit = /^(?:---\s*seq\s*(\d+)|seq=(\d+)|★ 区间(?:首|末)条用户消息 seq=(\d+))/u.exec(line);
		if (hit) listed.push(hit[1] ?? hit[2] ?? hit[3]);
	}
	assert.ok(listed.length >= 2, "这个用例必须真的产生了列表/锚点");
	const dupes = listed.filter((seq, index) => listed.indexOf(seq) !== index);
	assert.deepEqual(dupes, [], `★ 同一个 seq 不得出现两次(重复:${dupes.join(",")})`);
});

test("★★ 端到端:骨架发布的文本里不得出现密钥明文(真实形态)", async () => {
	// ⚠️ 用**同形态的合成 token**(22 字符、混合大小写+数字、熵 > 3.5);真实密钥绝不入库。
	const KEY = "SYNTH4ticKey9Q2mZ4rT6y";
	const fake = fakeSessionQuery({
		async filterEvents() {
			return [{
				sessionId: ME, seq: 4000, type: "user/message", time: 1, surface: "shadowed",
				text: `示例文本 https://push.example.invalid/${KEY}`
			}];
		}
	});
	const { tools } = setup({ sessionQuery: fake.sq });
	const value = await tools.get("recall_history").execute({}, { agent: AGENT });
	assert.equal(value.ok, true);
	// ★ 明确的回归断言:输出里不得含这个子串
	assert.equal(value.published.text.includes(KEY), false, "★★ 骨架链路的发布文本里不得有密钥明文");
	assert.ok(value.published.text.includes("«已打码»"), "应当留下打码占位符(而不是整条丢掉)");
});

test("★ 子智能体消息 `Agent <id> sent a message:` 要过滤;但人自己粘的内容要保留", () => {
	// 子智能体消息 —— 该过滤
	assert.equal(isInjectedMessage("Agent deadbeef-… sent a message: [job 完成]"), true);
	// ★ 这些是**对话里贴进来的**(终端输出、推送告警回显)⇒ 必须保留,
	//   不能为了"干净"把人真正粘贴的内容也杀了
	assert.equal(isInjectedMessage("Windows PowerShell\nCopyright (C) Microsoft Corporation"), false);
	assert.equal(isInjectedMessage("示例节点异常 ⚠️ (1 项) • 状态文件不存在"), false);
});

test("★★ 策略变更通知要过滤,但讨论策略的真话不许误杀", () => {
	// 需要覆盖的那类形态,以及同类变体
	for (const text of [
		"The approval policy changed from \"ask\" to \"workspace-write\".",
		"The approval policy is now workspace-write.",
		"The file policy changed to workspace-write.",
		"Approval policy: ask."
	]) {
		assert.equal(isInjectedMessage(text), true, `必须判为注入:${text}`);
	}
	// ★ 误杀护栏:本项目里讨论策略的话极常见,这些**是人说的**,必须留
	for (const text of ["The approval policy is wrong, fix it.", "approval policy 这块你想怎么改?"]) {
		assert.equal(isInjectedMessage(text), false, `必须保留(真话):${text}`);
	}
	// 大小写不敏感(对方的过滤器就栽在这里:表里写大写、实文是小写)
	assert.equal(isInjectedMessage("background job pwsh-0000 finished"), true);
	assert.equal(isInjectedMessage("Background job pwsh-0000 finished"), true);
});

/* ------------------------------------------------------------------ *
 * ②e ★ 检索不得命中"我自己那次调用"
 * ------------------------------------------------------------------ */

test("★★ 检索必须排除本插件自己那次调用(否则编造的词也会显得被找到)", async () => {
	const fake = fakeSessionQuery({
		async listSessions() {
			fake.calls.listSessions += 1;
			return [sessionRecord(ME, { cwd: CWD })];
		},
		async filterEvents(sessionId, filters) {
			fake.calls.filterEvents.push({ sessionId, filters });
			// ★ 顺序刻意:我自己的调用排在**最后** —— 不能取"最后一条命中",否则只会返回它自己
			return [
				{ sessionId, seq: 13, type: "user/message", time: 10, surface: "current", text: "读 plan.md,然后继续这个项目" },
				{ sessionId, seq: 4000, type: "tool/call", time: 20, surface: "current", text: 'recall_history {"limit":5,"query":"plan"}' }
			];
		}
	});
	const { tools } = setup({ sessionQuery: fake.sq });
	const value = await tools.get("recall_history").execute({ query: "plan" }, { agent: AGENT });
	assert.equal(value.ok, true);
	assert.ok(value.published.text.includes("plan.md"), "★ 应当命中真正的历史原文");
	assert.equal(value.published.text.includes("4000"), false, "★★ 不得把本插件自己那次调用当成命中");
	// 只排 tool/call 与 assistant/message 里"调用本插件工具"的那一行;别的工具调用是正经历史
	assert.equal(isSelfToolCallDoc("tool/call", 'read\n{"file_path":"x"}'), false, "别的工具调用不得误杀");
	assert.equal(isSelfToolCallDoc("tool/call", 'recall_history {"query":"x"}'), true);
	assert.equal(isSelfToolCallDoc("tool/call", 'recall_expand {"seq":1}'), true);
	assert.equal(isSelfToolCallDoc("user/message", 'recall_history {"query":"x"}'), false, "用户消息不在此列");
});

test("★★ 编造的词必须 0 命中:助手消息携带工具参数也算'自己'(易漏形态)", async () => {
	const INVENTED = "zzz-nonexistent-term-qqq";
	const fake = fakeSessionQuery({
		async listSessions() {
			fake.calls.listSessions += 1;
			return [sessionRecord(ME, { cwd: CWD })];
		},
		async filterEvents() {
			// ★ 真实形状:官方 `blockText` 把 tool-call 块也摊进助手消息的文本
			//   (官方 `blockText`)⇒ 发起调用的那条
			//   助手消息**本身就含查询词**。只判 `tool/call` 会漏掉它。
			return [{
				sessionId: ME, seq: 5000, type: "assistant/message", time: 1, surface: "current",
				text: `我先查一下这段历史\nrecall_history\n{"limit":3,"query":"${INVENTED}"}`
			}];
		}
	});
	const { tools } = setup({ sessionQuery: fake.sq });
	const value = await tools.get("recall_history").execute({ query: INVENTED }, { agent: AGENT });
	assert.equal(value.ok, true);
	assert.ok(value.published.text.includes("没有命中的片段"),
		"★★ 一个凭空编的词不得因为'我自己调用过它'而看起来被找到");
	// 分类判断的边界
	assert.equal(isSelfToolCallDoc("assistant/message", '正文\nread\n{"file_path":"x"}'), false, "别的工具调用不得误杀");
	assert.equal(isSelfToolCallDoc("assistant/message", '正文\nrecall_history\n{"query":"x"}'), true,
		"★ 助手消息携带本插件的调用 ⇒ 判为自己");
	assert.equal(isSelfToolCallDoc("assistant/message", "正文里提到 recall_history 这个词,但不在独立行"), false,
		"正文里偶然提到工具名(不独占一行)不得误杀");
});

/* ------------------------------------------------------------------ *
 * ★ 工具调用要带上结果(文档无 callId ⇒ 相邻配对)
 * ------------------------------------------------------------------ */

test("★ ① 工具行要带上结果(相邻配对);没有结果要如实写", async () => {
	const events = [
		{ sessionId: ME, seq: 1, type: "user/message", time: 1, surface: "shadowed", text: "第一条(会当锚点)" },
		{ sessionId: ME, seq: 2, type: "tool/call", time: 2, surface: "shadowed", text: 'read\n{"file_path":"a.md"}' },
		{ sessionId: ME, seq: 3, type: "tool/result", time: 3, surface: "shadowed", text: "文件内容的第一行摘要" },
		{ sessionId: ME, seq: 4, type: "user/message", time: 4, surface: "shadowed", text: "中间这条用户消息必须在正文里" },
		{ sessionId: ME, seq: 5, type: "tool/call", time: 5, surface: "shadowed", text: 'grep\n{"pattern":"x"}' },
		{ sessionId: ME, seq: 6, type: "user/message", time: 6, surface: "shadowed", text: "最后一条(会当锚点)" }
	];
	const fake = fakeSessionQuery({ async filterEvents() { return events; } });
	const { tools } = setup({ sessionQuery: fake.sq });
	const value = await tools.get("recall_history").execute({}, { agent: AGENT });
	assert.equal(value.ok, true);
	const text = value.published.text;
	assert.ok(text.includes("结果 seq=3"), "★ 工具调用必须带上它的结果(①的核心)");
	assert.ok(text.includes("文件内容的第一行摘要"), "★ 结果要给摘要,否则等于没给");
	assert.ok(text.includes("→ (无结果)"), "★ 没配对到结果时**如实写**,不能假装有");
	// ★★ 密度检查:中间那条用户消息**只能从正文出现**(首末锚点是 seq 1 与 6),
	//    它若消失,就说明结果摘要把"人都说了什么"挤掉了。
	assert.ok(text.includes("中间这条用户消息必须在正文里"), "★★ 用户消息密度不得因为附加结果而下降");
});

/* ------------------------------------------------------------------ *
 * ③ 两条边界回归断言
 * ------------------------------------------------------------------ */

test("★ 没有目标事件时不印 `目标 seq=?`", async () => {
	const fake = fakeSessionQuery({
		async readEvent(request) {
			fake.calls.readEvent.push(request);
			return {
				session: { id: request.sessionId }, inheritedEventCount: 0, startSeq: 5, endSeq: 5, target: null,
				events: [{ sessionId: request.sessionId, seq: 5, type: "user/message", time: 1, text: "x" }]
			};
		}
	});
	const { tools } = setup({ sessionQuery: fake.sq });
	const value = await tools.get("recall_expand").execute({ seq: 5, before: 0, after: 0 }, { agent: AGENT });
	assert.equal(value.ok, true);
	assert.equal(value.published.text.includes("目标 seq=?"), false, "★ `目标 seq=?` 是噪音,不该再印");
});

test("★ 触发词后粘长文:只取**第一行**当检索词(不把整段正文当查询)", () => {
	const pasted = `${"大记忆恢复术"} 示例关键词\n${"X".repeat(600)}\n再来一行`;
	const hit = findTrigger([userMessage(pasted)], DEFAULT_CONFIG);
	assert.ok(hit, "触发词必须命中");
	assert.equal(hit.keyword, "示例关键词", "★ 只取第一行(整段正文当查询 ⇒ 必然 0 命中)");
	// 触发词后换行再写关键词 ⇒ 仍然取到那行(前导空白/换行先被吃掉,与既有用例一致)
	assert.equal(findTrigger([userMessage("大记忆恢复术\n示例关键词")], DEFAULT_CONFIG).keyword, "示例关键词");
	// 触发词之后**真的什么都没有** ⇒ 按"没有关键词"处理(而不是拿一堆标点去检索)
	assert.equal(findTrigger([userMessage("大记忆恢复术   ")], DEFAULT_CONFIG).keyword, "");
	assert.equal(findTrigger([userMessage("Memory unlocked 示例关键词。后面这句不算")], DEFAULT_CONFIG).keyword, "示例关键词");
});
