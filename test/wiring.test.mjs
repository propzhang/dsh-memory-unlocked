/**
 * ★ 接线层测试 —— 覆盖下面这些失败路径。
 *
 * 文档里写的断言未必覆盖失败路径,
 * 于是下面这两个 bug 很容易漏掉:
 *   · `/recall` 空参返回 `kind:"success"`(失败被伪装成成功)
 *   · `commands` 组合顺序敏感(可选依赖拿不到就整个不注册)
 * 这个文件就是让它们有地方被抓。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EXPAND_DESCRIPTION, HISTORY_DESCRIPTION, apply, name, inject } from "../lib/index.js";
import { DEFAULT_TRIGGERS, renderUnavailable } from "../lib/recall.js";
import { HISTORY_PREAMBLE, publish } from "../lib/publish.js";
import { fakeCtx, fakeSessionQuery, sessionRecord, userMessage } from "./helpers.mjs";

test("★★ output.schema:与 publish() 逐键对齐,且只用宿主 DSL 支持的构造", () => {
	// 为什么单独立这一条 —— 两条宿主约束,普通单测抓不到(假 ctx 既不校验
	// 返回值、也不编译 output.schema):
	//   ① 声明里少一个键 ⇒ 宿主严格校验直接拒绝,连成功路径都进不去:
	//      `"value.published.redactLabels" is not a declared property (additionalProperties: false)`
	//   ② 用了宿主 DSL 不支持的构造(`anyOf`)⇒ schema 编译失败,**整个插件 fiber 变 failed、工具全部消失**。
	const { ctx, tools } = fakeCtx({ sessionQuery: sqWithHit().sq });
	apply(ctx, {});

	// ① 若声明是"约束型"(有 properties 且 additionalProperties:false),则 publish() 返回的
	//    每个键都必须被声明 —— 声明少于实际返回时,宿主会拒绝整次调用。
	//    当前实现故意用**无约束**的 `{type:"object"}`(见 lib/index.js 的说明),此处对它是恒过;
	//    但只要有人把约束加回来而漏了键,这一条立刻变红。
	for (const toolName of ["recall_history", "recall_expand"]) {
		const publishedSchema = tools.get(toolName).output.schema.properties.published;
		const constrained = publishedSchema?.additionalProperties === false && publishedSchema?.properties !== undefined;
		if (!constrained) {
			assert.equal(publishedSchema?.type, "object",
				`${toolName} 的 published 要么是约束型(须逐键声明),要么就是裸的 {type:"object"}`);
			continue;
		}
		const declared = Object.keys(publishedSchema.properties);
		for (const value of [publish("正文"), publish("提示", { kind: "notice" })]) {
			for (const key of Object.keys(value)) {
				assert.ok(declared.includes(key),
					`★ ${toolName} 的 output.schema 没声明 publish() 返回的键「${key}」—— 实测上会直接失败`);
			}
		}
	}
	// ② notice 模式**不带 token 键**(不是 null)—— 所以 schema 里 `token:{type:"string"}` 永远成立
	assert.equal("token" in publish("提示", { kind: "notice" }), false, "notice 模式不该有 token 键");

	// ③ ★ 结构性护栏:output.schema 里**不许出现**宿主不支持的 JSON Schema 关键字。
	//    宿主自己的报错把支持的子集说清楚了(dsh-tools 的 assertSupportedJsonSchema):
	//      subset: type / oneOf / properties / required / additionalProperties / items / enum / const + annotations
	//    而 `anyOf` **不在其中** —— 声明 `anyOf` 会让插件 fiber 变 `failed`、两个工具全消失。
	//    所以这里封死"不支持的那些";`oneOf` 是**支持**的,不禁。
	const BANNED = ["anyOf", "allOf", "not", "$ref", "$defs", "definitions", "if", "then", "else", "patternProperties"];
	const walk = (node, path) => {
		if (node === null || typeof node !== "object") return;
		if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${path}[${i}]`)); return; }
		for (const [key, value] of Object.entries(node)) {
			assert.ok(!BANNED.includes(key),
				`★ output.schema 里出现了宿主 DSL 不支持的「${key}」(在 ${path})—— 实测上会让整个插件 fiber 失败`);
			if (key === "type") {
				assert.equal(typeof value, "string",
					`★ (在 ${path})type 必须是单个字符串;type 数组(联合类型)宿主 DSL 不支持`);
			}
			walk(value, `${path}.${key}`);
		}
	};
	for (const toolName of ["recall_history", "recall_expand"]) {
		walk(tools.get(toolName).output.schema, `${toolName}.output.schema`);
	}

	// ④ 顶层键也要对齐:expand 的真实返回含 mode
	for (const toolName of ["recall_history", "recall_expand"]) {
		const top = Object.keys(tools.get(toolName).output.schema.properties);
		assert.ok(top.includes("ok") && top.includes("published"), `${toolName} 顶层必须有 ok/published`);
	}
	assert.ok(Object.keys(tools.get("recall_expand").output.schema.properties).includes("mode"),
		"★ recall_expand 会返回 mode,顶层 schema 必须声明它");
});

/** 造一个"索引有命中"的假服务。命中属于会话 `id`(默认 s1):范围闸门只让当前会话通过。 */
function sqWithHit(seq = 42, id = "s1") {
	return fakeSessionQuery({
		async searchSessions() {
			return {
				items: [{
					header: { id, cwd: "C:\\work", createdAt: 1, isSeeded: false },
					live: true,
					persisted: false,
					bestMatch: { sessionId: id, seq, type: "assistant/message", time: 1000, surface: "current", snippet: "历史片段" }
				}]
			};
		}
	});
}

