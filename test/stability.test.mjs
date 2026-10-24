/**
 * 稳定性**端到端**断言(合成数据,不读私有历史)。
 *
 * 覆盖三个入口:检索(scan/索引)、展开、压缩骨架;
 * 以及"预算/取消"的两条硬约束:
 *   ① 时间预算**单独不够** —— 必须有条数/源字符的确定性上界(不测墙钟);
 *   ② 结果封存之后,**不允许**再发布或改动脱敏统计。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";
import {
	EXPAND_MAX_SOURCE_CHARS,
	EXPAND_YIELD_EVERY,
	createBudget
} from "../lib/budget.js";
import { createRedactionContext, publish } from "../lib/publish.js";
import {
	normalizeConfig,
	renderCompactedBody,
	renderCompactedBodyAsync,
	renderExpandBody,
	renderExpandBodyAsync,
	renderHistoryBody
} from "../lib/recall.js";
import { searchCorpus } from "../lib/search.js";
import { fakeCtx, fakeSessionQuery, sessionRecord, userMessage } from "./helpers.mjs";

const ME = "synthetic-current";
const AGENT = { id: ME };
const SCOPE = { sessionId: ME, cwd: "C:\\work" };
const CONFIG = normalizeConfig();

/** 造 N 条被压缩掉的用户消息(seq 递增)。 */
function shadowedDocs(count, { text = "历史正文", startSeq = 1 } = {}) {
	return Array.from({ length: count }, (_, index) => ({
		sessionId: ME,
		seq: startSeq + index,
		type: "user/message",
		time: 1000 + index,
		surface: "shadowed",
		text
	}));
}

function compactedValue(docs, extra = {}) {
	return {
		sessionId: ME,
		scope: SCOPE,
		docs,
		counts: { current: 0, shadowed: docs.length, "log-only": 0 },
		others: [],
		budget: 3000,
		...extra
	};
}

test("同步/异步骨架对同一输入逐字一致", async () => {
	const docs = shadowedDocs(12);
	docs.push({ sessionId: ME, seq: 100, type: "tool/call", time: 2000, surface: "shadowed", text: 'grep\n{"pattern":"x"}' });
	docs.push({ sessionId: ME, seq: 101, type: "tool/result", time: 2001, surface: "shadowed", text: "文件内容摘要" });
	docs.sort((a, b) => a.seq - b.seq);
	const sync = renderCompactedBody(compactedValue(docs));
	const asyncBody = await renderCompactedBodyAsync(compactedValue(docs), { budget: createBudget() });
	assert.equal(asyncBody, sync);
	assert.ok(sync.includes("★ 区间首条用户消息"));
	assert.ok(sync.includes("★ 区间末条用户消息"));
});

test("条数上界对同步通道同样生效:正常渲染器只渲染确定性子集", () => {
	// 5100 > COMPACT_MAX_DOCS(5000):必须截断并**如实标注**。
	// ★ 区间覆盖:5000 前缀 + 64 尾窗 = 5064 < 5100 ⇒ 本轮**没有**全量覆盖区间,
	//   所以只能称"本次已展开的"首/末条,不能谎称"区间末条"(真实末条可能没进来)。
	const docs = shadowedDocs(5100, { text: "历史" });
	const body = renderCompactedBody(compactedValue(docs));
	assert.ok(body.includes("本次只展开了区间内"), "触界必须写出来");
	assert.ok(body.includes("/5100"), `标注里要有真实总量:${body.slice(0, 400)}`);
	assert.ok(body.includes("5000 条上限"), "原因要说清是条数上限");
	assert.ok(body.includes("★ 本次已展开的首条用户消息"), "部分展开只能称'本次已展开的'");
	assert.ok(body.includes("★ 本次已展开的末条用户消息 seq=5100"),
		"末尾窗口仍尽力覆盖末条,但措辞不得冒充区间末条");
	assert.equal(body.includes("★ 区间末条用户消息"), false,
		"★ 区间覆盖:未全量覆盖(5064/5100)时不得声称区间末条");
	// 同一个 seq 不得出现两次
	const listed = [...body.matchAll(/^(?:---\s*seq\s*(\d+)|seq=(\d+)|★ (?:区间|本次已展开的)(?:首|末)条用户消息 seq=(\d+))/gmu)]
		.map((hit) => hit[1] ?? hit[2] ?? hit[3]);
	const dupes = listed.filter((seq, index) => listed.indexOf(seq) !== index);
	assert.deepEqual(dupes, [], `重复的 seq:${dupes.join(",")}`);
});

