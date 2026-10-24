/**
 * 检索层测试:索引优先 / 扫描兜底 / ★ 单会话(只解压当前会话) / 错误码保留。
 *
 * ★ 所有 `searchCorpus` 用例都必须传 `options.sessionId`(= 当前会话);
 *   "多个候选会话里挑 N 个"不是本插件的前提,断言的落点是**别的会话一个都不读**。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { INSPECT_MAX, expandAt, expandTail, filterRecords, searchCorpus } from "../lib/search.js";
import { normalizeConfig, renderHistoryBody } from "../lib/recall.js";
import { fakeSessionQuery, sessionRecord } from "./helpers.mjs";

const CONFIG = normalizeConfig();
const CWD = "C:\\work";
/** 当前会话(测试里"我"就是它)。 */
const ME = "me";
/** 其它会话 —— 任何输出/任何服务调用里都**不允许**出现它。 */
const OTHER = "other-session";

function searchHit(seq, { id = ME, cwd = CWD, createdAt = 100, origin, snippet = "片段" } = {}) {
	const header = { id, cwd, createdAt, isSeeded: false };
	if (origin) header.origin = origin;
	return { header, live: true, persisted: false, bestMatch: { sessionId: id, seq, type: "assistant/message", time: 1000 + seq, surface: "current", snippet } };
}

test("★ 索引路径:命中带 seq(钻取链不断),且只认当前会话", async () => {
	const { sq, calls } = fakeSessionQuery({
		async searchSessions(request) {
			calls.searchSessions.push(request);
			return { items: [searchHit(42)] };
		}
	});
	const out = await searchCorpus(sq, { query: "证书", limit: 5 }, { config: CONFIG, sessionId: ME });
	assert.equal(out.mode, "index");
	assert.equal(out.hits.length, 1);
	assert.equal(out.hits[0].seq, 42, "★ seq 必须保留");
	assert.equal(calls.listSessions, 0, "索引命中就不该扫描");
	assert.deepEqual(calls.searchSessions[0].sessionFilters, [{ kind: "id", values: [ME] }], "★ 请求必须限定当前会话");
	// ★ 标题链路不参与:索引路径不调用 readTitleSnapshots(整档解码成本)
	assert.equal(calls.readTitleSnapshots.length, 0, "★ 不该再为标题解压整条日志");
	assert.equal(out.hits[0].title, undefined);
});

test("★ 索引后端忽略 id 过滤器时,别的会话的命中被就地丢弃(防线在本地,不只靠请求)", async () => {
	const { sq } = fakeSessionQuery({
		async searchSessions() {
			// 敌意/有 bug 的后端:把别的会话也塞回来
			return { items: [searchHit(1, { id: OTHER }), searchHit(2, { id: ME }), searchHit(3, { id: "third" })] };
		}
	});
	const out = await searchCorpus(sq, { query: "x", limit: 5 }, { config: CONFIG, sessionId: ME });
	assert.deepEqual(out.hits.map((hit) => hit.sessionId), [ME], "★ 只能留下当前会话的命中");
	assert.equal(JSON.stringify(out).includes(OTHER), false, "★ 别的会话 id 不得出现在返回结构里");
});

