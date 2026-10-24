/**
 * 纯函数层测试:配置 / 校验 / 请求构造 / 触发词 / 幂等 / 合成消息 / 渲染。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CONFIG,
	DEFAULT_TRIGGERS,
	INJECTED_ID_PREFIX,
	MAX_LIMIT,
	MAX_QUERY_CHARS,
	MAX_WINDOW,
	buildInjectedMessage,
	buildReadEventRequest,
	buildSearchRequest,
	createTurnGuard,
	findTrigger,
	formatTime,
	messageText,
	normalizeConfig,
	normalizeTriggers,
	renderExpandBody,
	renderHistoryBody,
	renderUnavailable,
	resolveSessionId,
	validateExpandArgs,
	validateHistoryArgs
} from "../lib/recall.js";
import { userMessage } from "./helpers.mjs";

test("normalizeConfig:默认值 / 非法回落 / 夹取;★ 范围类旋钮根本不存在", () => {
	assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
	assert.deepEqual(normalizeConfig("垃圾"), DEFAULT_CONFIG);
	const cfg = normalizeConfig({
		enabled: false, trigger: "  回忆一下  ", limit: 999, maxInjectChars: 10,
		before: 999, after: -1,
		// ★ 下面这三个都不是配置项:硬塞进来也必须毫无效果
		scope: "cwd", includeSubagents: true, sessionIds: ["other-session"]
	});
	assert.equal(cfg.enabled, false);
	assert.deepEqual(cfg.triggers, ["回忆一下"], "单值 trigger 写法也必须工作");
	assert.equal(cfg.limit, MAX_LIMIT, "limit 夹到上限");
	assert.equal(cfg.maxInjectChars, 400, "预算夹到下限");
	assert.equal(cfg.before, MAX_WINDOW);
	assert.equal(cfg.after, 0);
	// ★ 范围不是配置项:配了也**不进配置对象**,更不可能影响检索范围
	assert.equal("scope" in cfg, false, "★ scope 不是配置项(范围是安全边界,不是偏好)");
	assert.equal("includeSubagents" in cfg, false, "★ includeSubagents 不是配置项");
	assert.deepEqual(normalizeConfig({ scope: "all" }), DEFAULT_CONFIG, "★ 传了 scope 等于没传");
	assert.deepEqual(normalizeConfig({ scope: "cwd", includeSubagents: true }), DEFAULT_CONFIG);
	assert.deepEqual(normalizeConfig({ trigger: "   " }).triggers, DEFAULT_CONFIG.triggers);
	assert.deepEqual(normalizeConfig().triggers, ["Memory unlocked", "大记忆恢复术", "DJYHFS"], "★ 三个出厂触发词都要在");
});

test("★ resolveSessionId:会话头 id 优先,其次 agent.id;拿不到就 undefined(调用方必须 fail closed)", () => {
	assert.equal(resolveSessionId({ session: { header: { id: "s1" } }, id: "s2" }), "s1", "会话头是权威来源");
	assert.equal(resolveSessionId({ id: "s2" }), "s2", "退回宿主契约 Agent.id");
	assert.equal(resolveSessionId({ session: { header: { id: "s1" } } }), "s1");
	// 会话头 id 空串 ⇒ 继续看 agent.id(两者指的都是**当前**会话,不存在放宽)
	assert.equal(resolveSessionId({ session: { header: { id: "" } }, id: "s2" }), "s2");
	// 拿不到的一律 undefined —— 调用点据此 fail closed,**不许**回落成"更大范围"
	for (const bad of [
		undefined, null, {}, { id: "" }, { id: 7 }, { id: "a\0b" },
		{ session: { header: {} } }, { session: { header: { id: 42 } } }, "s1", 42, []
	]) {
		assert.equal(resolveSessionId(bad), undefined, `输入 ${JSON.stringify(bad) ?? String(bad)} 必须解析不出会话`);
	}
});

test("validateHistoryArgs:合法与各种非法;★ scope/sessionIds 被无视(既不校验也不使用)", () => {
	assert.equal(validateHistoryArgs({}), null, "不带任何参数是合法的");
	assert.equal(validateHistoryArgs({ query: "证书" }), null);
	assert.equal(validateHistoryArgs({ query: "", limit: 3 }), null);
	assert.match(validateHistoryArgs({ query: 42 }), /字符串/u);
	assert.match(validateHistoryArgs({ query: "x".repeat(501) }), /太长/u);
	assert.match(validateHistoryArgs({ limit: 0 }), /limit/u);
	assert.match(validateHistoryArgs({ limit: MAX_LIMIT + 1 }), /limit/u);
	assert.match(validateHistoryArgs({ limit: 1.5 }), /limit/u);
	// ★ 范围类参数不生效:调用方硬塞这些字段**不报错**(忽略,而不是校验)——
	//   一旦"校验"它们,就等于承认它们有意义,下一个读代码的人可能把它们接回去。
	assert.equal(validateHistoryArgs({ scope: "everything" }), null, "★ scope 不参与校验:它不是配置项");
	assert.equal(validateHistoryArgs({ sessionIds: [] }), null);
	assert.equal(validateHistoryArgs({ sessionIds: ["other-session", 7] }), null);
	// 该报的错照旧报(query 仍然校验),忽略了旋钮不等于关掉校验
	assert.match(validateHistoryArgs({ query: 42, scope: "cwd" }), /字符串/u);
});

test("validateExpandArgs:sessionId 可省略(=当前会话);给了就必须是非空字符串", () => {
	assert.equal(validateExpandArgs({}), null, "★ 省略 sessionId 是合法的(范围就是当前会话)");
	assert.equal(validateExpandArgs({ seq: 1 }), null);
	assert.equal(validateExpandArgs({ sessionId: "s1" }), null);
	assert.equal(validateExpandArgs({ sessionId: "s1", seq: 0, before: MAX_WINDOW }), null);
	assert.match(validateExpandArgs({ sessionId: "" }), /sessionId/u);
	assert.match(validateExpandArgs({ sessionId: 7 }), /sessionId/u);
	assert.match(validateExpandArgs({ sessionId: "a\0b" }), /NUL/u);
	assert.match(validateExpandArgs({ sessionId: "s1", seq: -1 }), /seq/u);
	assert.match(validateExpandArgs({ sessionId: "s1", before: MAX_WINDOW + 1 }), /before/u);
	assert.match(validateExpandArgs({ sessionId: "s1", after: -2 }), /after/u);
});

test("buildSearchRequest:★ 范围只可能是'工作区(cwd 已知)'或'当前会话(cwd 未知)',没有'不加过滤器'的分支", () => {
	// ① cwd 已知 ⇒ 当前工作区
	const req = buildSearchRequest({ query: " 证书 " }, normalizeConfig(), { sessionId: "sess-1", cwd: "C:\\work" });
	assert.equal(req.query, "证书", "查询应被 trim(后端自己做转义,不拼 FTS)");
	assert.equal(req.limit, DEFAULT_CONFIG.limit);
	assert.deepEqual(req.sessionFilters, [{ kind: "cwd", values: ["C:\\work"] }], "★ 范围 = 当前工作区");

	// ② cwd 未知 ⇒ 退化为当前会话(**更窄**,安全方向)
	const noCwd = buildSearchRequest({ query: "x" }, normalizeConfig(), { sessionId: "sess-1" });
	assert.deepEqual(noCwd.sessionFilters, [{ kind: "id", values: ["sess-1"] }],
		"★ 拿不到 cwd 就只看当前会话(绝不退回到更宽的范围)");

	// ③ ★ 范围不可配置:即使调用方硬塞 scope / sessionIds,也**不读**(范围只由调用点给的 scope 决定)
	const hostile = buildSearchRequest(
		{ query: "x", scope: "all", sessionIds: ["other-session"], limit: 2 },
		normalizeConfig({ scope: "cwd", includeSubagents: true }),
		{ sessionId: "sess-1", cwd: "C:\\work" }
	);
	assert.deepEqual(hostile.sessionFilters, [{ kind: "cwd", values: ["C:\\work"] }],
		"★ 请求里的范围只由调用点的 scope 决定");
	assert.equal(JSON.stringify(hostile).includes("other-session"), false, "★ 别的会话 id 不得出现在请求里");
	assert.equal(hostile.limit, 2, "limit 正常生效");

	// 没有任何入参能产出"不带过滤器"的请求(不能让 sessionIds 缺省就变成"不加过滤器")
	for (const evil of [{}, { query: "x" }, { scope: "all" }, { sessionIds: [] }, { sessionIds: ["a", "b"] }, { scope: "cwd" }]) {
		const built = buildSearchRequest(evil, normalizeConfig(), { sessionId: "sess-1" });
		assert.deepEqual(built.sessionFilters, [{ kind: "id", values: ["sess-1"] }],
			`入参 ${JSON.stringify(evil)} 也必须带当前会话过滤器`);
	}
	// sessionId 非法时过滤器**仍然在**(会匹配不到任何会话),而不是消失 —— 依然是 fail closed
	const noId = buildSearchRequest({ query: "x" }, normalizeConfig(), { sessionId: undefined });
	assert.equal(noId.sessionFilters.length, 1);
	assert.equal(noId.sessionFilters[0].kind, "id");
	assert.equal(noId.sessionFilters[0].values.length, 1);
	assert.equal(noId.sessionFilters[0].values[0], undefined);
	// ★ 连 scope 都不传时也一样(不能因为少传参数就没过滤器)
	assert.deepEqual(buildSearchRequest({ query: "x" }, normalizeConfig()).sessionFilters, [{ kind: "id", values: [undefined] }]);

	assert.equal(buildSearchRequest({ query: "x" }, normalizeConfig({ limit: 99 }), { sessionId: "s" }).limit, MAX_LIMIT);
});

test("buildReadEventRequest:before/after 夹在官方 readWindowMax 内", () => {
	assert.deepEqual(buildReadEventRequest({ sessionId: "s", seq: 5 }), { sessionId: "s", seq: 5, before: 3, after: 3 });
	assert.deepEqual(buildReadEventRequest({ sessionId: "s", seq: 5, before: 999, after: -3 }, normalizeConfig()).before, MAX_WINDOW);
	assert.equal(buildReadEventRequest({ sessionId: "s", seq: 5, after: 999 }).after, MAX_WINDOW);
});

test("★ findTrigger:五种情况", () => {
	// ① 只说触发词
	assert.deepEqual(findTrigger([userMessage("大记忆恢复术")]), { keyword: "", messageIndex: 0, rawTail: "" });
	// ② 不命中
	assert.equal(findTrigger([userMessage("今天天气不错")]), null);
	assert.equal(findTrigger([]), null);
	assert.equal(findTrigger(undefined), null);
	// ③ 大小写不敏感(自定义英文触发词)
	assert.equal(findTrigger([userMessage("Please Custom Recall now")], { triggers: ["custom recall"] }).keyword, "now");
	// ④ 前后空白/换行
	assert.deepEqual(findTrigger([userMessage("  \n 大记忆恢复术 \n  示例关键词  \n")]).keyword, "示例关键词");
	// ⑤ 带关键词(冒号也要吃掉)
	assert.equal(findTrigger([userMessage("大记忆恢复术:示例关键词失败")]).keyword, "示例关键词失败");
});

test("★ 三个出厂触发词都生效:Memory unlocked / 大记忆恢复术 / DJYHFS", () => {
	for (const phrase of DEFAULT_TRIGGERS) {
		assert.deepEqual(findTrigger([userMessage(phrase)]), { keyword: "", messageIndex: 0, rawTail: "" },
			`触发词「${phrase}」必须生效`);
	}
	assert.equal(findTrigger([userMessage("DJYHFS 示例关键词")]).keyword, "示例关键词");
	assert.equal(findTrigger([userMessage("大记忆恢复术 示例关键词")]).keyword, "示例关键词");
	assert.equal(findTrigger([userMessage("Memory unlocked 示例关键词")]).keyword, "示例关键词");
});

test("★ Memory unlocked 不区分大小写(逐种写法)", () => {
	for (const variant of ["Memory unlocked", "memory unlocked", "MEMORY UNLOCKED", "MeMoRy UnLoCkEd"]) {
		assert.equal(findTrigger([userMessage(variant)]).keyword, "", `「${variant}」必须命中`);
		assert.equal(findTrigger([userMessage(`${variant} 证书`)]).keyword, "证书", `「${variant} 证书」的关键词必须是"证书"`);
	}
	// 不能误伤:只出现半截词不算触发
	assert.equal(findTrigger([userMessage("memory")]), null);
	assert.equal(findTrigger([userMessage("unlocked")]), null);
	assert.equal(findTrigger([userMessage("D J Y H F S")]), null);
});

test("★ 同句多个触发词:取最靠左的那个,它后面的内容才算关键词", () => {
	const hit = findTrigger([userMessage("DJYHFS 说说 Memory unlocked 的事")]);
	assert.equal(hit.keyword, "说说 Memory unlocked 的事", "最靠左的是 DJYHFS,它后面的全是关键词");
	assert.equal(hit.rawTail, "说说 Memory unlocked 的事");
	assert.equal(hit.messageIndex, 0);
});

test("normalizeTriggers:去重 / 去空 / 截断 / 非法回落 / 不交出冻结数组", () => {
	assert.deepEqual(normalizeTriggers(["  a  ", "A", "", "   ", 7, null]), ["a"], "按小写去重,丢掉非字符串与空白");
	assert.deepEqual(normalizeTriggers("单值"), ["单值"], "单值字符串也接受");
	assert.deepEqual(normalizeTriggers([]), [...DEFAULT_TRIGGERS], "空数组回落默认");
	assert.deepEqual(normalizeTriggers("   "), [...DEFAULT_TRIGGERS], "全空白回落默认");
	assert.deepEqual(normalizeTriggers([42]), [...DEFAULT_TRIGGERS], "非法类型回落默认");
	assert.deepEqual(normalizeTriggers({ triggers: ["x"] }), [...DEFAULT_TRIGGERS], "对象形状不被当成触发词列表");
	assert.equal(normalizeTriggers(["x".repeat(100)])[0].length, 32, "单个触发词截到 MAX_TRIGGER_CHARS");
	assert.notEqual(normalizeTriggers(undefined), DEFAULT_TRIGGERS, "★ 必须返回副本,不能把冻结数组交出去");
});

test("findTrigger:只看 user 消息,且最新的优先;非字符串内容不炸", () => {
	const messages = [
		userMessage("大记忆恢复术 另一组关键词"),
		{ role: "assistant", content: [{ type: "text", text: "大记忆恢复术 助手说的不算" }] },
		userMessage("大记忆恢复术 新的关键词")
	];
	assert.equal(findTrigger(messages).keyword, "新的关键词");
	assert.equal(findTrigger(messages).messageIndex, 2);
	// 只有助手消息 → 不触发
	assert.equal(findTrigger([{ role: "assistant", content: [{ type: "text", text: "大记忆恢复术" }] }]), null);
	// role 缺失(裸字符串)也当成用户消息处理
	assert.equal(findTrigger(["大记忆恢复术 裸串"]).keyword, "裸串");
	assert.equal(findTrigger([{ role: "user" }]), null);
});

test("messageText:三种消息形状", () => {
	assert.equal(messageText("裸串"), "裸串");
	assert.equal(messageText(userMessage("内容")), "内容");
	assert.equal(messageText({ role: "user", text: "别的形状" }), "别的形状");
	assert.equal(messageText(undefined), "");
});

test("★ createTurnGuard:同一轮只注入一次", () => {
	const guard = createTurnGuard();
	assert.equal(guard.shouldInject("a", 1), true);
	assert.equal(guard.shouldInject("a", 1), false, "同一 agent 同一 turn 第二次必须拒绝");
	assert.equal(guard.shouldInject("a", 2), true, "换 turn 可以再触发");
	assert.equal(guard.shouldInject("b", 2), true, "换 agent 可以再触发");
	guard.reset();
	assert.equal(guard.shouldInject("b", 2), true);
});

test("★ createTurnGuard:多 agent 交错时同一轮不会被放行两次(单槽写法的漏洞)", () => {
	// 单槽写法(`key === lastKey`)在 a#7 → b#7 → a#7 时第三次会**再次放行**,
	// 结果同一轮注入两次。必须记住"已注入过的键集合"。
	const guard = createTurnGuard();
	assert.equal(guard.shouldInject("a", 7), true);
	assert.equal(guard.shouldInject("b", 7), true);
	assert.equal(guard.shouldInject("a", 7), false, "★ 交错回来后 a#7 不能再注入一次");
	assert.equal(guard.shouldInject("b", 7), false);
	// 仍然有界:记满 maxEntries 后挤出最旧的,不会无限增长
	const bounded = createTurnGuard({ maxEntries: 2 });
	assert.equal(bounded.shouldInject("x", 1), true);
	assert.equal(bounded.shouldInject("x", 2), true);
	assert.equal(bounded.shouldInject("x", 3), true, "挤掉最旧的 x#1");
	assert.equal(bounded.shouldInject("x", 3), false, "刚记下的必须拦住");
	assert.equal(bounded.shouldInject("x", 1), true, "被挤出的旧键会被忘记(可接受:那是很多轮之前)");
});

test("★ buildInjectedMessage:克隆已有消息、只换 content、换掉 id", () => {
	const template = userMessage("大记忆恢复术", { id: "msg-1", extraField: "保留" });
	const injected = buildInjectedMessage([template], { messageIndex: 0 }, "已发布文本", () => "new-id");
	assert.notEqual(injected, template, "必须是新对象");
	assert.equal(injected.role, "user");
	assert.equal(injected.content[0].text, "已发布文本");
	assert.equal(injected.extraField, "保留", "模板上的其它必需字段必须原样留下");
	assert.equal(injected.id, "new-id", "id 必须换新,避免与源消息重复");
	// 源消息没被改动
	assert.equal(template.content[0].text, "大记忆恢复术");
	assert.equal(template.id, "msg-1");
});

test("★ buildInjectedMessage:模板无 id 也补 id(纵深防御要靠它);没模板时给最小形状", () => {
	// MessageBase 必然有 id(权威声明取自 DSH 的类型声明),所以"补 id"不是猜字段;
	// 它也是 findTrigger 识别"自己注入块"的唯一标记。那属于**纵深防御**:
	// 宿主目前不会把会话表层重新 claim 一遍(论证见 findTrigger 的注释),
	// 但成本只是一次前缀比较,宿主行为一变就得靠它。
	const noId = buildInjectedMessage([userMessage("触发")], { messageIndex: 0 }, "x");
	assert.equal(typeof noId.id, "string", "★ 必须补出 id");
	assert.ok(noId.id.startsWith(INJECTED_ID_PREFIX), "★ id 必须带注入块前缀,findTrigger 靠它识别");
	const fallback = buildInjectedMessage([], { messageIndex: -1 }, "x");
	assert.equal(fallback.role, "user");
	assert.equal(fallback.content[0].text, "x");
	assert.ok(fallback.id.startsWith(INJECTED_ID_PREFIX), "最小形状同样要带可识别 id");
});

test("★ 纵深防御:findTrigger 跳过本插件自己注入的那条消息(可达性见 lib 注释)", () => {
	// 注入块 role=user,正文里含触发词。按宿主源码它不会被再次 claim,所以这不是
	// 当前唯一的防线 —— 但一旦宿主改成"每步重扫会话消息",这条跳过就是唯一的防线。
	const injected = buildInjectedMessage([userMessage("随便", { id: "u1" })], { messageIndex: 0 }, "历史里出现了 Memory unlocked 和 DJYHFS 和 大记忆恢复术");
	assert.ok(injected.content[0].text.includes("DJYHFS"), "前提:注入正文确实含触发词");
	assert.equal(findTrigger([injected]), null, "★ 自己的注入块不会被再次当成用户输入");
	// 真实的用户消息仍然要能触发
	assert.equal(findTrigger([userMessage("DJYHFS 证书"), injected]).keyword, "证书");
	// id 前缀与注入块不同的消息不受影响(照常参与匹配)
	assert.equal(findTrigger([userMessage("DJYHFS 证书", { id: "host-1" })]).keyword, "证书");
});

test("★ buildInjectedMessage:不克隆模板的 source(避免复制人类 rpcId / 被宿主上下文投影认领)", () => {
	const template = userMessage("触发", { id: "m1", source: { kind: "user", rpcId: "r1" } });
	const injected = buildInjectedMessage([template], { messageIndex: 0 }, "x");
	assert.deepEqual(injected.source, { kind: "user" }, "★ source 必须是显式 {kind:'user'},不能带模板的 rpcId");
	assert.notEqual(injected.source, template.source, "必须是新对象,不能共用引用");
	assert.deepEqual(template.source, { kind: "user", rpcId: "r1" }, "★ 模板本身不能被改动");
	// 模板没有 source 时也要给
	const bare = buildInjectedMessage([{ role: "user", content: [] }], { messageIndex: 0 }, "x");
	assert.deepEqual(bare.source, { kind: "user" });
	// 最小形状(找不到模板)同样带 source
	const fallback = buildInjectedMessage([], { messageIndex: -1 }, "x");
	assert.deepEqual(fallback.source, { kind: "user" });
});

test("★ 关键词上限:触发词后面超长时只取前 MAX_QUERY_CHARS 个字符", () => {
	// 不截断的话,一句超长输入会原样变成检索请求(后端也会拒),rawTail 也应是截断后的
	const long = "关键词".repeat(400);            // 1200 字符
	const hit = findTrigger([userMessage(`DJYHFS ${long}`)]);
	assert.equal(hit.keyword.length, MAX_QUERY_CHARS, `keyword 必须截到 ${MAX_QUERY_CHARS} 字符`);
	assert.equal(hit.rawTail.length, MAX_QUERY_CHARS);
});

// ★ 「插件自产文本不得含触发词」由 test/wiring.test.mjs 那条**遍历全部真实注册项**
//   的用例覆盖(`★ 遍历全部注册项:插件自产、模型可见的文本都不得含触发词`):
//   它把 HISTORY_PREAMBLE 与 renderUnavailable() 也一并纳入,能抓住"触发词被塞进
//   工具描述 / 参数描述 / 自动注入标题"这类突变。

test("渲染:必须写出'不是按时间'的排序规则与钻取入口", () => {
	const body = renderHistoryBody({
		mode: "index",
		query: "证书",
		sessionId: "s1",
		hits: [
			{ sessionId: "s1", seq: 42, time: 1700000000000, type: "assistant/message", live: true, persisted: false, snippet: "片段" }
		],
		inspected: 7
	});
	assert.ok(body.includes("seq=42"), "命中里必须显示 seq");
	assert.ok(body.includes("不是按时间"), "★ 索引模式的排序规则必须写进输出");
	assert.ok(body.includes("match_count"));
	assert.ok(body.includes("recall_expand"));
	assert.ok(body.includes("索引命中"));
});

test("★ 渲染:范围必须写在正文里 —— 安全边界要让模型看得见", () => {
	const history = renderHistoryBody({ mode: "scan", query: "x", hits: [], sessionId: "sess-1" });
	assert.ok(history.includes("范围:仅当前会话 sess-1"), "★ recall_history 必须写出范围");
	const expand = renderExpandBody({ sessionId: "sess-1", startSeq: 1, endSeq: 1, targetSeq: 1, events: [] });
	assert.ok(expand.includes("范围:仅当前会话 sess-1"), "★ recall_expand 同样要写出范围");
	// 拿不到 id 时用 ? 占位(调用点本来就必须 fail closed,绝不能"空着不说")
	assert.ok(renderHistoryBody({ mode: "scan", hits: [] }).includes("范围:仅当前会话 ?"));
	// ★ 范围不可配:不存在 scopeDegraded 这类披露
	assert.equal(renderHistoryBody({ mode: "scan", hits: [], scopeDegraded: true }).includes("过滤未生效"), false);
	// 没有命中时也不许教模型"去掉 sessionIds 重新试"(范围不是参数)
	const empty = renderHistoryBody({ mode: "scan", hits: [], sessionId: "sess-1" });
	assert.equal(empty.includes("sessionIds"), false, "★ 正文里不得出现范围类参数名");
	assert.ok(empty.includes("本次范围内没有命中的片段"));
});

/** 取出正文里的"排序规则:"那一行(两种模式必须各说各的真相)。 */
function sortingLine(body) {
	return body.split("\n").find((line) => line.startsWith("排序规则:"));
}