test("区间覆盖残余:level=4 抽样文案只能说“首末消息锚点”,不得声称区间首末", async () => {
	// 前 5000 条用户 + 中间 30 条用户 + 末 70 条助手 = 5100 条。
	// 前缀吃满 5000 条;尾窗 64 条全部落在末 70 条助手里 ⇒
	// 真正的末条用户 seq=5030 **没有**被准入,只能把本次已展开的 seq=5000 当末条。
	const docs = [
		...Array.from({ length: 5000 }, (_, index) => ({
			sessionId: ME, seq: 1 + index, type: "user/message", time: 1000 + index, surface: "shadowed", text: "历史"
		})),
		...Array.from({ length: 30 }, (_, index) => ({
			sessionId: ME, seq: 5001 + index, type: "user/message", time: 6000 + index, surface: "shadowed", text: "历史"
		})),
		...Array.from({ length: 70 }, (_, index) => ({
			sessionId: ME, seq: 5031 + index, type: "assistant/message", time: 7000 + index, surface: "shadowed", text: "助手历史"
		}))
	];
	const budget = createBudget({ maxDocs: 5000, maxSourceChars: 1_500_000, now: () => 0 });
	const body = await renderCompactedBodyAsync(compactedValue(docs), { budget });
	assert.equal(budget.stats().docs, 5064, "★ 5000 前缀 + 64 尾窗 = 5064");
	assert.ok(body.includes("本次只展开了区间内 5064/5100"), body.slice(0, 400));
	assert.ok(body.includes("以下是**抽样骨架**"), "必须走到 level=4");
	assert.ok(body.includes("★ 本次已展开的末条用户消息 seq=5000"),
		"★ 实际末条用户 seq=5030 未准入,只能把本次已展开的 seq=5000 当末条");
	assert.equal(body.includes("seq=5030"), false, "未准入的末条用户不得凭空出现");
	assert.equal(body.includes("区间首末锚点见上面"), false,
		"★ 部分覆盖时“区间首末锚点”是假话(上方只是本次的锚点)");
	assert.ok(body.includes("首末消息锚点见上面"), "抽样文案用中性的“首末消息锚点”");
	assert.equal(body.includes("★ 区间末条用户消息"), false);
});