test("★ N1:索引路径 inspected 按会话去重,同会话多个 seq 不放大成多个会话", async () => {
	const { sq } = fakeSessionQuery({
		async searchSessions() { return { items: [searchHit(41), searchHit(42)] }; }
	});
	const out = await searchCorpus(sq, { query: "x", limit: 5 }, { config: CONFIG, sessionId: ME });
	assert.equal(out.mode, "index");
	assert.equal(out.hits.length, 2, "两个命中事件都保留");
	assert.equal(out.inspected, 1, "★ 同一会话的两个命中只能算一个会话(事件数 ≠ 会话数)");
	const body = renderHistoryBody({ ...out, query: "x", sessionId: ME, scope: { sessionId: ME, cwd: CWD } });
	assert.ok(body.includes("索引命中涉及 1 个会话"), body.slice(0, 300));
	assert.equal(body.includes("索引命中涉及 2 个会话"), false, "★ 不得把两个 seq 写成两个会话");
	assert.equal(body.includes("检查了 2 个会话"), false, "★ 索引路径不宣称完整检查了会话");

	// 索引命中先存活 → 补读时全文判定为自身工具调用 ⇒ hits 清空 → 回退扫描 candidates=0。
	// 这条路径会先经过 :399 的 inspected 赋值,没有 :440 的归零就会残留成 1。
	const fallback = fakeSessionQuery({
		async searchSessions() {
			return { items: [searchHit(7, { snippet: "正常摘要" })] };
		},
		async filterEvents(sessionId) {
			return [{ sessionId, seq: 7, type: "tool/call", text: "recall_history\n{\"limit\":3}" }];
		},
		async listSessions() { return []; }
	});
	const down = await searchCorpus(fallback.sq, { query: "x", limit: 5 }, { config: CONFIG, sessionId: ME });
	assert.equal(down.mode, "scan");
	assert.equal(down.inspected, 0, "★ 回退扫描后不得残留索引阶段的会话计数");
	assert.equal(down.incomplete, true);
	const downBody = renderHistoryBody({ ...down, query: "x", sessionId: ME, scope: { sessionId: ME, cwd: CWD } });
	assert.equal(downBody.includes("检查了 1 个会话"), false, "★ 没有扫描就不能说检查了会话");
	assert.ok(downBody.includes("不等于整个范围没有命中"), "★ 降级零命中也不能冒充完整结论");
});

test("索引无命中 → 扫描兜底(并说明降级原因)", async () => {
	const scanned = [];
	const { sq } = fakeSessionQuery({
		async listSessions() { return [sessionRecord(ME, { cwd: CWD })]; },
		async filterEvents(sessionId) {
			scanned.push(sessionId);
			return [{ sessionId, seq: 7, type: "user/message", time: 900, surface: "current", text: "扫描到的正文" }];
		}
	});
	const out = await searchCorpus(sq, { query: "证书", limit: 5 }, { config: CONFIG, sessionId: ME });
	assert.equal(out.mode, "scan");
	assert.ok(out.degraded.includes("索引没有返回命中"));
	assert.equal(out.hits[0].seq, 7, "扫描命中同样要带 seq");
	assert.ok(out.hits[0].snippet.includes("扫描到的正文"));
	assert.deepEqual(scanned, [ME], "★ 只解压当前会话");
});

test("★ 索引抛错 → 保留 error.code 并降级扫描(不静默查不到)", async () => {
	const { sq } = fakeSessionQuery({
		async searchSessions() {
			const error = new Error("search disabled");
			error.code = "SESSION_QUERY_SEARCH_DISABLED";
			throw error;
		},
		async listSessions() { return [sessionRecord(ME, { cwd: CWD })]; },
		async filterEvents(sessionId) { return [{ sessionId, seq: 3, type: "user/message", time: 1, surface: "current", text: "兜底命中" }]; }
	});
	const out = await searchCorpus(sq, { query: "x", limit: 5 }, { config: CONFIG, sessionId: ME });
	assert.equal(out.mode, "scan");
	assert.ok(out.error.includes("SESSION_QUERY_SEARCH_DISABLED"), "错误码必须原样带出来");
	assert.ok(out.degraded.includes("索引检索失败"));
	assert.equal(out.hits.length, 1);
});

test("连 listSessions 都失败 → 明确告知,不抛", async () => {
	const { sq } = fakeSessionQuery({
		async listSessions() { throw new Error("purge failed"); }
	});
	const out = await searchCorpus(sq, { query: "x", limit: 5 }, { config: CONFIG, sessionId: ME });
	assert.equal(out.hits.length, 0);
	assert.ok(out.degraded.includes("连会话列表也读不到"));
});

test("★ 当前会话不在 listSessions 里 → 如实说明,不许让'没有命中'替宿主撒谎", async () => {
	const { sq, calls } = fakeSessionQuery({
		// 列表里只有**别的**会话:当前会话没出现(宿主实现细节,不能装作查过了)
		async listSessions() { return [sessionRecord(OTHER, { cwd: CWD })]; }
	});
	const out = await searchCorpus(sq, { query: "x", limit: 5 }, { config: CONFIG, sessionId: ME });
	assert.equal(out.hits.length, 0);
	assert.ok(out.degraded.includes("当前会话没有出现在会话列表里"), `实际降级文案:${out.degraded}`);
	assert.deepEqual(calls.filterEvents, [], "★ 别的会话一个都不许解压");
});