test("★ 排序说明必须与模式一致:扫描模式不能再说'不是按时间'(默认路径就是扫描)", () => {
	const indexLine = sortingLine(renderHistoryBody({ mode: "index", query: "x", hits: [] }));
	const scanLine = sortingLine(renderHistoryBody({ mode: "scan", query: "x", hits: [] }));
	assert.ok(indexLine, "索引模式必须有排序规则行");
	assert.ok(scanLine, "扫描模式必须有排序规则行");
	assert.notEqual(scanLine, indexLine, "★ 两种模式的排序规则必须不同");
	assert.ok(scanLine.includes("按时间倒序"), "★ 扫描路径的真相:按时间倒序,第一条就是最近的那次命中");
	assert.equal(scanLine.includes("不是按时间"), false, "★ 扫描模式绝不能说'不是按时间';那会教模型挑错会话");
	assert.ok(indexLine.includes("match_count") && indexLine.includes("不是按时间"), "索引模式仍要说清 match_count 规则");
	// 中止时不该硬塞一条排序规则(什么都没扫完,说什么排序都是多余的)
	assert.equal(sortingLine(renderHistoryBody({ mode: "aborted", hits: [] })), undefined);
	assert.ok(renderHistoryBody({ mode: "aborted", hits: [] }).includes("本轮已中止"));
});