test("源字符上界:超界整条跳过(绝不裁切原文),并如实标注原因", async () => {
	const docs = Array.from({ length: 6 }, (_, index) => ({
		sessionId: ME,
		seq: 10 + index,
		type: "user/message",
		time: 100 + index,
		surface: "shadowed",
		text: `KEY-${index} ${"x".repeat(96)}`
	}));
	const budget = createBudget({ maxDocs: 100, maxSourceChars: 250, now: () => 0 });
	const body = await renderCompactedBodyAsync(compactedValue(docs), { budget });
	// 250 / 100 ⇒ 只准入 2 条;后面的整条不处理(不是"取前 250 字符")。
	assert.ok(body.includes("本次只展开了区间内 2/6"), body.slice(0, 400));
	assert.ok(body.includes("250 源字符上限"), "原因必须写清是源字符上限");
	for (const omitted of [2, 3, 4, 5]) {
		assert.equal(body.includes(`KEY-${omitted}`), false, `被跳过的事件不得出现任何片段(KEY-${omitted})`);
	}
	assert.ok(body.includes("KEY-0") && body.includes("KEY-1"));
	// ★ 区间覆盖回归:真实区间是 seq 10..15,字符额度只够前两条(seq 10、11)。
	//   seq=11 不是区间末条,把它印成"★ 区间末条"就是假话(真实末条 seq=15)。
	assert.ok(body.includes("区间:seq 10..15"), "真实区间必须写出,不能只给已展开的部分");
	assert.ok(body.includes("★ 本次已展开的首条用户消息 seq=10"), "部分展开时首条要标明是'本次已展开的'");
	assert.ok(body.includes("★ 本次已展开的末条用户消息 seq=11"), "本次已展开到的末条可以给,但不能冒充区间末条");
	assert.equal(body.includes("★ 区间末条用户消息"), false,
		"★ 区间覆盖:字符上限只准入前 2 条时,seq=11 不是区间末条(真实末条 seq=15);不得为了保锚点越过源字符限");
	// ★ 区间覆盖同类文案:level=1 的“覆盖上面整个区间”在部分展开时同样是假话。
	//   这里需要第三条非锚点条目,才能走到 level=1 的标签分支。
	const four = Array.from({ length: 4 }, (_, index) => ({
		sessionId: ME,
		seq: 20 + index,
		type: "user/message",
		time: 200 + index,
		surface: "shadowed",
		text: `MID-${index} ${"y".repeat(50)}`
	}));
	const labelBody = await renderCompactedBodyAsync(compactedValue(four), {
		budget: createBudget({ maxDocs: 100, maxSourceChars: 200, now: () => 0 })
	});
	assert.ok(labelBody.includes("本次只展开了区间内 3/4"), labelBody.slice(0, 300));
	assert.equal(labelBody.includes("覆盖上面整个区间"), false, "部分展开时不得声称骨架覆盖整个区间");
	assert.ok(labelBody.includes("只覆盖上面已展开的这部分候选"), "必须说明骨架只覆盖已展开子集");
});

test("工具调用的配对结果正文也计入源字符上界(否则可绕过上界)", async () => {
	// 三条 tool/call:call 本身很小,但配对的 tool/result 各 200 字符。
	// 若只计 call 的长度,三条都会被准入 ⇒ 完整脱敏量是上界的很多倍。
	const docs = [1, 2, 3].map((index) => ({
		sessionId: ME,
		seq: index * 2,
		type: "tool/call",
		time: index,
		surface: "shadowed",
		text: `read\n{"file_path":"f${index}.md"}`
	}));
	const results = [1, 2, 3].map((index) => ({
		sessionId: ME,
		seq: index * 2 + 1,
		type: "tool/result",
		time: index,
		surface: "shadowed",
		text: "结果".repeat(100)
	}));
	const all = [...docs, ...results].sort((a, b) => a.seq - b.seq);
	const budget = createBudget({ maxDocs: 100, maxSourceChars: 300, now: () => 0 });
	const body = await renderCompactedBodyAsync(compactedValue(all), { budget });
	assert.ok(body.includes("本次只展开了区间内 1/3"), body.slice(0, 300));
	assert.ok(body.includes("300 源字符上限"));
});

test("取消发生在让出时:优雅收尾、标注'本轮已取消',不抛错", async () => {
	const controller = new AbortController();
	const docs = shadowedDocs(200, { text: "历史" });
	const budget = createBudget({
		signal: controller.signal,
		yieldFn: async () => { controller.abort(); }
	});
	const body = await renderCompactedBodyAsync(compactedValue(docs), { budget, yieldEvery: 16 });
	assert.ok(body.includes("本轮已取消"), body.slice(0, 400));
	// 确定性进度:16 篇一批,第一次让出后就取消 ⇒ 恰好吃掉 16 篇。
	assert.ok(body.includes("16/200"), `进度应确定:${body.slice(0, 300)}`);
});

