/**
 * ★★ 范围安全边界测试 —— 本插件最核心的一条。
 *
 * 要求(设计意图):**只看当前工作区**(无 cwd 时退化为只看当前会话),模型没有任何办法碰到别的会话 ——
 * 不是通过工具参数、不是通过插件配置、也不是通过自动触发路径。范围是**安全边界**,
 * 不是可配的偏好。所以这个文件通篇在做"攻击方"的事:
 *   ① 往工具参数里塞 scope / sessionIds(范围类参数,插件不读);
 *   ② 往配置里塞 scope / includeSubagents;
 *   ③ 让假的后端 `listSessions` / `searchSessions` 返回**别的会话**;
 *   ④ 直接请求别的 sessionId;
 *   ⑤ 把 agent 拿掉,看是否真的 fail closed(而不是"退回到更大范围")。
 *
 * 每一条断言都尽量落在**发布出去的文本**(`published.text`)和**真实发出的服务调用**
 * 上 —— 那两样才是模型能观察到的东西。断言里的 `OTHER` 一旦出现在任何一处,就是缺陷。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";
import { fakeCtx, fakeSessionQuery, sessionRecord, userMessage } from "./helpers.mjs";

/** 当前会话。 */
const ME = "sess-current-aaaa";
/** 别的会话(绝不允许出现在任何输出 / 任何请求里)。 */
const OTHER = "other-session-bbbb";

/**
 * 造一个"索引有命中"的假服务:命中属于请求里的 id。
 *
 * ⚠️ 这里**显式**往 `fake.calls` 里记录调用 —— `fakeSessionQuery` 的 `calls`
 *    只有 base 实现会写,被覆盖过的方法必须自己记,否则断言会"空转通过"。
 */
function scopedQuery({ records = [sessionRecord(ME)], onSearch } = {}) {
	const fake = fakeSessionQuery({
		async searchSessions(request, signal) {
			fake.calls.searchSessions.push(request);
			if (onSearch) return onSearch(request, signal);
			const id = request?.sessionFilters?.[0]?.values?.[0];
			return {
				items: [{
					header: { id, cwd: "C:\\work", createdAt: 1, isSeeded: false },
					live: true,
					persisted: false,
					bestMatch: { sessionId: id, seq: 42, type: "assistant/message", time: 1000, surface: "current", snippet: "历史片段" }
				}]
			};
		},
		async listSessions() { fake.calls.listSessions += 1; return records; },
		async filterEvents(sessionId, filters) {
			fake.calls.filterEvents.push({ sessionId, filters });
			if (filters?.[0]?.kind === "seq") {
				return [{ sessionId, seq: filters[0].from, type: "assistant/message", time: 1000, surface: "current", text: "历史片段" }];
			}
			// ★ `surface:"shadowed"` 才是"被 compaction 挤掉、可恢复"的那一类
			//   (无关键词模式只把 shadowed 算作可恢复内容 —— 见 lib/recall.js 的 renderCompactedBody)
			return [{ sessionId, seq: 7, type: "user/message", time: 900, surface: "shadowed", text: "扫描到的正文" }];
		},
		async readSurface(sessionId) {
			fake.calls.readSurface.push(sessionId);
			return {
				session: { id: sessionId }, inheritedEventCount: 0, capturedThroughSeq: 3,
				events: [{ sessionId, seq: 3, type: "user/message", time: 300, surface: "current", data: { content: [{ type: "text", text: "我刚才说到这" }] } }]
			};
		}
	});
	return fake;
}

/** 一次性把工具装好。 */
function setup({ config = {}, sessionQuery } = {}) {
	const { ctx, tools, commands, listeners } = fakeCtx({ sessionQuery });
	apply(ctx, config);
	return { tools, commands, listeners };
}

/** 当前会话的 agent(两种权威来源都覆盖到)。 */
const AGENT = { id: ME };

/* ------------------------------------------------------------------ *
 * ① recall_history:参数里的提宽旋钮
 * ------------------------------------------------------------------ */

test("★ recall_history({scope:'all'}) 被无视:正文与请求里只有当前会话", async () => {
	const { sq, calls } = scopedQuery();
	const { tools } = setup({ sessionQuery: sq });
	const value = await tools.get("recall_history").execute({ query: "证书", scope: "all" }, { agent: AGENT });
	assert.equal(value.ok, true);
	assert.ok(value.published.text.includes(`范围:仅当前会话 ${ME}`), "★ 正文必须写明范围");
	assert.deepEqual(calls.searchSessions[0].sessionFilters, [{ kind: "id", values: [ME] }], "★ 请求里只有当前会话");
	for (const forbidden of ["scope", "所有工作目录", "跨会话"]) {
		assert.equal(value.published.text.includes(forbidden), false, `★ 正文里不该出现「${forbidden}」`);
	}
});