test("★ 单会话:listSessions 给 200 个会话,也只有当前会话会被解压", async () => {
	const many = Array.from({ length: 200 }, (_, index) => sessionRecord(`s${index}`, { cwd: CWD, createdAt: 1000 - index }));
	many.unshift(sessionRecord(ME, { cwd: CWD, createdAt: 2000 }));
	const { sq, calls } = fakeSessionQuery({
		async listSessions() { return many; },
		async filterEvents(sessionId) {
			calls.filterEvents.push({ sessionId });
			return [{ sessionId, seq: 1, type: "user/message", time: 1, surface: "current", text: "命中" }];
		}
	});
	const out = await searchCorpus(sq, { query: "x", limit: 5 }, { config: CONFIG, sessionId: ME });
	assert.deepEqual(calls.filterEvents.map((call) => call.sessionId), [ME], "★ 只能解压当前会话");
	assert.equal(out.inspected, 1, "候选只有当前会话一个");
	assert.ok(out.inspected <= INSPECT_MAX);
	assert.equal(out.truncatedWindow, false, "单会话不存在'候选窗口用尽'");
	assert.deepEqual(out.hits.map((hit) => hit.sessionId), [ME], "别的会话 id 不得进结果");
});

test("★ 工作区模式:当前会话单独先扫,凑够 limit 立即停 —— 不设最低候选数", async () => {
	// 41 个同 cwd 会话;limit=1 且当前会话有命中 ⇒ 只允许读它一个。
	// 不设最低候选数:同样的数据上只解压当前会话的整档日志。
	const many = [
		sessionRecord(ME, { cwd: CWD, createdAt: 3000 }),
		...Array.from({ length: 40 }, (_, index) => sessionRecord(`old${index}`, { cwd: CWD, createdAt: 2000 - index }))
	];
	const { sq, calls } = fakeSessionQuery({
		async listSessions() { return many; },
		async filterEvents(sessionId) {
			calls.filterEvents.push({ sessionId });
			return [{ sessionId, seq: 1, type: "user/message", time: 1, surface: "current", text: "命中" }];
		}
	});
	const out = await searchCorpus(sq, { query: "x", limit: 1 }, { config: CONFIG, sessionId: ME, cwd: CWD });
	assert.deepEqual(calls.filterEvents.map((call) => call.sessionId), [ME], "★ 当前会话凑够 limit 后一个别的会话都不许读");
	assert.equal(out.inspected, 1, "★ 只检查了当前会话");
	assert.equal(out.candidates, 41, "候选总数照实报告");
	assert.equal(out.stoppedAtLimit, true);
	assert.equal(out.truncatedWindow, false, "★ 提前停手不是'结果不全':返回的正是要的 limit 条");
	assert.equal(out.hits.length, 1);
	assert.equal(out.hits[0].sessionId, ME);
});

test("★ 工作区模式:当前会话不够时才按从新到旧扩展,凑够 limit 立即停并如实披露", async () => {
	// 6 个候选、limit=1。并发度 4 ⇒ 第一轮会拉起 4 个会话(已启动的收不回来),
	// 但最后一个(oldest)**不会**被启动,且 inspected/candidates 如实反映这一点。
	const many = [
		sessionRecord(ME, { cwd: CWD, createdAt: 9000 }),
		...Array.from({ length: 5 }, (_, index) => sessionRecord(`c${index + 1}`, { cwd: CWD, createdAt: 8000 - index }))
	];
	const decoded = [];
	const { sq } = fakeSessionQuery({
		async listSessions() { return many; },
		async filterEvents(sessionId) {
			decoded.push(sessionId);
			// 当前会话 0 命中;其余都有命中 ⇒ 第一个命中的会话就让 limit 满足
			if (sessionId === ME) return [];
			return [{ sessionId, seq: 1, type: "user/message", time: 10, surface: "current", text: "命中" }];
		}
	});
	const out = await searchCorpus(sq, { query: "x", limit: 1 }, { config: CONFIG, sessionId: ME, cwd: CWD });
	assert.equal(decoded[0], ME, "★ 当前会话永远第一个、且单独先扫");
	assert.equal(decoded.includes("c1"), true, "★ 扩展从最新的别的会话开始");
	assert.equal(decoded.includes("c5"), false, "★ 凑够 limit 后不启动新会话(最旧的那个没被读过)");
	assert.deepEqual(decoded.slice().sort(), [ME, "c1", "c2", "c3", "c4"].sort(), "★ 并发已经拉起的 4 个收不回来,但不会有第 5 个");
	assert.equal(out.candidates, 6);
	assert.equal(out.inspected, decoded.length);
	assert.equal(out.stoppedAtLimit, true);
	const body = renderHistoryBody({ ...out, query: "x", sessionId: ME, scope: { sessionId: ME, cwd: CWD } });
	assert.ok(body.includes("返回条数已达上限"), "★ 提前停手要有一行只属于它的披露");
	assert.ok(body.includes("共 6 个候选"), "★ 候选总数要写出来");
	assert.ok(body.includes("未检查"), "★ 未检查的会话数要让模型知道,别把'没查完'读成'更早的没有'");
	assert.ok(body.includes("在已检查的会话中按时间倒序"), "★ 提前停手时排序说明不能说满");
});