test("让出次数是可数的(不靠墙钟推断)", async () => {
	let yields = 0;
	const docs = shadowedDocs(200, { text: "历史" });
	await renderCompactedBodyAsync(compactedValue(docs), {
		budget: createBudget({ yieldFn: async () => { yields += 1; } }),
		yieldEvery: 16
	});
	assert.equal(yields, Math.floor(200 / 16), "200 篇 / 每 16 篇 = 12 次让出");
});

test("展开:源字符上界整条跳过;被跳过的事件不留任何片段", () => {
	const huge = "password=SYNTHETIC-EXPAND-X " + "b".repeat(EXPAND_MAX_SOURCE_CHARS + 10);
	const body = renderExpandBody({
		sessionId: ME,
		scope: SCOPE,
		startSeq: 1,
		endSeq: 2,
		targetSeq: null,
		inheritedEventCount: 0,
		clamped: { before: false, after: false },
		events: [
			{ seq: 1, type: "user/message", time: 1, text: "第一条正常事件" },
			{ seq: 2, type: "user/message", time: 2, text: huge }
		]
	});
	assert.ok(body.includes("第一条正常事件"));
	assert.equal(body.includes("SYNTHETIC-EXPAND-X"), false, "被跳过的事件不得泄露");
	assert.equal(body.includes("--- seq=2"), false, "整条跳过,不印半条");
	assert.ok(body.includes("另有 1 条事件未展开"));
});

test("未完成检索:中止/预算/未查完的零命中不得冒充完整零命中(纯函数 + 生产路径)", async () => {
	const aborted = renderHistoryBody({ mode: "aborted", hits: [], truncatedWindow: true, truncatedReason: "abort" });
	assert.equal(aborted.includes("本次范围内没有命中的片段"), false, "中止不是完整零命中");
	assert.ok(aborted.includes("不等于整个范围没有命中"));
	assert.ok(aborted.includes("本轮未完成"), "零命中行必须标明本轮未完成");

	const budget = renderHistoryBody({
		mode: "scan", query: "x", sessionId: "s1", inspected: 2, candidates: 9,
		hits: [], truncatedWindow: true, truncatedReason: "budget"
	});
	assert.equal(budget.includes("本次范围内没有命中的片段"), false);
	assert.ok(budget.includes("扫描预算已用尽"));
	assert.ok(budget.includes("不等于整个范围没有命中"));

	// 纯函数直接给 truncatedReason(不带 truncatedWindow)也必须算未完成。
	const reasonOnly = renderHistoryBody({
		mode: "scan", query: "x", sessionId: "s1", inspected: 2, candidates: 2,
		hits: [], truncatedReason: "budget"
	});
	assert.equal(reasonOnly.includes("本次范围内没有命中的片段"), false);
	assert.ok(reasonOnly.includes("扫描预算已用尽"));

	const complete = renderHistoryBody({ mode: "scan", query: "x", sessionId: "s1", inspected: 3, candidates: 3, hits: [] });
	assert.ok(complete.includes("本次范围内没有命中的片段"), "真正扫完的零命中保留原句");

	// 生产路径:预取消的 exec.signal 走 abortResult,仍 ok:true + 部分结果标注。
	const controller = new AbortController();
	controller.abort();
	const { sq } = fakeSessionQuery({
		async listSessions() { return [sessionRecord(ME, { cwd: "C:\\work" })]; }
	});
	const { ctx, tools } = fakeCtx({ sessionQuery: sq });
	apply(ctx, {});
	const value = await tools.get("recall_history").execute({ query: "x" }, { agent: AGENT, signal: controller.signal });
	assert.equal(value.ok, true);
	assert.equal(value.published.text.includes("本次范围内没有命中的片段"), false,
		"★ 生产路径不能用'没有命中'掩盖'没查完'");
	assert.ok(value.published.text.includes("不等于整个范围没有命中"));
});