/** 当前会话的 agent(exec.agent 是工具解析范围的唯一来源)。 */
const AGENT = { id: "s1" };

test("插件元信息:name / inject / 工具描述 ≤500 字符,且★写明范围为当前工作区", () => {
	assert.equal(name, "memory-unlocked");
	assert.deepEqual(inject, ["tools"], "硬依赖只有 tools,sessionQuery 走可选");
	assert.ok(HISTORY_DESCRIPTION.length <= 500, `recall_history 描述 ${HISTORY_DESCRIPTION.length} 字符,超了`);
	assert.ok(EXPAND_DESCRIPTION.length <= 500, `recall_expand 描述 ${EXPAND_DESCRIPTION.length} 字符,超了`);
	assert.ok(HISTORY_DESCRIPTION.includes("recall_expand"), "必须告诉模型怎么钻取");
	// ★ 部署里索引可能被关闭 ⇒ 默认走扫描,扫描就是按时间倒序。
	//   不能断言 `includes("不是按时间")` —— 那会把"索引规则"当成唯一规则;
	//   描述里那句"别把第一条当成最近的"在扫描模式下恰恰是**错的**(扫描首条就是最近的)。
	assert.ok(HISTORY_DESCRIPTION.includes("默认走扫描"), "★ 默认路径(扫描兜底)必须写在描述里");
	assert.ok(HISTORY_DESCRIPTION.includes("按时间倒序"), "★ 扫描模式的真相:第一条就是最近的");
	assert.ok(HISTORY_DESCRIPTION.includes("match_count"), "索引可用时的规则也要说清");
	assert.ok(HISTORY_DESCRIPTION.indexOf("不是按时间") > HISTORY_DESCRIPTION.indexOf("索引"),
		"'不是按时间'只能用来限定**索引**规则,不能当成普适规则");
	// ★★ 范围是安全边界:描述必须让模型知道"只能读当前工作区"
	assert.ok(HISTORY_DESCRIPTION.includes("当前工作区"), "★ 描述必须说明检索范围是当前工作区");
	assert.ok(HISTORY_DESCRIPTION.includes("只读当前会话"), "★ 收窄分支(拿不到 cwd)必须明写为不可放宽");
	assert.equal(HISTORY_DESCRIPTION.includes("所有工作目录"), false, "★ 不是跨会话/跨目录检索");
	assert.equal(HISTORY_DESCRIPTION.includes("本工作区"), false, "★ 不得出现'本工作区'字样");
	assert.equal(HISTORY_DESCRIPTION.includes("跨会话"), false, "★ 不得出现'跨会话'字样");
	// expand 描述同样要说清 sessionId 的语义(可省略=当前会话;给了必须相等)
	assert.ok(EXPAND_DESCRIPTION.includes("当前会话"));
	assert.ok(EXPAND_DESCRIPTION.includes("省略"));
});