test("渲染:截断的三种原因(窗口 / 预算 / 中止)必须各有一条自己的披露", () => {
	const windowBody = renderHistoryBody({ mode: "scan", hits: [], truncatedWindow: true });
	assert.ok(windowBody.includes("候选窗口已用尽"), "没给原因时使用通用措辞");
	const budgetBody = renderHistoryBody({ mode: "scan", hits: [], truncatedWindow: true, truncatedReason: "budget" });
	assert.ok(budgetBody.includes("时间预算"));
	assert.equal(budgetBody.includes("候选窗口已用尽"), false);
	const abortBody = renderHistoryBody({ mode: "aborted", hits: [], truncatedWindow: true, truncatedReason: "abort" });
	assert.ok(abortBody.includes("本轮已中止"));
	assert.ok(abortBody.includes("不完整"));
});

test("渲染:提前停手(命中已达上限)必须写明候选数、未检查会话与收窄后的排序口径", () => {
	const body = renderHistoryBody({
		mode: "scan", query: "x", sessionId: "s1", inspected: 2, candidates: 9, stoppedAtLimit: true,
		hits: [{ sessionId: "s1", seq: 1, time: 1, type: "user/message", live: true, persisted: false, snippet: "片段" }]
	});
	assert.ok(body.includes("返回条数已达上限"), "★ 提前停手要有专门的披露行");
	assert.ok(body.includes("共 9 个候选"));
	assert.ok(body.includes("未检查"), "★ 未检查的会话数必须让模型看到");
	assert.ok(body.includes("在已检查的会话中按时间倒序"), "★ 排序说明不能对未检查的会话说满");
	assert.equal(body.includes("候选窗口已用尽"), false, "提前停手不是窗口用尽");
});