test("★ 当前会话在 listSessions 里排最后/最旧时,仍然必须第一个被扫", async () => {
	// 直接钉 `orderScanCandidates`:去掉排序逻辑这条会红(其余用例都让 ME 排第一)。
	const many = [
		...Array.from({ length: 5 }, (_, index) => sessionRecord(`c${index}`, { cwd: CWD, createdAt: 5000 - index })),
		sessionRecord(ME, { cwd: CWD, createdAt: 1 })
	];
	const decoded = [];
	const { sq } = fakeSessionQuery({
		async listSessions() { return many; },
		async filterEvents(sessionId) { decoded.push(sessionId); return []; }
	});
	await searchCorpus(sq, { query: "x", limit: 5 }, { config: CONFIG, sessionId: ME, cwd: CWD });
	assert.equal(decoded[0], ME, "★ 当前会话必须第一个被扫(即使它在列表里排最后、创建时间最旧)");
	assert.deepEqual(decoded.slice().sort(), ["c0", "c1", "c2", "c3", "c4", ME].sort(), "全部候选都会被扫(无命中)");
});

test("★ 当前会话单独先扫:它还没返回时,别的会话一个都不许启动", async () => {
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const decoded = [];
	const many = [
		sessionRecord("a", { cwd: CWD, createdAt: 2 }),
		sessionRecord(ME, { cwd: CWD, createdAt: 1 })
	];
	const { sq } = fakeSessionQuery({
		async listSessions() { return many; },
		async filterEvents(sessionId) {
			decoded.push(sessionId);
			if (sessionId === ME) await gate;   // 当前会话卡住,其它会话不许趁机启动
			return [];
		}
	});
	const pending = searchCorpus(sq, { query: "x", limit: 5 }, { config: CONFIG, sessionId: ME, cwd: CWD });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(decoded, [ME], "★ 当前会话未返回前不允许有任何并发读取");
	release();
	await pending;
	assert.deepEqual(decoded.slice().sort(), ["a", ME].sort(), "resolve 后才扩展到其余会话");
});

test("★ limit 恰好在最后一个候选达到 ⇒ 不是'提前停手'(totalInScope === inspected)", async () => {
	const many = [
		sessionRecord(ME, { cwd: CWD, createdAt: 3 }),
		sessionRecord("a", { cwd: CWD, createdAt: 2 }),
		sessionRecord("b", { cwd: CWD, createdAt: 1 })
	];
	const { sq } = fakeSessionQuery({
		async listSessions() { return many; },
		async filterEvents(sessionId) {
			return [{ sessionId, seq: 1, type: "user/message", time: 1, surface: "current", text: "命中" }];
		}
	});
	const out = await searchCorpus(sq, { query: "x", limit: 3 }, { config: CONFIG, sessionId: ME, cwd: CWD });
	assert.equal(out.inspected, 3);
	assert.equal(out.candidates, 3);
	assert.equal(out.stoppedAtLimit, false, "★ 全部候选都检查过了,不存在'没查完'");
	assert.equal(out.truncatedWindow, false);
});