test("★ 注册了 2 个工具 + 1 个命令 + 1 个 pre-step 监听器,且都挂在 ctx.effect 上", () => {
	const { ctx, tools, commands, listeners, effects } = fakeCtx({ sessionQuery: sqWithHit().sq });
	apply(ctx, {});
	assert.deepEqual([...tools.keys()].sort(), ["recall_expand", "recall_history"]);
	assert.equal(commands.length, 1);
	assert.equal(commands[0].name, "recall");
	assert.ok(listeners.has("agent/pre-step"), "自动回顾必须挂在 agent/pre-step 上");
	assert.equal(effects.length, 4, "2 工具 + 1 命令 + 1 监听器都要可回收");
	for (const label of effects) assert.match(label, /^memory-unlocked:/u);
});

test("★ 没有 sessionQuery 时:工具返回'怎么修',不崩", async () => {
	const { ctx, tools } = fakeCtx({ sessionQuery: undefined });
	apply(ctx, {});
	const value = await tools.get("recall_history").execute({ query: "证书" }, { agent: AGENT });
	assert.equal(value.ok, false);
	assert.equal(value.error.code, "SESSION_QUERY_UNAVAILABLE");
	assert.ok(value.published.text.includes("修法"), "必须给出可照做的修法");
	assert.ok(value.published.text.includes("dsh-session-query-sqlite"));
	// expand 同样
	const expand = await tools.get("recall_expand").execute({ sessionId: "s1", seq: 1 }, { agent: AGENT });
	assert.equal(expand.ok, false);
	assert.equal(expand.error.code, "SESSION_QUERY_UNAVAILABLE");
});

test("工具:参数非法时显式失败(保留 code)", async () => {
	const { ctx, tools } = fakeCtx({ sessionQuery: sqWithHit().sq });
	apply(ctx, {});
	const value = await tools.get("recall_history").execute({ limit: 999 }, { agent: AGENT });
	assert.equal(value.ok, false);
	assert.equal(value.error.code, "INVALID_ARGUMENT");
	assert.ok(value.published.text.includes("limit"));
});

test("★ 工具:命中路径带 seq,并且模型看到的文本经过 publish(有边界 token)", async () => {
	const { ctx, tools } = fakeCtx({ sessionQuery: sqWithHit(42).sq });
	apply(ctx, {});
	const tool = tools.get("recall_history");
	const value = await tool.execute({ query: "证书" }, { agent: AGENT });
	assert.equal(value.ok, true);
	assert.ok(value.published.text.includes("seq=42"), "★ seq 必须出现在给模型的文本里");
	assert.ok(value.published.text.includes("范围:仅当前会话 s1"), "★ 范围必须写进给模型的文本");
	assert.match(value.published.token, /^[0-9a-f]{12}$/u);
	assert.ok(value.published.text.includes(`<<<RECALL:${value.published.token}>>>`));
	assert.ok(value.published.text.includes(`<<<END:${value.published.token}>>>`));
	// output.render 必须输出同一份文本(单一出口)
	const blocks = tool.output.render({}, value);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].type, "text");
	assert.equal(blocks[0].text, value.published.text);
	// 结构化值必须可 JSON 序列化(官方 ToolExecutionSuccess.value 是 JsonValue)
	assert.doesNotThrow(() => JSON.stringify(value));
});

test("工具:没给 query 时走★'被 compaction 挤掉的部分'模式(不给本来就在上下文里的最近几条)", async () => {
	const { sq, calls } = fakeSessionQuery({
		async listSessions() { return [sessionRecord("s1", { cwd: "C:\\work", createdAt: 9 }), sessionRecord("别的会话", { cwd: "C:\\work", createdAt: 8 })]; },
		async readSurface(sessionId) {
			calls.readSurface.push(sessionId);
			return {
				session: { id: sessionId }, inheritedEventCount: 0, capturedThroughSeq: 11,
				events: [{ sessionId, seq: 11, type: "user/message", time: 1, surface: "current", data: { content: [{ type: "text", text: "我刚才在改检索范围" }] } }]
			};
		}
	});
	const { ctx, tools } = fakeCtx({ sessionQuery: sq, cwd: "C:\\work" });
	apply(ctx, {});
	const value = await tools.get("recall_history").execute({}, { agent: AGENT });
	assert.equal(value.ok, true);
	assert.equal(value.mode, "compacted", "★ 只返回被 compaction 挤掉的部分,而不是最近的几条(那几条本来就在上下文里)");
	// ★ 一次问全三种 surface:可恢复的只有 shadowed,顺带拿到分类计数(且只需一次整档重放)
	assert.deepEqual(calls.filterEvents, [{ sessionId: "s1", filters: [{ kind: "surface", values: ["current", "shadowed", "log-only"] }] }],
		"★ 必须问到 surface 分类,才能知道'挤掉了多少、还剩多少可见'");
	// 该会话没有被压缩掉任何内容 ⇒ **如实说**,不编造回顾
	assert.ok(value.published.text.includes("该会话没有被压缩掉的内容"), "★ 没有可恢复内容要如实说");
	assert.equal(value.published.text.includes("我刚才在改检索范围"), false,
		"★ 不得把'本来就在上下文里的最近事件'当成回顾内容喂回去");
	// ★ AGENT 没有 `session.header.cwd` ⇒ 范围**退化为当前会话**,而且必须**明说**收窄了
	assert.ok(value.published.text.includes("范围:仅当前会话 s1"), "范围行必须写在正文里");
	assert.ok(value.published.text.includes("未拿到工作目录"), "★ 收窄这一事实要如实说明,不能让模型以为看到了全部");
});