test("渲染:一个会话都没检查(预算 0)时仍要写出候选数,且排序口径收窄", () => {
	const body = renderHistoryBody({
		mode: "scan", query: "x", sessionId: "s1", inspected: 0, candidates: 3,
		hits: [], truncatedWindow: true, truncatedReason: "budget"
	});
	assert.ok(body.includes("未检查任何会话 / 共 3 个候选"), "★ inspected=0 也不能把候选数吞掉");
	assert.ok(body.includes("时间预算"));
	assert.ok(body.includes("在已检查的会话中按时间倒序"), "★ 预算截断时排序说明必须收窄");
});

test("渲染:候选窗口用尽时排序说明同样要收窄", () => {
	const body = renderHistoryBody({
		mode: "scan", query: "x", sessionId: "s1", inspected: 120, candidates: 125,
		hits: [], truncatedWindow: true, truncatedReason: "window"
	});
	assert.ok(body.includes("候选窗口已用尽"));
	assert.ok(body.includes("在已检查的会话中按时间倒序"));
});

test("渲染:降级/截断/错误都要如实写出来", () => {
	const body = renderHistoryBody({ mode: "scan", hits: [], degraded: "索引没启用", error: "SESSION_QUERY_SEARCH_DISABLED: x", truncatedWindow: true });
	assert.ok(body.includes("降级"));
	assert.ok(body.includes("SESSION_QUERY_SEARCH_DISABLED"));
	assert.ok(body.includes("候选窗口已用尽"));
	assert.ok(body.includes("扫描兜底"));
});