test("未完成检索残余:扫描时单会话读取失败 ⇒ incomplete,生产正文不得冒充完整零命中", async () => {
	let reads = 0;
	const { sq } = fakeSessionQuery({
		async searchSessions() { return { items: [] }; },
		async listSessions() { return [sessionRecord(ME, { cwd: "C:\\work" })]; },
		async filterEvents() {
			reads += 1;
			const error = new Error("synthetic-only read failure");
			error.code = "SYNTHETIC_READ_FAILURE";
			throw error;
		}
	});
	const result = await searchCorpus(sq, { query: "x", limit: 5 }, {
		config: CONFIG, sessionId: ME, cwd: "C:\\work"
	});
	assert.equal(result.mode, "scan");
	assert.equal(result.inspected, 1);
	assert.equal(result.candidates, 1);
	assert.equal(result.incomplete, true, "★ 读取失败不等于检查完成");
	assert.ok(result.error.includes("synthetic-only read failure"));

	// 生产入口(recall_history):正文不得把读取失败说成完整零命中。
	const { ctx, tools } = fakeCtx({ sessionQuery: sq });
	apply(ctx, {});
	const value = await tools.get("recall_history").execute({ query: "x" }, { agent: AGENT });
	assert.equal(value.ok, true);
	assert.equal(reads, 2, "底层契约 + 生产入口各读一次");
	assert.equal(value.published.text.includes("本次范围内没有命中的片段"), false,
		"★ 生产入口不得把读取失败说成完整零命中");
	assert.ok(value.published.text.includes("不等于整个范围没有命中"));
	assert.ok(value.published.text.includes("本轮未完成"));
});

test("取消与让出:展开异步入口接预算/批间让出,取消后不再展开后续事件", async () => {
	const events = Array.from({ length: 20 }, (_, index) => ({
		seq: index + 1, type: "user/message", time: index, text: `事件${index}`
	}));
	const value = {
		sessionId: ME, scope: SCOPE, startSeq: 1, endSeq: 20, targetSeq: null,
		inheritedEventCount: 0, clamped: { before: false, after: false }, events
	};
	const sync = renderExpandBody(value);
	const asyncBody = await renderExpandBodyAsync(value, {
		budget: createBudget({ yieldFn: async () => {} }),
		yieldEvery: EXPAND_YIELD_EVERY
	});
	assert.equal(asyncBody, sync, "完整窗口时同步/异步逐字一致");

	let yields = 0;
	await renderExpandBodyAsync(value, {
		budget: createBudget({ yieldFn: async () => { yields += 1; } }),
		yieldEvery: EXPAND_YIELD_EVERY
	});
	assert.equal(yields, 2, "20 条 / 每 8 条 = 2 次让出(最后一批不空转)");

	const controller = new AbortController();
	const partial = await renderExpandBodyAsync(value, {
		budget: createBudget({ signal: controller.signal, yieldFn: async () => { controller.abort(); } }),
		yieldEvery: EXPAND_YIELD_EVERY
	});
	assert.ok(partial.includes("本轮已取消"), partial.slice(0, 300));
	assert.ok(partial.includes("只展开了窗口内前 8 条事件"), partial.slice(0, 300));
	assert.ok(partial.indexOf("本轮已取消") < partial.indexOf("--- seq=1"),
		"未完成标注必须在正文之前,不能被 publish 截断吃掉");
	assert.equal(partial.includes("事件19"), false, "取消后不得继续脱敏/展开后续事件");

	const expired = await renderExpandBodyAsync(value, { budget: createBudget({ deadlineMs: 0 }) });
	assert.ok(expired.includes("时间预算已用尽"));
	assert.ok(expired.includes("前 0 条事件"), "到期时如实写出零进度,不伪装完整");

	// 源字符上界:超界整条跳过,绝不在脱敏前裁切原文。
	const huge = "EXPAND-SKIP " + "x".repeat(EXPAND_MAX_SOURCE_CHARS + 10);
	const bounded = await renderExpandBodyAsync({
		...value,
		events: [{ seq: 1, type: "user/message", time: 1, text: "正常第一条" }, { seq: 2, type: "user/message", time: 2, text: huge }]
	}, { budget: createBudget() });
	assert.ok(bounded.includes("正常第一条"));
	assert.equal(bounded.includes("EXPAND-SKIP"), false, "超界事件整条不读,不得留下半截");
	assert.ok(bounded.includes("另有 1 条事件未展开"));
});