test("工具:召回被脱敏后才发布(历史里的密钥不会漏给模型)", async () => {
	const { sq } = fakeSessionQuery({
		async searchSessions() {
			return {
				items: [{
					header: { id: "s1", cwd: "C:\\work", createdAt: 1, isSeeded: false },
					live: true, persisted: false,
					bestMatch: { sessionId: "s1", seq: 1, type: "user/message", time: 1, surface: "current", snippet: "我的密码是 hunter2hunter2" }
				}]
			};
		},
		async filterEvents(sessionId, filters) {
			assert.deepEqual(filters, [{ kind: "seq", from: 1, to: 1 }]);
			return [{ sessionId, seq: 1, type: "user/message", time: 1, surface: "current", text: "我的密码是 hunter2hunter2" }];
		}
	});
	const { ctx, tools } = fakeCtx({ sessionQuery: sq });
	apply(ctx, {});
	const value = await tools.get("recall_history").execute({ query: "密码" }, { agent: AGENT });
	assert.ok(!value.published.text.includes("hunter2hunter2"), "★ 历史里的口令不能进上下文");
	assert.ok(value.published.text.includes("«已打码»"));
});

test("★ /recall 空参必须返回失败,不能伪装成功", async () => {
	const { ctx, commands } = fakeCtx({ sessionQuery: sqWithHit().sq });
	apply(ctx, {});
	const handler = commands[0].handler;
	for (const invocation of [{ rawInput: "" }, { rawInput: "   \n " }, ""]) {
		const result = await handler(invocation);
		assert.equal(result.kind, "error", `空参(${JSON.stringify(invocation)})必须是 error`);
		assert.ok(result.text.includes("用法"));
		// ★ 命令输出是给人看的,不会变成"用户这一步提交的输入";不回显触发词是
		//    纵深防御:插件没有任何理由主动往对话里放一个触发词。
		for (const phrase of ["Memory unlocked", "大记忆恢复术", "DJYHFS"]) {
			assert.equal(result.text.toLowerCase().includes(phrase.toLowerCase()), false,
				`/recall 用法文本不得回显触发词「${phrase}」`);
		}
	}
});

test("★ /recall 从 invocation.agent 取范围:对象形态成功;裸字符串(无范围)必须显式失败", async () => {
	const { ctx, commands } = fakeCtx({ sessionQuery: sqWithHit(5).sq });
	apply(ctx, {});
	const handler = commands[0].handler;
	// 官方契约:CommandInvocation 对象(带 agent ⇒ 能定范围)
	const byObject = await handler({ commandId: "c1", agent: AGENT, rawInput: "证书", attachments: [], signal: undefined });
	assert.equal(byObject.kind, "success");
	assert.ok(byObject.text.includes("seq=5"));
	// ★ 裸字符串里没有 agent,解析不出范围 ⇒ fail closed(宁可拒绝,也不退回更大范围)。
	const byString = await handler("证书");
	assert.equal(byString.kind, "error", "★ 拿不到范围就不查,绝不放宽");
	assert.ok(byString.text.includes("SESSION_SCOPE_UNAVAILABLE"));
	// 对象形态但缺 agent ⇒ 同样 fail closed
	const noAgent = await handler({ commandId: "c2", rawInput: "证书" });
	assert.equal(noAgent.kind, "error");
	assert.ok(noAgent.text.includes("SESSION_SCOPE_UNAVAILABLE"));
});