test("★ 预算耗尽与凑够 limit 同时发生:以预算为准,不得再宣称'提前停手'", async (t) => {
	// 确定性构造:c1 被 gate 挂住(命中还没到),c2 在调用中把时钟推过 deadline,
	// c3/c4 回到循环发现超预算 ⇒ budgetExhausted;之后 release,c1 交付命中 ⇒ found>=limit。
	// 两个标志都会置位 —— 渲染层绝不能同时说"预算耗尽"和"返回条数已达上限"。
	t.mock.timers.enable({ apis: ["Date"], now: 0 });
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const many = [
		sessionRecord(ME, { cwd: CWD, createdAt: 9000 }),
		...Array.from({ length: 6 }, (_, index) => sessionRecord(`c${index + 1}`, { cwd: CWD, createdAt: 8000 - index }))
	];
	const { sq } = fakeSessionQuery({
		async listSessions() { return many; },
		async filterEvents(sessionId) {
			if (sessionId === ME) return [];
			if (sessionId === "c1") return gate.then(() => [{ sessionId, seq: 1, type: "user/message", time: 1, surface: "current", text: "命中" }]);
			if (sessionId === "c2") { t.mock.timers.tick(1000); return []; }
			return [];
		}
	});
	const pending = searchCorpus(sq, { query: "x", limit: 1 }, { config: CONFIG, sessionId: ME, cwd: CWD, scanBudgetMs: 10 });
	await new Promise((resolve) => setTimeout(resolve, 10));
	release();
	const out = await pending;
	assert.equal(out.truncatedReason, "budget", "★ 预算是最终原因(worker 时序上两者可同时发生)");
	assert.equal(out.truncatedWindow, true);
	assert.equal(out.stoppedAtLimit, false, "★ 不能同时宣称'提前停手是正常收尾'");
	const body = renderHistoryBody({ ...out, query: "x", sessionId: ME, scope: { sessionId: ME, cwd: CWD } });
	assert.ok(body.includes("时间预算"));
	assert.equal(body.includes("返回条数已达上限"), false, "★ 两套矛盾口径不许同时出现");
});

test("★ 当前会话不在列表但同工作区有邻居:必须披露'当前会话缺席',不能静默扫邻居", async () => {
	const { sq } = fakeSessionQuery({
		async listSessions() { return [sessionRecord("a", { cwd: CWD })]; },
		async filterEvents(sessionId) {
			return [{ sessionId, seq: 1, type: "user/message", time: 1, surface: "current", text: "命中" }];
		}
	});
	const out = await searchCorpus(sq, { query: "x", limit: 5 }, { config: CONFIG, sessionId: ME, cwd: CWD });
	assert.equal(out.currentSessionMissing, true);
	assert.ok(out.degraded.includes("当前会话没有出现在会话列表里"));
	assert.equal(out.hits[0].sessionId, "a", "同工作区邻居仍然可以被搜到");
});

test("★ 工作区模式:全无命中时检查全部候选,不误报截断", async () => {
	const many = [
		sessionRecord(ME, { cwd: CWD, createdAt: 3000 }),
		sessionRecord("a", { cwd: CWD, createdAt: 2000 }),
		sessionRecord("b", { cwd: CWD, createdAt: 1000 })
	];
	const decoded = [];
	const { sq } = fakeSessionQuery({
		async listSessions() { return many; },
		async filterEvents(sessionId) { decoded.push(sessionId); return []; }
	});
	const out = await searchCorpus(sq, { query: "x", limit: 5 }, { config: CONFIG, sessionId: ME, cwd: CWD });
	assert.deepEqual(decoded, [ME, "a", "b"], "★ 全无命中 ⇒ 全部候选都要检查");
	assert.equal(out.inspected, 3);
	assert.equal(out.candidates, 3);
	assert.equal(out.stoppedAtLimit, false);
	assert.equal(out.truncatedWindow, false, "★ 检查完全部候选就不是截断");
});