test("★ recall_history({sessionIds:['other-session']}) 被无视:other-session 在输出里一个字都不出现", async () => {
	const { sq, calls } = scopedQuery();
	const { tools } = setup({ sessionQuery: sq });
	const value = await tools.get("recall_history").execute({ query: "证书", sessionIds: [OTHER] }, { agent: AGENT });
	assert.equal(value.ok, true);
	assert.equal(JSON.stringify(value).includes(OTHER), false, "★ 别的会话 id 不得出现在返回值里");
	assert.deepEqual(calls.searchSessions[0].sessionFilters, [{ kind: "id", values: [ME] }], "★ 请求仍然只限定当前会话");
	assert.deepEqual(calls.filterEvents, [{ sessionId: ME, filters: [{ kind: "seq", from: 42, to: 42 }] }],
		"索引只补读本会话的确切命中原文以安全脱敏,不扩成扫描或读取别的会话");
	assert.equal(calls.listSessions, 0, "索引有命中,不应列全体会话做扫描");
});

test("★ 配置里的提宽旋钮(scope/includeSubagents)完全无效", async () => {
	const many = [sessionRecord(ME), sessionRecord(OTHER, { origin: "subagent" })];
	const { sq, calls } = scopedQuery({ records: many, onSearch: async () => ({ items: [] }) });
	// 同时往**参数**和**配置**里塞提宽旋钮
	const { tools } = setup({
		config: { scope: "all", includeSubagents: true, sessionIds: [OTHER] },
		sessionQuery: sq
	});
	const value = await tools.get("recall_history").execute({ query: "x", scope: "all", sessionIds: [OTHER] }, { agent: AGENT });
	assert.equal(value.ok, true);
	assert.deepEqual(calls.searchSessions[0].sessionFilters, [{ kind: "id", values: [ME] }]);
	assert.deepEqual(calls.filterEvents.map((call) => call.sessionId), [ME], "★ 只解压当前会话");
	assert.equal(JSON.stringify(value).includes(OTHER), false);
});

/* ------------------------------------------------------------------ *
 * ② recall_expand:请求别的会话必须被拒
 * ------------------------------------------------------------------ */

test("★ recall_expand({sessionId:'other-session'}) → SESSION_OUT_OF_SCOPE,且文本不泄露任何信息", async () => {
	const { sq, calls } = scopedQuery();
	const { tools } = setup({ sessionQuery: sq });
	const value = await tools.get("recall_expand").execute({ sessionId: OTHER, seq: 1 }, { agent: AGENT });
	assert.equal(value.ok, false);
	assert.equal(value.error.code, "SESSION_OUT_OF_SCOPE");
	assert.equal(value.published.text.includes(OTHER), false, "★ 连请求里的 id 都不回显");
	assert.equal(value.error.message.includes(OTHER), false);
	assert.deepEqual(calls.readEvent, [], "★ 绝不去读那个会话");
	assert.deepEqual(calls.readSurface, [], "★ 绝不去读那个会话");
	assert.deepEqual(calls.filterEvents, [], "★ 绝不去读那个会话");
	assert.equal(JSON.stringify(value).includes(OTHER), false);
});

test("★ recall_expand({seq:1}) 省略 sessionId → 用当前会话并成功", async () => {
	const { sq, calls } = scopedQuery();
	const { tools } = setup({ sessionQuery: sq });
	const value = await tools.get("recall_expand").execute({ seq: 1 }, { agent: AGENT });
	assert.equal(value.ok, true, `实际:${JSON.stringify(value.error ?? {})}`);
	assert.equal(calls.readEvent[0]?.sessionId, ME, "★ 读的必须是当前会话");
	assert.ok(value.published.text.includes(`范围:仅当前会话 ${ME}`));
});

test("★ recall_expand({sessionId:'当前会话'}) 是允许的(等于省略)", async () => {
	const { sq, calls } = scopedQuery();
	const { tools } = setup({ sessionQuery: sq });
	const value = await tools.get("recall_expand").execute({ sessionId: ME, seq: 1 }, { agent: AGENT });
	assert.equal(value.ok, true);
	assert.equal(calls.readEvent[0]?.sessionId, ME);
});