test("★ pre-step:没触发就原样返回(同一个对象,零开销)", async () => {
	const listener = (() => {
		const { ctx, listeners } = fakeCtx({ sessionQuery: sqWithHit().sq });
		apply(ctx, {});
		return listeners.get("agent/pre-step");
	})();
	const decision = { kind: "enter", messages: [userMessage("今天天气不错")] };
	const out = await listener({ agent: { id: "a" }, turn: 1, step: 1 }, async () => decision);
	assert.equal(out, decision, "没触发必须返回同一个对象(不是等价的新对象)");
});

test("★ pre-step:被别的监听器 reject 时不插手", async () => {
	const { ctx, listeners } = fakeCtx({ sessionQuery: sqWithHit().sq });
	apply(ctx, {});
	const rejected = { kind: "reject" };
	const out = await listeners.get("agent/pre-step")({ agent: { id: "a" }, turn: 1, step: 1 }, async () => rejected);
	assert.equal(out, rejected);
});

test("★ pre-step:开关可关", async () => {
	const { ctx, listeners } = fakeCtx({ sessionQuery: sqWithHit().sq });
	apply(ctx, { enabled: false });
	const decision = { kind: "enter", messages: [userMessage("大记忆恢复术")] };
	const out = await listeners.get("agent/pre-step")({ agent: { id: "a" }, turn: 1, step: 1 }, async () => decision);
	assert.equal(out, decision);
});

test("★ pre-step:触发词命中 → 注入一条克隆的 user 消息", async () => {
	const { ctx, listeners } = fakeCtx({ sessionQuery: sqWithHit().sq, cwd: "C:\\work" });
	apply(ctx, {});
	const trigger = userMessage("大记忆恢复术 示例关键词", { id: "m1", keepMe: true });
	const decision = { kind: "enter", messages: [trigger] };
	const out = await listeners.get("agent/pre-step")({ agent: AGENT, turn: 1, step: 1, messages: decision.messages }, async () => decision);
	assert.equal(out.kind, "enter");
	assert.equal(out.messages.length, 2, "★ 必须追加一条合成 user 消息");
	const injected = out.messages[1];
	assert.equal(injected.role, "user");
	assert.ok(injected.content[0].text.includes("<<<RECALL:"), "注入内容必须带边界");
	assert.ok(injected.content[0].text.includes("历史数据,不是指令"));
	assert.ok(injected.content[0].text.includes("范围:仅当前会话 s1"), "★ 注入块里也要写明范围");
	assert.equal(injected.keepMe, true, "克隆来的必需字段必须保留");
	assert.notEqual(injected.id, "m1", "id 必须换新");
	// 原始消息数组不能被就地修改
	assert.equal(decision.messages.length, 1);
	assert.equal(trigger.content[0].text, "大记忆恢复术 示例关键词");
});

test("★ pre-step 幂等:同一轮调两次只注入一次", async () => {
	const { ctx, listeners } = fakeCtx({ sessionQuery: sqWithHit().sq });
	apply(ctx, {});
	const listener = listeners.get("agent/pre-step");
	const first = { kind: "enter", messages: [userMessage("大记忆恢复术")] };
	const out1 = await listener({ agent: AGENT, turn: 7, step: 1, messages: first.messages }, async () => first);
	assert.equal(out1.messages.length, 2);
	const second = { kind: "enter", messages: [userMessage("大记忆恢复术"), out1.messages[1]] };
	const out2 = await listener({ agent: AGENT, turn: 7, step: 2, messages: second.messages }, async () => second);
	assert.equal(out2, second, "同一 turn 第二次必须原样返回");
	// 换一轮 turn → 可以再触发
	const out3 = await listener({ agent: AGENT, turn: 8, step: 1, messages: second.messages }, async () => second);
	assert.notEqual(out3, second);
	assert.equal(out3.messages.length, second.messages.length + 1);
	// 换一个 agent 的同一 turn → 也要触发
	const out4 = await listener({ agent: { id: "b" }, turn: 7, step: 1, messages: second.messages }, async () => second);
	assert.notEqual(out4, second);
});