test("★ 候选多于窗口上限且全无命中 → 如实报'候选窗口已用尽'", async () => {
	const many = [
		sessionRecord(ME, { cwd: CWD, createdAt: 9000 }),
		...Array.from({ length: INSPECT_MAX + 4 }, (_, index) => sessionRecord(`x${index}`, { cwd: CWD, createdAt: 8000 - index }))
	];
	const { sq } = fakeSessionQuery({
		async listSessions() { return many; },
		async filterEvents() { return []; }
	});
	const out = await searchCorpus(sq, { query: "x", limit: 5 }, { config: CONFIG, sessionId: ME, cwd: CWD });
	assert.equal(out.inspected, INSPECT_MAX, "★ 最多只检查 INSPECT_MAX 个候选");
	assert.equal(out.truncatedReason, "window");
	assert.equal(out.truncatedWindow, true);
	assert.equal(out.stoppedAtLimit, false, "★ 没凑够命中,不是'提前停手'");
});

test("★ 工作区路径比较:Windows 大小写/尾分隔符/正反斜杠都视为同一工作区", () => {
	const records = [
		sessionRecord(ME, { cwd: "C:\\Work\\Sub" }),
		sessionRecord("other", { cwd: "C:\\work\\sub\\" }),
		sessionRecord("slash", { cwd: "C:/Work/Sub" })
	];
	const kept = filterRecords(records, { cwd: "c:/WORK/SUB", currentSessionId: "none" })
		.map((record) => record.sessionId)
		.sort();
	if (process.platform === "win32") {
		assert.deepEqual(kept, ["other", "slash", ME].sort(), "★ win32 下四种写法是同一个工作区");
	} else {
		assert.deepEqual(kept, [], "大小写敏感文件系统上不能折叠,否则会跨目录");
	}
});

test("★ 当前会话自己是子代理会话时也不得被剔除(按 origin 过滤会让召回静默返回空)", async () => {
	// 用户在子代理会话里说触发词 ⇒ 当前会话的 header.origin === "subagent"。
	// 显式给了 id 就**不该**再套子代理过滤:那不是"更安全",那是坏掉(模型会以为历史里没有)。
	const records = [
		sessionRecord(ME, { cwd: CWD, origin: "subagent" }),
		sessionRecord(OTHER, { cwd: CWD, origin: "subagent" }),
		sessionRecord("third", { cwd: "D:\\elsewhere" })
	];
	// ① 纯函数层:显式 id 命中的记录必须存活,哪怕它是子代理来源
	assert.deepEqual(
		filterRecords(records, { sessionIds: [ME] }).map((record) => record.sessionId),
		[ME],
		"★ 子代理来源的当前会话必须存活"
	);
	// ② 端到端:扫描路径照样能读到它
	const { sq, calls } = fakeSessionQuery({
		async listSessions() { return records; },
		async filterEvents(sessionId) {
			calls.filterEvents.push({ sessionId });
			return [{ sessionId, seq: 4, type: "user/message", time: 1, surface: "current", text: "子代理会话里的历史" }];
		}
	});
	const out = await searchCorpus(sq, { query: "x", limit: 5 }, { config: CONFIG, sessionId: ME });
	assert.deepEqual(out.hits.map((hit) => hit.sessionId), [ME]);
	assert.deepEqual(calls.filterEvents.map((call) => call.sessionId), [ME], "别的会话(含子代理)一个都不读");
});

test("★ filterRecords:id-only;没有显式 id 时 fail closed(绝不等于'不过滤')", () => {
	const records = [sessionRecord(ME, { cwd: CWD }), sessionRecord(OTHER, { cwd: "D:\\other" })];
	assert.deepEqual(filterRecords(records, { sessionIds: [ME] }).map((record) => record.sessionId), [ME]);
	// ★ 必须禁止的语义:sessionIds 缺省/空数组 = 不过滤(即查全部)
	assert.deepEqual(filterRecords(records, { sessionIds: [] }), [], "空集合必须返回空(fail closed)");
	assert.deepEqual(filterRecords(records, {}), [], "缺省必须返回空(fail closed)");
	assert.deepEqual(filterRecords(records, { sessionIds: [OTHER, ME] }).map((record) => record.sessionId).sort(), [ME, OTHER], "给了哪些 id 就只留哪些");
	// 没有 id 的畸形记录不会被误当成匹配
	assert.deepEqual(filterRecords([{ header: {} }, sessionRecord(ME)], { sessionIds: [ME] }).map((record) => record.sessionId), [ME]);
	assert.deepEqual(filterRecords(undefined, { sessionIds: [ME] }), []);
});