test("★ recall_expand 省略 sessionId 且省略 seq → 走「被 compaction 挤掉的部分」,不给最近的 N 条", async () => {
	const { sq, calls } = scopedQuery();
	const { tools } = setup({ sessionQuery: sq });
	const value = await tools.get("recall_expand").execute({}, { agent: AGENT });
	assert.equal(value.ok, true);
	assert.equal(value.mode, "compacted", "★ 不给 seq ⇒ 压缩模式,而不是'最近的表层事件'");
	// ★ 明确的回归断言:不得把"最近 N 条"当结果返回
	assert.deepEqual(calls.filterEvents, [{ sessionId: ME, filters: [{ kind: "surface", values: ["current", "shadowed", "log-only"] }] }],
		"★ 一次问全三种 surface(可恢复的只有 shadowed;顺带拿到分类计数,且只需一次整档重放)");
	assert.equal(value.published.text.includes("我刚才说到这"), false,
		"★ 最近的表层事件(本来就在上下文里、一个字都没丢)不得作为回顾内容返回");
	assert.ok(value.published.text.includes("扫描到的正文"), "★ 返回的必须是'被压缩掉'的那些事件");
	assert.ok(value.published.text.includes(`范围:仅当前会话 ${ME}`), "★ 范围仍要写在正文里");
});

/* ------------------------------------------------------------------ *
 * ③ 解析不出当前会话 ⇒ fail closed
 * ------------------------------------------------------------------ */

test("★ 拿不到 agent/会话 id 时:两个工具都 SESSION_SCOPE_UNAVAILABLE,绝不退回到更大范围", async () => {
	const { sq, calls } = scopedQuery();
	const { tools } = setup({ sessionQuery: sq });
	const history = tools.get("recall_history");
	const expand = tools.get("recall_expand");
	// exec 缺失 / agent 缺失 / agent 没有 id / id 为空串 —— 全都是"范围定不下来"
	for (const exec of [undefined, {}, { agent: undefined }, { agent: {} }, { agent: { id: "" } }, { agent: { id: "a\0b" } }]) {
		const h = await history.execute({ query: "证书" }, exec);
		assert.equal(h.ok, false, `history 必须失败(exec=${JSON.stringify(exec)})`);
		assert.equal(h.error.code, "SESSION_SCOPE_UNAVAILABLE");
		const e = await expand.execute({ seq: 1 }, exec);
		assert.equal(e.ok, false, `expand 必须失败(exec=${JSON.stringify(exec)})`);
		assert.equal(e.error.code, "SESSION_SCOPE_UNAVAILABLE");
	}
	// ★ 关键:一次服务调用都没发出去 —— "没有范围"不能变成"范围更大"
	assert.deepEqual(calls.searchSessions, []);
	assert.deepEqual(calls.readEvent, []);
	assert.deepEqual(calls.readSurface, []);
	assert.equal(calls.listSessions, 0);
});

test("★ 拿不到会话 id 时自动路径也什么都不注入(返回同一个 decision)", async () => {
	for (const agent of [undefined, {}, { id: "" }, { session: { header: {} } }]) {
		const { sq, calls } = scopedQuery();
		const { listeners } = setup({ sessionQuery: sq });
		const decision = { kind: "enter", messages: [userMessage("大记忆恢复术 证书")] };
		const out = await listeners.get("agent/pre-step")({ agent, turn: 1, step: 1, messages: decision.messages }, async () => decision);
		assert.equal(out, decision, `★ 拿不到范围就必须原样返回(agent=${JSON.stringify(agent)})`);
		assert.deepEqual(calls.searchSessions, [], "★ 一次检索都不许发");
		assert.equal(calls.listSessions, 0);
	}
});

/* ------------------------------------------------------------------ *
 * ④ 自动路径:范围来自 payload.agent
 * ------------------------------------------------------------------ */

test("★ 自动路径的检索请求只限定 payload.agent 解析出的会话", async () => {
	const { sq, calls } = scopedQuery();
	const { listeners } = setup({ sessionQuery: sq });
	const decision = { kind: "enter", messages: [userMessage("大记忆恢复术 证书")] };
	const out = await listeners.get("agent/pre-step")(
		{ agent: { id: ME }, turn: 3, step: 1, messages: decision.messages },
		async () => decision
	);
	assert.equal(out.messages.length, 2, "必须注入");
	assert.deepEqual(calls.searchSessions[0]?.sessionFilters, [{ kind: "id", values: [ME] }], "★ 自动路径同样只查当前会话");
	assert.ok(out.messages[1].content[0].text.includes(`范围:仅当前会话 ${ME}`), "★ 注入块里也要写出范围");
});

test("★ 自动路径优先用会话头 id(agent.session.header.id),而不是 agent.id", async () => {
	const headerId = "sess-from-header";
	const { sq, calls } = scopedQuery({
		onSearch: async (request) => {
			const id = request?.sessionFilters?.[0]?.values?.[0];
			return { items: [{ header: { id }, live: true, persisted: false, bestMatch: { sessionId: id, seq: 5, type: "user/message", time: 1, surface: "current", snippet: "片段" } }] };
		}
	});
	const { listeners } = setup({ sessionQuery: sq });
	const decision = { kind: "enter", messages: [userMessage("DJYHFS 证书")] };
	await listeners.get("agent/pre-step")(
		{ agent: { id: "sess-from-agent", session: { header: { id: headerId } } }, turn: 4, step: 1, messages: decision.messages },
		async () => decision
	);
	assert.deepEqual(calls.searchSessions[0]?.sessionFilters, [{ kind: "id", values: [headerId] }], "★ 会话头 id 优先");
});