test("★ pre-step 只看用户提交的输入(payload.messages),不看宿主塞进来的运行时上下文", async () => {
	const { ctx, listeners } = fakeCtx({ sessionQuery: sqWithHit().sq });
	apply(ctx, {});
	const listener = listeners.get("agent/pre-step");
	// 宿主把每个 ctx.systemPrompt.context({...}) 渲染成一条 role:"user" 的消息追加进 decision;
	// 它出现在 decision.messages 里,但**不在** payload.messages(用户本轮实际提交的输入)里。
	const contextMsg = userMessage("运行时上下文:关于 大记忆恢复术 的说明", { id: "ctx-1" });
	const userInput = userMessage("帮我看看这个报错");
	const decision = { kind: "enter", messages: [userInput, contextMsg] };
	const out = await listener({ agent: { id: "a" }, turn: 1, step: 1, messages: [userInput] }, async () => decision);
	assert.equal(out, decision, "★ 运行时上下文里的触发词不得触发回顾");

	// 这一轮说了触发词 → 必须触发,而且模板必须取自 payload.messages 那条。
	// ★ 故意让两个数组的**前缀不同**:claimed=[前言, 触发]、decision=[上下文, 前言, 触发]。
	//   下标 1 在 claimed 里是"触发那条"(带 keepMe),在 decision 里却是"前言"(没有 keepMe);
	//   于是 buildInjectedMessage 一旦用错数组,克隆出的模板就会丢掉 keepMe ⇒ 被抓。
	const preamble = userMessage("先说个背景", { id: "u1" });
	const triggerInput = userMessage("DJYHFS 证书", { id: "u2", keepMe: true });
	const decision2 = { kind: "enter", messages: [contextMsg, preamble, triggerInput] };
	const out2 = await listener({ agent: { id: "a" }, turn: 2, step: 1, messages: [preamble, triggerInput] }, async () => decision2);
	assert.equal(out2.messages.length, 4, "用户输入命中时必须注入");
	assert.equal(out2.messages[3].keepMe, true, "★ 模板下标必须与 findTrigger 扫的数组同源(claimed[1],不是 decision[1])");
	assert.ok(out2.messages[3].content[0].text.includes("<<<RECALL:"));
	assert.equal(out2.messages[3].source.kind, "user", "注入消息的 source 必须是裸 user");
});

test("★ 遍历全部注册项:插件自产、模型可见的文本都不得含触发词", async () => {
	// 只查两个模块级常量抓不住这些:往工具描述 / 参数描述 / 自动注入标题里塞触发词,
	//   都不在那两个常量里,因此必须遍历全部注册项。
	const { ctx, tools, commands, listeners } = fakeCtx({ sessionQuery: sqWithHit().sq });
	apply(ctx, {});
	const authored = [];
	for (const [toolName, definition] of tools) {
		authored.push([`tool ${toolName} 的 name`, definition.name]);
		authored.push([`tool ${toolName} 的 description`, definition.description]);
		for (const [paramName, param] of Object.entries(definition.parameters?.properties ?? {})) {
			authored.push([`tool ${toolName} 的参数 ${paramName} 描述`, param.description ?? ""]);
		}
	}
	for (const command of commands) {
		authored.push([`命令 ${command.name} 的 description`, command.description ?? ""]);
	}
	const usage = await commands[0].handler({ rawInput: "" });
	authored.push(["/recall 用法错误文本", usage.text ?? ""]);
	// ★ 范围不可用 / 越界这两条失败文本也会进模型上下文,同样不许含触发词
	authored.push(["[SESSION_SCOPE_UNAVAILABLE] 失败文本", (await tools.get("recall_history").execute({ query: "x" })).published.text]);
	authored.push(["[SESSION_OUT_OF_SCOPE] 失败文本",
		(await tools.get("recall_expand").execute({ sessionId: "somewhere-else", seq: 1 }, { agent: AGENT })).published.text]);

	// ★ 两段**模块级**自产文本必须单独点名:它们虽然也出现在注入块里,但要能在
	//   "注入路径整条坏掉"时仍然抓得到;这里不点名 = 这两条彻底没有守卫。
	authored.push(["HISTORY_PREAMBLE(注入块前言)", HISTORY_PREAMBLE]);
	authored.push(["renderUnavailable()(服务缺失时的修法文本)", renderUnavailable()]);

	const decision = { kind: "enter", messages: [userMessage("DJYHFS 证书")] };
	const injected = await listeners.get("agent/pre-step")(
		{ agent: AGENT, turn: 1, step: 1, messages: decision.messages },
		async () => decision
	);
	authored.push(["自动注入块的完整文本(含标题)", injected.messages[1].content[0].text]);

	// 自检:先确认真的收集到了东西,否则下面的断言会"空转恒真"
	assert.ok(authored.length >= 10, `只收集到 ${authored.length} 条文本,太少,测试可能空转`);
	for (const [label, text] of authored) {
		for (const phrase of DEFAULT_TRIGGERS) {
			assert.equal(String(text).toLowerCase().includes(phrase.toLowerCase()), false,
				`${label} 不得含触发词「${phrase}」`);
		}
	}
});