test("★ 扫描兜底不调用 readTitleSnapshots(每个 id 都要重新解压整条日志,只为装饰性标题不划算)", async () => {
	const { sq, calls } = fakeSessionQuery({
		async listSessions() { return [sessionRecord(ME, { cwd: CWD })]; },
		async filterEvents(sessionId) { return [{ sessionId, seq: 5, type: "user/message", time: 1, surface: "current", text: "扫描命中" }]; }
	});
	const out = await searchCorpus(sq, { query: "x", limit: 5 }, { config: CONFIG, sessionId: ME });
	assert.equal(out.mode, "scan");
	assert.equal(out.hits.length, 1, "命中照旧要返回");
	assert.equal(calls.readTitleSnapshots.length, 0, "★ 绝不该为标题再解一遍日志");
	assert.equal(out.hits[0].title, undefined);
});

test("★ exec.signal 透到所有接受它的服务调用;filterEvents 不接受就不许凭空加", async () => {
	const controller = new AbortController();
	const seen = { searchSessions: [], listSessions: [], filterEventsArity: [], readEvent: [], readSurface: [] };
	const { sq } = fakeSessionQuery({
		async searchSessions(request, exec) { seen.searchSessions.push(exec); return { items: [] }; },
		async listSessions(signal) { seen.listSessions.push(signal); return [sessionRecord(ME, { cwd: CWD })]; },
		async filterEvents(...rest) {
			seen.filterEventsArity.push(rest.length);
			return [{ sessionId: rest[0], seq: 1, type: "user/message", time: 1, surface: "current", text: "命中" }];
		},
		async readEvent(request, signal) {
			seen.readEvent.push(signal);
			return { session: { id: request.sessionId }, inheritedEventCount: 0, startSeq: 1, endSeq: 1, target: null, events: [] };
		},
		async readSurface(sessionId, signal) {
			seen.readSurface.push(signal);
			return { session: { id: sessionId }, inheritedEventCount: 0, capturedThroughSeq: 1, events: [] };
		}
	});
	await searchCorpus(sq, { query: "x", limit: 5 }, { config: CONFIG, sessionId: ME, signal: controller.signal });
	assert.deepEqual(seen.searchSessions[0], { signal: controller.signal }, "★ searchSessions 第二参是执行上下文 { signal }(后端读 exec?.signal;传裸 Signal 会静默丢取消)");
	assert.equal(seen.listSessions[0], controller.signal, "listSessions 接受 Signal");
	assert.deepEqual(seen.filterEventsArity, [2], "★ filterEvents 没有 Signal 参数,只能传 (sessionId, filters)");
	await expandAt(sq, { sessionId: ME, seq: 1 }, CONFIG, controller.signal);
	assert.equal(seen.readEvent[0], controller.signal, "readEvent 接受 Signal");
	await expandTail(sq, ME, { signal: controller.signal });
	assert.equal(seen.readSurface[0], controller.signal, "readSurface 接受 Signal");
});

test("★ 已中止的信号:不抛、不假装扫完,交回中止前已拿到的部分", async () => {
	const controller = new AbortController();
	// 列表里故意放上别的会话:证明中止之后也不会去碰它
	const decoded = [];
	const { sq } = fakeSessionQuery({
		async listSessions() { return [sessionRecord(ME, { cwd: CWD }), sessionRecord(OTHER, { cwd: CWD })]; },
		async filterEvents(sessionId) {
			decoded.push(sessionId);
			controller.abort();   // 模拟用户在扫描途中打断这一轮
			return [{ sessionId, seq: 1, type: "user/message", time: 1, surface: "current", text: "命中" }];
		}
	});
	const out = await searchCorpus(sq, { query: "x", limit: 5 }, { config: CONFIG, sessionId: ME, signal: controller.signal });
	assert.equal(out.mode, "aborted");
	assert.equal(out.truncatedWindow, true);
	assert.equal(out.truncatedReason, "abort");
	assert.deepEqual(decoded, [ME], "★ 只解压当前会话");
	assert.equal(out.hits.length, 1, "★ 已经解压出来的命中必须交回去");
	const body = renderHistoryBody({ ...out, query: "x", sessionId: ME });
	assert.ok(body.includes("中止"), "★ 中止必须如实写进给模型的文本");
	assert.ok(body.includes("不完整"));
});