test("渲染:展开块含窗口与目标标记", () => {
	const body = renderExpandBody({
		sessionId: "s1", startSeq: 3, endSeq: 9, targetSeq: 5, inheritedEventCount: 0,
		clamped: { before: true, after: false },
		events: [{ seq: 5, type: "user/message", time: 1, text: "正文" }]
	});
	assert.ok(body.includes("窗口 seq 3..9"));
	assert.ok(body.includes("←目标"));
	assert.ok(body.includes("before 已被夹到官方上限"));
	assert.ok(body.includes("正文"));
});

test("renderUnavailable 必须给出'怎么修',不能只说不可用", () => {
	const text = renderUnavailable();
	assert.ok(text.includes("ctx.sessionQuery"));
	assert.ok(text.includes("修法"));
	assert.ok(text.includes("dsh-session-query-sqlite"));
});

test("★ formatTime 必须是**本地**时间,不是 UTC(toISOString 的坑)", () => {
	// 证据:骨架里印的是本地时间,而原始消息带的是 +08:00 时区。
	// 用 UTC 渲染会差 8 小时。
	const ms = Date.parse("2026-01-01T00:00:00+08:00");
	const date = new Date(ms);
	const pad = (value) => String(value).padStart(2, "0");
	const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
		`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	assert.equal(formatTime(ms), local, "★ 必须用本地 getter");
	// 时区不是 UTC 时,还不得等于 UTC 渲染 —— 否则渲染出来仍是 UTC,不是本地时间(在 UTC 机器上这条跳过)
	if (date.getTimezoneOffset() !== 0) {
		assert.notEqual(formatTime(ms), new Date(ms).toISOString().replace("T", " ").slice(0, 19),
			"★ 不得继续用 toISOString(那是 UTC)");
	}
	assert.equal(formatTime(undefined), "?");
	assert.equal(formatTime(Number.NaN), "?");
});