test("pre-step:触发词可配(自定义触发词生效,默认词失效)", async () => {
	const { ctx, listeners } = fakeCtx({ sessionQuery: sqWithHit().sq });
	apply(ctx, { trigger: "回忆一下" });
	const listener = listeners.get("agent/pre-step");
	const miss = { kind: "enter", messages: [userMessage("大记忆恢复术")] };
	assert.equal(await listener({ agent: AGENT, turn: 1, step: 1, messages: miss.messages }, async () => miss), miss, "自定义触发词生效后,默认触发词不再匹配");
	const hit = { kind: "enter", messages: [userMessage("回忆一下 证书")] };
	const out = await listener({ agent: AGENT, turn: 2, step: 1, messages: hit.messages }, async () => hit);
	assert.equal(out.messages.length, 2);
});

test("★ pre-step:三个触发词都能注入,且 Memory unlocked 大小写不敏感", async () => {
	const { ctx, listeners } = fakeCtx({ sessionQuery: sqWithHit().sq, cwd: "C:\\work" });
	apply(ctx, {});
	const listener = listeners.get("agent/pre-step");
	const cases = ["大记忆恢复术", "Memory unlocked", "MEMORY UNLOCKED", "memory Unlocked 证书", "djyhfs", "DJYHFS 证书"];
	for (let index = 0; index < cases.length; index += 1) {
		const decision = { kind: "enter", messages: [userMessage(cases[index])] };
		// 每个用例换一个 turn,避开"同一轮只注入一次"的幂等闸
		const out = await listener({ agent: AGENT, turn: 100 + index, step: 1, messages: decision.messages }, async () => decision);
		assert.equal(out.messages.length, 2, `触发词「${cases[index]}」必须注入`);
		assert.ok(out.messages[1].content[0].text.includes("<<<RECALL:"), `「${cases[index]}」的注入内容必须带边界`);
	}
	// 反例:半截词不得触发
	const miss = { kind: "enter", messages: [userMessage("memory")] };
	assert.equal(await listener({ agent: AGENT, turn: 999, step: 1, messages: miss.messages }, async () => miss), miss);
});

test("★ pre-step:检索失败(服务抛错)绝不打断用户这一轮", async () => {
	const { sq } = fakeSessionQuery({
		async searchSessions() { throw new Error("boom"); },
		async listSessions() { throw new Error("boom"); }
	});
	const { ctx, listeners } = fakeCtx({ sessionQuery: sq });
	apply(ctx, {});
	const decision = { kind: "enter", messages: [userMessage("大记忆恢复术 证书")] };
	const out = await listeners.get("agent/pre-step")({ agent: { id: "a" }, turn: 1, step: 1, messages: decision.messages }, async () => decision);
	assert.equal(out.messages.length, 2, "索引和列表都挂时仍有兜底文本可注入(而不是抛出去)");
	// sessionQuery 完全缺失时更该安静地不动
	const bare = fakeCtx({ sessionQuery: undefined });
	apply(bare.ctx, {});
	const out2 = await bare.listeners.get("agent/pre-step")({ agent: { id: "a" }, turn: 1, step: 1, messages: decision.messages }, async () => decision);
	assert.equal(out2, decision);
});

test("★ pre-step:注入块受预算约束,且超限如实标注", async () => {
	const huge = "长".repeat(20000);
	const { sq } = fakeSessionQuery({
		async searchSessions() {
			return {
				items: Array.from({ length: 5 }, (_, index) => ({
					header: { id: "s1", cwd: "C:\\work", createdAt: 1, isSeeded: false },
					live: true, persisted: false,
					bestMatch: { sessionId: "s1", seq: index, type: "user/message", time: 1, surface: "current", snippet: huge }
				}))
			};
		},
		async filterEvents(sessionId, filters) {
			return [{ sessionId, seq: filters[0].from, type: "user/message", time: 1, surface: "current", text: huge }];
		}
	});
	const { ctx, listeners } = fakeCtx({ sessionQuery: sq });
	apply(ctx, { maxInjectChars: 700 });
	const decision = { kind: "enter", messages: [userMessage("大记忆恢复术 长文本")] };
	const out = await listeners.get("agent/pre-step")({ agent: AGENT, turn: 1, step: 1, messages: decision.messages }, async () => decision);
	const text = out.messages[1].content[0].text;
	assert.ok(text.length <= 700, `注入块 ${text.length} 字符,应 <= 700`);
	assert.ok(text.includes("已截断"), "截断必须如实写在输出里");
});