test("取消与让出生产路径:recall_expand 在批间让出后响应取消,并如实标注未完成", async () => {
	const controller = new AbortController();
	const events = Array.from({ length: 20 }, (_, index) => ({
		seq: index + 1, type: "user/message", time: index, text: `生产事件${index}`
	}));
	const { sq } = fakeSessionQuery({
		async readEvent(request) {
			return {
				session: { id: request.sessionId }, inheritedEventCount: 0,
				startSeq: 1, endSeq: 20, target: null, events
			};
		}
	});
	const { ctx, tools } = fakeCtx({ sessionQuery: sq, cwd: "C:\\work" });
	apply(ctx, {});
	// 让中止发生在第一次批间让出之后(check 阶段先于渲染器的 setImmediate)。
	setImmediate(() => controller.abort());
	const value = await tools.get("recall_expand").execute(
		{ sessionId: ME, seq: 1 },
		{ agent: AGENT, signal: controller.signal }
	);
	assert.equal(value.ok, true, "已算出的部分结果仍要返回");
	assert.ok(value.published.text.includes("本轮已取消"), value.published.text.slice(0, 400));
	assert.ok(value.published.text.includes("只展开了窗口内前 8 条事件"), "生产路径必须走异步渲染器并让出");
	assert.equal(value.published.text.includes("生产事件19"), false, "取消后不得继续展开后续事件");

	// ★ 预取消先于跨会话 isSessionInScope:不得先调宿主 filterSessions(否则会被
	//   它的 AbortError 吞成"范围外",code 与原因都不对)。
	const preAborted = new AbortController();
	preAborted.abort();
	let filterCalls = 0;
	const scoped = fakeSessionQuery({
		async filterSessions() { filterCalls += 1; return []; }
	});
	const second = fakeCtx({ sessionQuery: scoped.sq, cwd: "C:\\work" });
	apply(second.ctx, {});
	const blocked = await second.tools.get("recall_expand").execute(
		{ sessionId: "other-session", seq: 1 },
		// ★ resolveScope 的 cwd 权威来源是 agent.session.header.cwd(不是 agent.cwd);
		//   不这样传,isSessionInScope 会因 cwd 缺失直接 return false,filterCalls 断为空转。
		{ agent: { id: ME, session: { header: { id: ME, cwd: "C:\\work" } } }, signal: preAborted.signal }
	);
	assert.equal(blocked.ok, false);
	assert.equal(blocked.error.code, "SESSION_QUERY_CANCELLED");
	assert.equal(filterCalls, 0, "预取消时一个宿主范围查询都不该发出");
});

test("检索:时间预算为零 ⇒ 一个会话都不扫,并如实标'预算'", async () => {
	let reads = 0;
	const { sq } = fakeSessionQuery({
		async listSessions() { return [sessionRecord(ME, { cwd: "C:\\work" })]; },
		async filterEvents() { reads += 1; return []; }
	});
	const result = await searchCorpus(sq, { query: "x", limit: 3 }, {
		config: CONFIG, sessionId: ME, cwd: "C:\\work", budget: createBudget({ deadlineMs: 0 })
	});
	assert.equal(reads, 0, "预算一开始就用尽:不启动任何读取");
	assert.equal(result.inspected, 0);
	assert.equal(result.truncatedReason, "budget");
});