test("★ 扫描有时间预算:超预算就停止启动新会话,并如实标记结果不全", async (t) => {
	// 用 mock 时钟把"超预算"做成确定性的:预算为 0 ⇒ 第一个候选之前就已经超了
	t.mock.timers.enable({ apis: ["Date"], now: 0 });
	const { sq, calls } = fakeSessionQuery({
		async listSessions() { return [sessionRecord(ME, { cwd: CWD })]; }
	});
	const out = await searchCorpus(sq, { query: "x", limit: 5 }, { config: CONFIG, sessionId: ME, scanBudgetMs: 0 });
	assert.deepEqual(calls.filterEvents, [], "★ 预算用尽后不该再启动扫描");
	assert.equal(out.truncatedWindow, true, "★ 结果不全必须如实写出来,不能装作扫完了");
	assert.equal(out.truncatedReason, "budget");
	const body = renderHistoryBody({ ...out, query: "x", sessionId: ME });
	assert.ok(body.includes("时间预算"), "★ 预算耗尽要有一条只属于它的披露");
	assert.equal(body.includes("候选窗口已用尽"), false, "不要把「预算」说成「窗口」");
});

test("expandAt:成功窗口带 startSeq/endSeq/targetSeq;before 超限如实标记", async () => {
	const { sq, calls } = fakeSessionQuery({
		async readEvent(request) {
			calls.readEvent.push(request);
			return {
				session: { id: request.sessionId }, inheritedEventCount: 1, startSeq: 2, endSeq: 6,
				target: { seq: 4 }, events: [
					{ sessionId: request.sessionId, seq: 2, type: "user/message", time: 1, surface: "current", data: { content: [{ type: "text", text: "二" }] } },
					{ sessionId: request.sessionId, seq: 4, type: "assistant/message", time: 2, surface: "current", data: { message: { content: [{ type: "text", text: "四" }] } } }
				]
			};
		}
	});
	const out = await expandAt(sq, { sessionId: ME, seq: 4, before: 999, after: 0 }, CONFIG);
	assert.equal(out.ok, true);
	assert.equal(out.targetSeq, 4);
	assert.equal(out.startSeq, 2);
	assert.equal(out.endSeq, 6);
	assert.equal(out.clamped.before, true, "被夹住要如实说");
	assert.equal(calls.readEvent[0].before, 50, "夹到官方 readWindowMax");
	assert.deepEqual(out.events.map((event) => event.text), ["二", "四"]);
});

test("expandAt:官方 EVENT_NOT_FOUND 原样带出 code", async () => {
	const { sq } = fakeSessionQuery({
		async readEvent() {
			const error = new Error("no event at seq 99");
			error.code = "SESSION_QUERY_EVENT_NOT_FOUND";
			throw error;
		}
	});
	const out = await expandAt(sq, { sessionId: ME, seq: 99 }, CONFIG);
	assert.equal(out.ok, false);
	assert.equal(out.code, "SESSION_QUERY_EVENT_NOT_FOUND");
});

test("expandTail:不给 seq 时取该会话最近的表层事件", async () => {
	const { sq } = fakeSessionQuery({
		async readSurface(sessionId) {
			return {
				session: { id: sessionId }, inheritedEventCount: 0, capturedThroughSeq: 20,
				events: [
					{ sessionId, seq: 1, type: "user/message", time: 1, surface: "current", data: { content: [{ type: "text", text: "老" }] } },
					{ sessionId, seq: 2, type: "user/message", time: 2, surface: "current", data: { content: [{ type: "text", text: "新" }] } }
				]
			};
		}
	});
	const out = await expandTail(sq, ME);
	assert.equal(out.ok, true);
	assert.equal(out.targetSeq, null);
	assert.deepEqual(out.events.map((event) => event.text), ["老", "新"]);
});

test("expandTail:readSurface 不可用时明确报错(而不是假装空结果)", async () => {
	const out = await expandTail({}, ME);
	assert.equal(out.ok, false);
	assert.equal(out.code, "SESSION_QUERY_UNSUPPORTED");
});