test("★ 工具走的默认(扫描)路径:排序说明必须说'按时间倒序',不能说'不是按时间'", async () => {
	const { sq } = fakeSessionQuery({
		async listSessions() { return [sessionRecord("s1", { cwd: "C:\\work" })]; },
		async filterEvents(sessionId) { return [{ sessionId, seq: 5, type: "user/message", time: 1, surface: "current", text: "扫描命中" }]; }
	});
	const { ctx, tools } = fakeCtx({ sessionQuery: sq, cwd: "C:\\work" });
	apply(ctx, {});
	const value = await tools.get("recall_history").execute({ query: "证书" }, { agent: AGENT });
	assert.equal(value.ok, true);
	assert.equal(value.mode, "scan", "索引关闭时 ⇒ 默认就是扫描路径");
	assert.ok(value.published.text.includes("按时间倒序"), "★ 扫描路径的真相:第一条就是最近的");
	assert.equal(value.published.text.includes("不是按时间"), false, "★ 扫描路径绝不能说'不是按时间'");
	assert.ok(value.published.text.includes("扫描兜底"), "模式必须如实写出来");
});

test("★ execute(args, exec) 必须把 exec.signal 传下去(丢弃它 = 永远无法取消)", async () => {
	const controller = new AbortController();
	const seen = [];
	const { sq } = fakeSessionQuery({
		async listSessions(signal) { seen.push(signal); return [sessionRecord("s1", { cwd: "C:\\work" })]; },
		async filterEvents(sessionId) { return [{ sessionId, seq: 1, type: "user/message", time: 1, surface: "current", text: "命中" }]; }
	});
	const { ctx, tools } = fakeCtx({ sessionQuery: sq, cwd: "C:\\work" });
	apply(ctx, {});
	const value = await tools.get("recall_history").execute({ query: "证书" }, { agent: AGENT, signal: controller.signal });
	assert.equal(value.ok, true);
	assert.equal(seen[0], controller.signal, "★ exec.signal 必须一路传到 listSessions");
	// expand 路径同样要透(官方 timeoutMs 不取消工具,只有 Signal 能)
	const expandSeen = [];
	const { sq: sq2 } = fakeSessionQuery({
		async readEvent(request, signal) {
			expandSeen.push(signal);
			return { session: { id: request.sessionId }, inheritedEventCount: 0, startSeq: 1, endSeq: 1, target: null, events: [] };
		}
	});
	const second = fakeCtx({ sessionQuery: sq2, cwd: "C:\\work" });
	apply(second.ctx, {});
	await second.tools.get("recall_expand").execute({ sessionId: "s1", seq: 1 }, { agent: AGENT, signal: controller.signal });
	assert.equal(expandSeen[0], controller.signal, "★ exec.signal 必须一路传到 readEvent");
});

test("★ 已中止的 exec.signal:工具仍返回 ok:true,并如实写出'结果不完整'", async () => {
	const controller = new AbortController();
	controller.abort();
	const { sq } = fakeSessionQuery({
		async listSessions() { return [sessionRecord("s1", { cwd: "C:\\work" })]; }
	});
	const { ctx, tools } = fakeCtx({ sessionQuery: sq, cwd: "C:\\work" });
	apply(ctx, {});
	const value = await tools.get("recall_history").execute({ query: "证书" }, { agent: AGENT, signal: controller.signal });
	assert.equal(value.ok, true, "★ 中止不是失败:ok 仍为 true(部分结果比假装失败有用)");
	assert.equal(value.mode, "aborted");
	assert.ok(value.published.text.includes("中止"), "★ 必须如实写出中止");
	assert.ok(value.published.text.includes("不完整"));
	assert.doesNotThrow(() => JSON.stringify(value), "中止结果仍必须是可序列化的 JsonValue");
});

test("ctx 上没有 tools 时 apply 不炸(只是没工具可注册)", () => {
	const ctx = { cwd: "C:\\work", get: () => undefined, on: () => () => {}, effect: (fn) => fn() };
	assert.doesNotThrow(() => apply(ctx, {}));
});