test("检索:硬取消(预算)按'已中止'收尾,不谎报服务故障", async () => {
	const controller = new AbortController();
	controller.abort();
	const { sq } = fakeSessionQuery({
		async listSessions() { return [sessionRecord(ME, { cwd: "C:\\work" })]; }
	});
	const result = await searchCorpus(sq, { query: "x" }, {
		config: CONFIG, sessionId: ME, cwd: "C:\\work", signal: controller.signal, budget: createBudget({ signal: controller.signal })
	});
	assert.equal(result.mode, "aborted");
	assert.equal(result.truncatedReason, "abort");
});

test("工具路径:封存之后不得再发布,脱敏统计冻结", async () => {
	const { sq } = fakeSessionQuery({
		async searchSessions() {
			return { items: [{
				header: { id: ME, cwd: "C:\\work", createdAt: 1 },
				live: true,
				persisted: false,
				bestMatch: { sessionId: ME, seq: 1, type: "user/message", time: 1, surface: "current", snippet: "password=SYNTHETIC-HIT" }
			}] };
		},
		async filterEvents(sessionId, filters) {
			return [{ sessionId, seq: filters[0].from, type: "user/message", time: 1, surface: "current", text: "password=SYNTHETIC-HIT" }];
		}
	});
	const { ctx, tools } = fakeCtx({ sessionQuery: sq });
	apply(ctx, {});
	const value = await tools.get("recall_history").execute({ query: "命中" }, { agent: AGENT });
	assert.equal(value.ok, true);
	// 返回值形状不变(宿主 schema 是 additionalProperties:false)
	assert.deepEqual(Object.keys(value).sort(), ["mode", "ok", "published"]);
	assert.ok(Object.keys(value.published).includes("text"));
	assert.equal(JSON.stringify(value).includes("SYNTHETIC-HIT"), false, "命中文本必须先脱敏");
});

test("工具路径:压缩模式在预取消时显式失败,一个字都不读", async () => {
	const controller = new AbortController();
	controller.abort();
	let reads = 0;
	const { sq } = fakeSessionQuery({ async filterEvents() { reads += 1; return []; } });
	const { ctx, tools } = fakeCtx({ sessionQuery: sq });
	apply(ctx, {});
	const value = await tools.get("recall_history").execute({}, { agent: AGENT, signal: controller.signal });
	assert.equal(value.ok, false);
	assert.equal(reads, 0);
	assert.deepEqual(Object.keys(value).sort(), ["error", "mode", "ok", "published"], "失败值形状不变");
	assert.equal(typeof value.error.code, "string");
});

test("压缩骨架:封存后 publication 被拒(收尾之后不再补发布)", () => {
	const budget = createBudget();
	const redaction = createRedactionContext({ budget });
	const published = publish("正文", { redaction, budget });
	assert.ok(published.text.length > 0);
	budget.seal();
	assert.throws(() => publish("补发布", { budget }), (error) => error.reason === "sealed");
	assert.throws(() => redaction.text("password=SYNTHETIC-LATE"), (error) => error.reason === "sealed");
});

test("自动路径的预算与工具路径分离:8s 只用于 pre-step", async () => {
	// 自动注入:注入块仍受发布预算约束(既有断言),且不得因为预算机制而多出一条消息。
	const { sq } = fakeSessionQuery({
		async filterEvents() { return [{ sessionId: ME, seq: 7, type: "user/message", time: 1, surface: "shadowed", text: "被挤掉的一句" }]; }
	});
	const { ctx, listeners } = fakeCtx({ sessionQuery: sq });
	apply(ctx, {});
	const decision = { kind: "enter", messages: [userMessage("Memory unlocked")] };
	const out = await listeners.get("agent/pre-step")({ agent: AGENT, turn: 1, step: 1, messages: decision.messages }, async () => decision);
	assert.equal(out.messages.length, 2, "只追加一条注入消息");
	assert.ok(out.messages[1].content[0].text.includes("被挤掉的一句"));
});