/* ------------------------------------------------------------------ *
 * ⑤ 更宽的不变量:敌意后端也漏不出别的会话
 * ------------------------------------------------------------------ */

test("★ 不变量:listSessions / searchSessions 全都返回别的会话时,任何发布文本里都不出现别的会话 id", async () => {
	const others = ["other-1", "other-2", "other-3"];
	const { sq, calls } = scopedQuery({
		// 敌意后端:无论请求怎么限定,都只回别的会话
		onSearch: async () => ({ items: others.map((id, index) => ({
			header: { id, cwd: "C:\\work", createdAt: 1, isSeeded: false },
			live: true, persisted: false,
			bestMatch: { sessionId: id, seq: index + 1, type: "user/message", time: 1, surface: "current", snippet: `别的会话正文-${id}` }
		})) }),
		records: others.map((id) => sessionRecord(id))
	});
	const { tools, commands, listeners } = setup({ sessionQuery: sq });

	const published = [];
	// ① 有 query(索引路径,还会落到扫描)
	const hit = await tools.get("recall_history").execute({ query: "证书", limit: 5 }, { agent: AGENT });
	published.push(["recall_history(query)", hit.published.text]);
	// ② 没有 query(当前会话的表层模式)
	const surface = await tools.get("recall_history").execute({}, { agent: AGENT });
	published.push(["recall_history()", surface.published.text]);
	// ③ /recall
	const command = await commands[0].handler({ commandId: "c1", agent: AGENT, rawInput: "证书", attachments: [], signal: undefined });
	published.push(["/recall", command.text]);
	// ④ 自动路径(有关键词 → 检索;没关键词 → 表层)
	for (const [index, text] of ["大记忆恢复术 证书", "大记忆恢复术"].entries()) {
		const decision = { kind: "enter", messages: [userMessage(text)] };
		const out = await listeners.get("agent/pre-step")(
			{ agent: AGENT, turn: 50 + index, step: 1, messages: decision.messages },
			async () => decision
		);
		published.push([`pre-step ${JSON.stringify(text)}`, out.messages[1]?.content[0]?.text ?? ""]);
	}

	assert.ok(published.length === 5, "自检:五条发布路径都要跑到,否则本测试会空转");
	for (const [label, text] of published) {
		assert.equal(typeof text, "string");
		for (const other of others) {
			assert.equal(text.includes(other), false, `★ ${label} 的发布文本里出现了别的会话 id「${other}」`);
			assert.equal(text.includes(`别的会话正文-${other}`), false, `★ ${label} 泄露了别的会话的正文`);
		}
		assert.equal(JSON.stringify(text).includes(OTHER), false);
	}
	// 服务侧:所有检索请求都只限定当前会话
	assert.ok(calls.searchSessions.length > 0, "自检:确实发过检索请求");
	for (const request of calls.searchSessions) {
		assert.deepEqual(request.sessionFilters, [{ kind: "id", values: [ME] }], "★ 每个请求都只限定当前会话");
	}
	// 扫描/表层也只在当前会话上
	for (const call of calls.filterEvents) assert.equal(call.sessionId, ME);
	for (const id of calls.readSurface) assert.equal(id, ME);
});

/* ------------------------------------------------------------------ *
 * ⑥ /recall 命令
 * ------------------------------------------------------------------ */

test("★ /recall 从 invocation.agent 取范围;拿不到 agent 就失败(不回落到更大范围)", async () => {
	const { sq, calls } = scopedQuery();
	const { commands } = setup({ sessionQuery: sq });
	const handler = commands[0].handler;
	const ok = await handler({ commandId: "c1", agent: AGENT, rawInput: "证书" });
	assert.equal(ok.kind, "success");
	assert.deepEqual(calls.searchSessions[0].sessionFilters, [{ kind: "id", values: [ME] }]);
	// 裸字符串形态(没有 agent)⇒ 范围定不下来 ⇒ 显式失败,且不发任何检索请求
	const before = calls.searchSessions.length;
	const bare = await handler("证书");
	assert.equal(bare.kind, "error", "★ 拿不到范围时必须是 error");
	assert.ok(bare.text.includes("SESSION_SCOPE_UNAVAILABLE"));
	assert.equal(calls.searchSessions.length, before, "★ 一次检索都不许发");
	// 空参仍然是"用法"错误(与 SESSION_SCOPE_UNAVAILABLE 区分开)
	const empty = await handler({ commandId: "c2", agent: AGENT, rawInput: "  " });
	assert.equal(empty.kind, "error");
	assert.ok(empty.text.includes("用法"));
});
