/**
 * Memory-unlocked(触发词含「大记忆恢复术」,插件包 `dsh-memory-unlocked`)—— 接线层。
 *
 * 一个工具不够,这个插件给三样东西:
 *   ① `recall_history`  —— 粗召回(★ 带 seq,所以能钻取)
 *   ② `recall_expand`   —— 以 (sessionId, seq) 为中心展开原文
 *   ③ `agent/pre-step`  —— 用户说**三个触发词之一**时**自动**回顾(不靠模型自觉):
 *        `Memory unlocked`(不区分大小写)/ `大记忆恢复术` / `DJYHFS`
 *
 * 外加一个人用的 `/recall` 命令。
 *
 * ★★ **范围 = 只读当前工作区**(`resolveScope(agent)` 解析出 `{sessionId, cwd}`),
 *   这是**安全边界,不是配置**:
 *   四条入口(两个工具 / `/recall` / 自动触发)都从 `agent` 取 `{sessionId, cwd}`,
 *   取不到 `sessionId` 就 **fail closed**(显式失败或干脆不注入),绝不回落到"更大的范围";
 *   取不到 `cwd` 则**收窄**为"只读当前会话"(比工作区更窄,是安全方向的降级,且如实写出)。
 *   参数或配置里都**没有**能指定别的工作区的旋钮;即使调用方硬塞 `scope`/`sessionIds`,
 *   代码也**不读**它们(见 `validateHistoryArgs` 与 `buildSearchRequest`)。
 *   官方 `sessionQuery` README 写得很清楚:"No caller authorization — …a model tool
 *   or UI must constrain which sessions its caller may inspect" —— 约束只能在这里。
 *
 * 接线层单独成文件,是为了让"注册了什么 / 缺服务怎么办 / 空参怎么答"这三件
 * 事可以被假 ctx 断言(见 test/wiring.test.mjs)。把这些和纯逻辑揉在一起,
 * `/recall` 空参返回 `kind:"success"` 这类 bug 就很难被抓到。
 *
 * @module dsh-memory-unlocked
 */
import {
	AUTO_BUDGET_MS,
	BUDGET_ERROR_NAME,
	COMPACT_MAX_DOCS,
	COMPACT_MAX_SOURCE_CHARS,
	TOOL_BUDGET_MS,
	createBudget
} from "./budget.js";
import { createRedactionContext, publish } from "./publish.js";
import { normalizeSessionRecord } from "./normalize.js";
import {
	DEFAULT_CONFIG,
	buildInjectedMessage,
	createTurnGuard,
	findTrigger,
	normalizeConfig,
	renderCompactedBodyAsync,
	renderExpandBodyAsync,
	renderHistoryBody,
	renderUnavailable,
	resolveScope,
	resolveSessionId,
	validateExpandArgs,
	validateHistoryArgs
} from "./recall.js";
import { expandAt, filterRecords, normalizeWorkspacePath, searchCorpus, sessionSurfaceDocuments } from "./search.js";

/** 稳定的 Cordis 插件名。 */
export const name = "memory-unlocked";

/**
 * 硬依赖只有工具注册表。
 * `sessionQuery` 走**可选**依赖(`ctx.get("sessionQuery")`),缺它时工具要能
 * 说清楚"怎么修"而不是让整个组合起不来。
 */
export const inject = ["tools"];

/**
 * 自动注入的超时上限:它挡在模型步骤前面,绝不能拖住用户的这一轮。
 * ★ 它同时是这一轮的**预算**(见 `AUTO_BUDGET_MS`):`withTimeout` 只是最后的竞速兜底,
 *   真正能让遗留任务停手的是 budget 的硬检查 + `seal()`。
 */
export const AUTO_INJECT_TIMEOUT_MS = AUTO_BUDGET_MS;

/**
 * 工具描述必须短(官方实现 1750 字符 ≈ 440 tokens 常驻每个请求)。
 * 这里压到 500 字符以内,并且**必须**把两种模式的排序都写清楚 ——
 * 部署里全文索引可能被关闭 ⇒ **默认走扫描**,扫描就是按时间倒序
 * (第一条最近);索引可用时才换成 match_count 规则。只说一套就会误导模型。
 * 另外**必须**写明范围:"只能读**当前工作区**"(取不到工作目录时是"只读当前会话") ——
 * 这是模型唯一能直接看到的行为契约。
 */
export const HISTORY_DESCRIPTION =
	"回顾更早的会话内容(上下文被 compaction 压缩后依然能取回原文):在当前工作区的事件日志里检索。" +
	"★不给 query 时**不给「最近几条」**(那几条本来就在你上下文里,喂回来纯浪费)——" +
	"改为给出**当前会话被 compaction 挤掉的部分**,也就是真的已经不在你可见上下文里的那些事件。" +
	"每条命中都带 seq;要看原文就用 recall_expand({ seq })。" +
	"★范围 = **当前工作区**(拿不到工作目录时收窄为只读当前会话);" +
	"**没有**能指定别的工作区的参数,硬塞 scope/sessionIds 也会被忽略。" +
	"★默认走扫描兜底:当前会话优先、其余从新到旧,命中按时间倒序(已检查的会话里第一条最近),凑够条数即停;" +
	"索引可用时改按 match_count DESC → document_length ASC → time DESC(命中词多的靠前,不是按时间)。";

export const EXPAND_DESCRIPTION =
	"展开某一段的原文上下文(before/after 各默认 3 条事件)。" +
	"seq 用 recall_history 返回的那个。★不给 seq 时**不给「最近几条」**,改为给出该会话**被 compaction 挤掉的部分**。" +
	"sessionId 可省略(省略=当前会话);若显式给出,它必须落在**当前工作区**内,否则失败。";

/**
 * ★★ `published` 故意**不约束键** —— 为兼容宿主 `output.schema` 的窄词汇表校验而做的保守决定。
 *
 * 接线时要注意的两点:
 *  ① 声明里**少一个键** ⇒ 宿主严格校验直接拒绝,连成功路径都进不去:
 *     `"value.published.redactLabels" is not a declared property (additionalProperties: false)`
 *     ⇒ `recall_history` **每一次调用都失败**。
 *  ② 补键时用了 `anyOf: [{type:"string"},{type:"null"}]`(想让 token 允许 null)
 *     ⇒ **schema 编译失败,整个插件 fiber 变 `failed`、两个工具全部消失**
 *     (`plugin_manager` 里 `include:memory-unlocked → fiberPhase: "failed"`;工具报 `unknown tool`)。
 *     这比 ① 严重得多:① 只是调用失败,② 是插件根本没挂上。
 *
 * 注意:`output.schema` 走的是宿主一套**自定义、词汇表很窄且没有文档**的校验
 * (能正常工作的第三方插件只用 `type` / `additionalProperties` / `properties` /
 * 属性内 `required: true` / `items`;宿主的 `Tool.listTools` 甚至完全不返回 output 字段)。
 * 猜错的代价是"插件整个挂掉",所以这里只保留最保守的形态:`{type:"object"}` 不约束键。
 *
 * 那返回值形状由谁守?—— **单元测试**(`test/wiring.test.mjs` 的
 * "output.schema:与 publish() 逐键对齐"):它把 `publish()` 在 history/notice 两种模式下
 * 返回的键与两个工具的声明逐个比对,并**结构性禁止**再用 `anyOf`/`oneOf`/`type` 数组等
 * 宿主 DSL 不支持的构造。**它比宿主的运行时校验更严。**
 * ⇒ 改 `publish()` 的返回,就必须同步改那条测试。
 */
const PUBLISHED_SCHEMA = { type: "object" };

/**
 * 简单的超时包装:超时返回 undefined(调用方据此跳过自动注入)。
 * `Promise.race` 自己会给落败的 promise 挂 reject handler ⇒ 超时后底层任务再
 * reject 也不会留下 unhandledRejection;调用方**不需要**再补 `.catch()`。
 */
export async function withTimeout(promise, ms) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), ms); })
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * 注册两个工具 + 一个命令 + 一个 pre-step 监听器。
 * @param ctx - host 插件上下文。
 * @param rawConfig - profile patch 里的配置(可关、可配触发词)。
 */
export function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);
	const guard = createTurnGuard();

	const sessionQuery = () => {
		if (typeof ctx.get !== "function") return undefined;
		return ctx.get("sessionQuery");
	};

	/**
	 * 跑一次"粗召回";返回结构化值(含 published 文本)。
	 * ★ **只查当前工作区**(拿不到 cwd 时收窄为当前会话):范围从 `exec.agent` 解析,拿不到就显式失败(fail closed)。
	 * @param args - 工具参数(★ `scope` / `sessionIds` 即使传进来也**不读**)。
	 * @param exec - 宿主给的执行上下文:`{ agent, signal }`。
	 *               `signal` 来自 `exec.signal` —— 官方 tool `timeoutMs` 是**协作式**的
	 *               (它不取消工具),所以真能少扫几个会话的只有这个 Signal。
	 */
	async function runHistory(args, exec) {
		// ★ ① 先定范围,再谈别的:范围定不下来(agent 拿不到 / 没有 id)就什么都不查。
		//   顺序是刻意的 —— 安全边界不该排在"参数好不好看"后面。
		const scope = resolveScope(exec?.agent);
		if (scope.sessionId === undefined) return failure("SESSION_SCOPE_UNAVAILABLE", SCOPE_UNAVAILABLE_TEXT, config);
		const invalid = validateHistoryArgs(args);
		if (invalid) return failure("INVALID_ARGUMENT", invalid, config);
		const sq = sessionQuery();
		if (sq === undefined || sq === null) {
			return failure("SESSION_QUERY_UNAVAILABLE", renderUnavailable(), config);
		}
		const limit = args.limit ?? config.limit;
		const signal = exec?.signal;
		// ★ 一次工具调用共用**同一份预算**:检索(含索引补读、扫描)、骨架渲染、发布。
		//   20s 是工具路径的上限(自动注入是 8s,见 onPreStep)—— 两处必须都传下去,
		//   否则"渲染/发布"这两段会落在预算之外(那里同样可能很贵)。
		const budget = createBudget({
			deadlineMs: TOOL_BUDGET_MS,
			signal,
			maxDocs: COMPACT_MAX_DOCS,
			maxSourceChars: COMPACT_MAX_SOURCE_CHARS,
			label: "recall_history"
		});
		const redaction = createRedactionContext({ budget });
		try {
			if (typeof args.query === "string" && args.query.trim().length > 0) {
				// ★ 只把范围传下去;args 原样传(其中的 scope/sessionIds 没人读)
				const found = await searchCorpus(sq, args, { config, sessionId: scope.sessionId, cwd: scope.cwd, signal, redaction, budget });
				const body = renderHistoryBody({ ...found, query: args.query.trim(), scope, redaction });
				return { ok: true, mode: found.mode, published: publish(body, { maxChars: config.maxInjectChars, redaction, budget }) };
			}
			// ★ 没有关键词 ⇒ **"被 compaction 挤掉的部分"模式**。
			//   为什么不是"给最近的几条":那几条从没离开模型的上下文,喂回去纯浪费 token
			//   (设计上必须避免的问题)。真正"忘了"的是被压缩掉的那些事件。
			const compacted = await buildCompactedBody(sq, scope, { config, limit, signal, redaction, budget });
			if (!compacted.ok) return failure(compacted.code ?? "SESSION_QUERY_FAILED", compacted.error, config);
			return { ok: true, mode: "compacted", published: publish(compacted.body, { maxChars: config.maxInjectChars, redaction, budget }) };
		} catch (error) {
			return failureFor(error, config);
		} finally {
			// ★ 封存:返回之后**不允许**任何遗留任务再发布或改动脱敏统计
			//   (再碰到 budget/redaction 会直接抛错,且抛错发生在脱敏之前,不会产出文本)。
			budget.seal();
		}
	}

	/**
	 * 跑一次"展开"。★ 范围 = 当前工作区。
	 * @param args - 工具参数(`sessionId` 可省略 = 当前会话;给了就必须落在当前工作区内)。
	 * @param exec - 宿主给的执行上下文:`{ agent, signal }`
	 *               (signal 透给 `readEvent` / `readSurface`)。
	 */
	async function runExpand(args, exec) {
		// ★ ① 先定范围(与 runHistory 同一条规则:fail closed,不回落)
		const scope = resolveScope(exec?.agent);
		if (scope.sessionId === undefined) return failure("SESSION_SCOPE_UNAVAILABLE", SCOPE_UNAVAILABLE_TEXT, config);
		const invalid = validateExpandArgs(args);
		if (invalid) return failure("INVALID_ARGUMENT", invalid, config);
		const requested = args.sessionId;
		const target = requested === undefined || requested === null ? scope.sessionId : requested;
		const sq = sessionQuery();
		if (sq === undefined || sq === null) {
			return failure("SESSION_QUERY_UNAVAILABLE", renderUnavailable(), config);
		}
		const signal = exec?.signal;
		// ★ 展开也必须在预算内:窗口条数由 MAX_WINDOW 限住,但**单条正文**可以很大
		//   (`renderExpandBody` 另有源字符上限);取消/封存对渲染同样生效。
		const budget = createBudget({
			deadlineMs: TOOL_BUDGET_MS,
			signal,
			maxDocs: COMPACT_MAX_DOCS,
			maxSourceChars: COMPACT_MAX_SOURCE_CHARS,
			label: "recall_expand"
		});
		try {
			// ★ 预取消先于跨会话范围检查:否则会先调一次宿主 filterSessions,
			//   被它的 AbortError 吞成"范围外"(错 code),而不是如实的"已取消"。
			budget.check();
			// ★ ② 请求的会话必须落在**当前工作区**内。不等且不属于本工作区 ⇒ 拒绝,
			//   并且**绝不去读它**;失败文本里也不出现那个 id(免得把它变成模型手里的一条信息)。
			if (target !== scope.sessionId && !(await isSessionInScope(sq, target, scope, signal))) {
				return failure("SESSION_OUT_OF_SCOPE", OUT_OF_SCOPE_TEXT, config);
			}
			budget.check();
			const scoped = requested === undefined || requested === null ? { ...args, sessionId: target } : args;
			const redaction = createRedactionContext({ budget });
			if (scoped.seq === undefined || scoped.seq === null) {
				// ★★ 不给 seq 时,不给"该会话最近的 N 条" —— 那几条本来就在模型的上下文里,
				//    喂回去纯浪费 token(并已用回归测试钉住)。
				//    因此这里给**该会话被 compaction 挤掉的部分**,与触发词路径输出同一种东西。
				const compacted = await buildCompactedBody(
					sq,
					{ ...scope, sessionId: target },
					{ config, limit: config.limit, includeOthers: target === scope.sessionId, signal, redaction, budget }
				);
				if (!compacted.ok) return failure(compacted.code ?? "SESSION_QUERY_FAILED", compacted.error, config);
				return { ok: true, mode: "compacted", published: publish(compacted.body, { maxChars: config.maxInjectChars, redaction, budget }) };
			}
			const result = await expandAt(sq, scoped, config, signal, budget);
			if (!result.ok) return failure(result.code ?? "SESSION_QUERY_FAILED", result.error, config);
			// ★ 取消与让出:生产路径走**有界异步渲染** —— 接入同一份 budget(时间 + 取消 +
			//   封存),每 EXPAND_YIELD_EVERY 条让出一拍;触界时正文如实写"只展开到第几条"。
			//   同步 `renderExpandBody` 面向纯函数与同步调用,它没有 deadline/取消。
			const body = await renderExpandBodyAsync({ ...result, scope, redaction }, { budget });
			return { ok: true, mode: "expand", published: publish(body, { maxChars: config.maxInjectChars, redaction, budget }) };
		} catch (error) {
			return failureFor(error, config);
		} finally {
			budget.seal();
		}
	}

	const historyTool = {
		name: "recall_history",
		description: HISTORY_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "要检索的字面短语。★省略**不给「最近几条」**,而是给出当前会话被 compaction 挤掉的部分。后端自己做转义,不要拼 FTS 语法。" },
				limit: { type: "number", description: `返回条数上限(默认 ${DEFAULT_CONFIG.limit},最大 20)` }
			},
			required: []
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean" },
					mode: { type: "string" },
					error: {
						type: "object",
						additionalProperties: false,
						properties: { code: { type: "string" }, message: { type: "string" } }
					},
					published: PUBLISHED_SCHEMA
				}
			},
			render: (_args, value) => [{ type: "text", text: value?.published?.text ?? "(没有可返回的内容)" }]
		},
		timeoutMs: 30000,
		async execute(args, exec) {
			// ★ 必须接住第二个参数:官方 timeoutMs 只是协作式超时,真正能喊停的
			//   是 exec.signal;而且**范围**也要从 exec.agent 解析(见 runHistory)。
			return runHistory(args ?? {}, exec);
		}
	};

	const expandTool = {
		name: "recall_expand",
		description: EXPAND_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				sessionId: { type: "string", description: "可省略(=当前会话)。若给出,必须落在当前工作区内,否则失败 —— 工作区外的会话不可读。" },
				seq: { type: "number", description: "recall_history 返回的 seq。★省略时不给「最近几条」,而是给该会话被 compaction 挤掉的部分" },
				before: { type: "number", description: "往前取几条事件(默认 3,官方上限 50)" },
				after: { type: "number", description: "往后取几条事件(默认 3,官方上限 50)" }
			},
			// ★ sessionId 可选:省略即当前会话(范围固定,给不给都不放宽)
			required: []
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean" },
					mode: { type: "string" },
					error: {
						type: "object",
						additionalProperties: false,
						properties: { code: { type: "string" }, message: { type: "string" } }
					},
					published: PUBLISHED_SCHEMA
				}
			},
			render: (_args, value) => [{ type: "text", text: value?.published?.text ?? "(没有可返回的内容)" }]
		},
		timeoutMs: 30000,
		async execute(args, exec) {
			return runExpand(args ?? {}, exec);
		}
	};

	if (ctx.tools && typeof ctx.tools.register === "function") {
		ctx.effect(() => ctx.tools.register(historyTool), "memory-unlocked: tool recall_history");
		ctx.effect(() => ctx.tools.register(expandTool), "memory-unlocked: tool recall_expand");
	}

	// ---- 人用的 /recall 命令 ----
	const commands = typeof ctx.get === "function" ? ctx.get("commands") : undefined;
	if (commands !== undefined && commands !== null) {
		ctx.effect(() => commands.register({
			name: "recall",
			description: "检索当前工作区更早的内容(用法:/recall <关键词>)",
			input: { hint: "关键词" },
			handler: async (invocation) => {
				// ⚠️ 官方 CommandDefinition.handler 收到的是 CommandInvocation 对象
				//    ({commandId, agent, rawInput, attachments, signal}),不是字符串。
				//    因此必须从对象上取 `rawInput`;裸字符串只用于识别"空参 → 用法错误"
				//    这一条路径。两种形状都兼容,且**空参一律返回 kind:"error"**。
				//
				// ★ 兼容裸字符串形状**只覆盖"空参 → 用法错误"那条路径**:字符串形态
				//   没有 `agent`,解析不出当前会话 ⇒ 带着 query 的字符串调用会落在
				//   SESSION_SCOPE_UNAVAILABLE 上(fail closed)。这是刻意的:范围定不
				//   下来就不查,而不是"猜一个/放宽一点"。
				const raw = typeof invocation === "string"
					? invocation
					: (typeof invocation?.rawInput === "string" ? invocation.rawInput : "");
				const query = raw.trim();
				if (query.length === 0) {
					// ⚠️ 这里**不要**回显触发词本体:命令输出会进对话,
					//    正文里一旦出现触发词,下一轮就可能被自己的输出触发。
					return { kind: "error", text: "用法:/recall <关键词>\n例如:/recall 示例关键词\n(只想回顾当前会话更早的内容就直接说触发词;触发词在 profile 配置的 triggers 里可查可改)" };
				}
				// ★ 范围只能来自 CommandInvocation.agent(官方契约字段)
				const value = await runHistory({ query }, { agent: invocation?.agent, signal: invocation?.signal });
				if (!value.ok) return { kind: "error", text: value.published.text };
				return { kind: "success", text: value.published.text };
			}
		}), "memory-unlocked: command /recall");
	}

	// ---- ★ agent/pre-step:用户打一句话就自动回顾 ----
	if (typeof ctx.on === "function") {
		const onPreStep = async (payload, next) => {
			// 先取默认决定(next() = 保留当前消息)
			const decision = await next();
			if (!decision || decision.kind !== "enter") return decision;   // 被别人 reject 了就不插手
			if (config.enabled !== true) return decision;
			// ★ 只看**用户这一轮实际提交的输入**(`payload.messages`),
			//   不看 `decision.messages`:宿主的默认决定是 `[...claimed, context]`,
			//   而 `context` 由 `createUserMessage(...)` 构造 —— 也就是每个
			//   `ctx.systemPrompt.context({...})` 注册项都表现为一条 `role:"user"` 的消息。
			//   若扫 `decision.messages`,运行时上下文里恰好出现触发词就会**在回合中途**触发展开。
			//   ⚠️ 拿不到 `payload.messages` 时**宁可这次不注入**,也**绝不回落到**
			//   `decision.messages`:那个数组里掺着宿主自产文本,回落等于把这个缺陷
			//   原样放回来。少一次自动回顾只是少一个便利;回合中途误触发是错误行为。
			const claimed = Array.isArray(payload?.messages) ? payload.messages : [];
			const hit = findTrigger(claimed, config);
			if (!hit) return decision;                                      // ★ 没触发 ⇒ 原样返回,零开销
			// ★ 范围:**只认 payload.agent 解析出的范围**。解析不出来就原样返回 ——
			//   注入 nothing、报 nothing(自动路径不该因为环境缺字段而打断用户这一轮),
			//   但**绝不**放宽范围。放在幂等闸之前:范围定不下来时连"这一轮已注入"都别记,
			//   否则将来同一轮里范围恢复可用也会被幂等闸挡住。
			const scope = resolveScope(payload?.agent);
			if (scope.sessionId === undefined || payload?.signal?.aborted) return decision;
			if (!guard.shouldInject(payload?.agent?.id, payload?.turn)) return decision;  // ★ 幂等

			let published;
			const controller = new AbortController();
			const cancel = () => controller.abort();
			payload?.signal?.addEventListener("abort", cancel, { once: true });
			const timer = setTimeout(cancel, AUTO_INJECT_TIMEOUT_MS);
			// ★ 自动注入与工具路径**同一套预算机制**,只是窗口更短(8s):
			//   `withTimeout` 是竞速兜底,真正能让遗留任务停手的是 budget 的硬检查 + `seal()`;
			//   预算绑在 controller.signal 上 ⇒ 8s 到点/上游取消都会让下一次检查抛错。
			const budget = createBudget({
				deadlineMs: AUTO_BUDGET_MS,
				signal: controller.signal,
				maxDocs: COMPACT_MAX_DOCS,
				maxSourceChars: COMPACT_MAX_SOURCE_CHARS,
				label: "auto-recall"
			});
			const redaction = createRedactionContext({ budget });
			try {
				const sq = sessionQuery();
				if (sq === undefined || sq === null) return decision;       // 服务不在就不注入(不报错打断)
				const work = buildAutoBody(sq, hit, config, scope, redaction, controller.signal, budget);
				// ★ `Promise.race` 会给每个参赛 promise 注册 reject handler:竞速超时后
				//   底层任务再 reject 也**不会**成为 unhandledRejection,无需额外的 catch。
				const body = await withTimeout(work, AUTO_INJECT_TIMEOUT_MS);
				if (typeof body !== "string" || controller.signal.aborted) return decision;
				published = publish(body, {
					maxChars: config.maxInjectChars,
					heading: "（自动回顾:用户说了触发词）",
					redaction,
					budget
				});
			} catch {
				// 自动注入失败**绝不打断用户这一轮** —— 这是与工具路径的关键不对称:
				// 工具失败要显式失败,自动注入失败就静默退回(用户还能手动调工具)。
				return decision;
			} finally {
				clearTimeout(timer);
				payload?.signal?.removeEventListener("abort", cancel);
				// 竞速超时不等于底层读已结束;禁止遗留任务继续启动后续会话扫描。
				controller.abort();
				// ★ 并且**封存**预算:遗留任务之后再碰脱敏/发布会抛错,
				//   不可能在本次返回之后补发布或改动统计。
				budget.seal();
			}
			// ★ 必须传与 findTrigger **同一个数组**:`hit.messageIndex` 的下标属于 `claimed`,
			//   改用 `decision.messages` 会取到错位的模板(两者长度可能不同)。
			const injected = buildInjectedMessage(claimed, hit, published.text);
			if (!injected) return decision;
			return { ...decision, messages: [...decision.messages, injected] };
		};
		ctx.effect(() => {
			const disposer = ctx.on("agent/pre-step", onPreStep);
			return typeof disposer === "function" ? disposer : () => {};
		}, "memory-unlocked: agent/pre-step");
	}

	return { config, guard };
}

/**
 * 自动回顾的正文:有关键词走检索;**没关键词给"被 compaction 挤掉的部分"**。
 *
 * ★ 与工具路径**同一个范围**(当前工作区):范围由调用点从 `payload.agent` 解析出来,
 *   `sessionId` 拿不到就根本不会走到这里(fail closed 在 onPreStep 里完成)。
 *
 * ★ 且**与工具路径同一个"回顾目标"**:都走 `buildCompactedBody`。这是刻意的 ——
 *   无关键词时必须给"被 compaction 挤掉的部分",而不是最近几条(那几条本来就在上下文里),
 *   两条路必须给出同一种东西,否则两条路径会不一致。
 *
 * @param sq - `ctx.sessionQuery`。
 * @param hit - `findTrigger` 的返回(`keyword` 为空 ⇒ "被压缩掉的部分"模式)。
 * @param config - 规整后的配置。
 * @param scope - `{ sessionId, cwd }`(必传,且已由调用点保证 `sessionId` 可用)。
 * @param budget - 本轮共享预算(自动注入路径)。检索、骨架渲染都受它约束。
 */
async function buildAutoBody(sq, hit, config, scope, redaction, signal, budget) {
	// payload.signal 与8秒预算共同约束后续读取;filterEvents 不支持中途硬取消。
	signal?.throwIfAborted();
	budget?.check();
	if (hit.keyword && hit.keyword.length > 0) {
		const found = await searchCorpus(sq, { query: hit.keyword, limit: config.limit }, { config, sessionId: scope.sessionId, cwd: scope.cwd, redaction, signal, budget });
		return renderHistoryBody({ ...found, query: hit.keyword, scope, redaction });
	}
	const compacted = await buildCompactedBody(sq, scope, { config, limit: config.limit, redaction, signal, budget });
	// ★ 失败时不要把失败当正文注入:抛出去,由 onPreStep 的 catch 静默退回。
	if (!compacted.ok) throw new Error(compacted.error ?? "被压缩掉的内容读取失败");
	return compacted.body;
}

/**
 * 把 catch 到的错误变成结构化失败值。
 *
 * ★ 预算/取消类错误用**固定文案**与专用 code:绝不把 `signal.reason` 之类的
 *   调用方数据带进发布文本(它可能含凭据;见 security 回归)。
 */
function failureFor(error, config) {
	if (error?.name === BUDGET_ERROR_NAME) {
		const cancelled = error.reason === "signal";
		return failure(
			cancelled ? "SESSION_QUERY_CANCELLED" : "SESSION_QUERY_BUDGET_EXHAUSTED",
			cancelled
				? "本次回顾已被取消:没有发布任何历史内容(只有这条提示)。可以直接重新调用。"
				: "本次回顾已结束(预算/结果已封存),后续处理被拒绝:没有发布历史内容。可以重新调用。",
			config
		);
	}
	const text = error && typeof error === "object" && typeof error.message === "string"
		? error.message : String(error);
	return failure("SESSION_QUERY_FAILED", text, config);
}

/**
 * ★ 解析不出当前会话时的**显式**失败文本(工具路径 / `/recall`)。
 *
 * 为什么必须显式失败而不是"当作查不到":范围定不下来时,"空结果"会被模型读成
 * "历史上没有" —— 那是**错误信息**,比失败更糟。这里说清楚是"拿不到范围"。
 * ⚠️ 文本里**不出现任何会话 id**(连当前的都不出现):这份文本会进模型上下文,
 *    没有理由让它多知道一个 id。首词同样不能是触发词(见 renderUnavailable)。
 */
export const SCOPE_UNAVAILABLE_TEXT =
	"无法确定当前会话:宿主没有把 agent 的会话 id 交给这个工具,所以这次**不查**。" +
	"检索范围固定为当前工作区(安全边界),拿不到范围时**不会**退回到更大范围。" +
	"修法:在会话里正常调用(工具通过 exec.agent / 命令通过 invocation.agent 拿到当前会话)。";

/**
 * ★ 请求了工作区外的会话时的失败文本。
 *
 * 一个字都不提那个会话:**不回显请求里的 id、不说明它是否存在、不给出任何差异**。
 * 调用方唯一能知道的就是"请求的会话不在当前工作区"。当然更不会去读它。
 */
export const OUT_OF_SCOPE_TEXT =
	"recall_expand 只能展开**当前工作区**里的会话:请求的 sessionId 不在本工作区,已拒绝。" +
	"省略 sessionId 即可(省略=当前会话),或直接用 recall_history 拿到的 seq。";

/**
 * ★ 请求的会话是否落在**当前工作区**内。
 *
 * 用官方 `filterSessions` 的两个子句 AND 起来判定(id + cwd),比"自己列一遍再比对"
 * 少一次全量列表。但**不把过滤结果当可信**:子句由宿主/后端执行,敌意或有 bug 的
 * 后端可以无视它们返回非空数组。记录自带 `header.id` / `header.cwd`,所以这里再用
 * 与检索层同一个 `normalizeWorkspacePath` 做**本地 id+cwd 复筛**。
 * 判定不了(服务不支持 / 抛错 / cwd 未知 / 记录不匹配)一律**拒绝** —— 保守方向。
 */
async function isSessionInScope(sq, target, scope, signal) {
	if (typeof scope.cwd !== "string" || scope.cwd.length === 0) return false;
	if (typeof sq.filterSessions !== "function") return false;
	const workspaceKey = normalizeWorkspacePath(scope.cwd);
	try {
		const list = await sq.filterSessions(
			[{ kind: "id", values: [target] }, { kind: "cwd", values: [scope.cwd] }],
			signal
		);
		if (!Array.isArray(list) || list.length === 0) return false;
		return list.some((record) => {
			const normalized = normalizeSessionRecord(record);
			return normalized.sessionId === target
				&& workspaceKey !== undefined
				&& normalizeWorkspacePath(normalized.cwd) === workspaceKey;
		});
	} catch {
		return false;
	}
}

/** 本工作区里**除当前会话外**的其它会话(供"本会话没有被压缩掉的内容"时钻取)。 */
async function workspaceOtherSessions(sq, scope, limit, signal, budget = undefined) {
	if (typeof scope.cwd !== "string" || scope.cwd.length === 0) return [];
	try {
		budget?.check();
		const records = await sq.listSessions(signal);
		budget?.check();
		return filterRecords(records, { cwd: scope.cwd, currentSessionId: scope.sessionId })
			.filter((record) => record.sessionId !== scope.sessionId)
			.slice(0, Math.max(1, limit));
	} catch {
		return [];
	}
}

/**
 * ★★ "被 compaction 挤掉的部分"模式的正文(无关键词时用)。
 *
 * 核心设计取舍:无关键词时**不**给"当前会话最近的表层事件",
 * 而那几条**从没离开模型的上下文** —— 等于把模型自己的思考过程再喂回去,纯浪费 token。
 * 真正"忘了"的是被 compaction 替换掉、已不在可见表面上的事件(`surface:"shadowed"`,
 * 见 `compactionRemovedEvents` 的注释)。
 *
 * 三件事:
 *   ① 取 shadowed 事件(官方按 seq 升序返回 = 最早的在前),受 `publish()` 预算约束,
 *      截断由 `publish()` 如实标注;
 *   ② 写出"当前表面多少条 / 被压缩掉多少条 / 你看的是哪一段";
 *   ③ 若**一条都没有** ⇒ 如实说,然后**明确标注**地附上本工作区其它会话(供钻取)。
 *
 * ★ 渲染走**异步**通道(`renderCompactedBodyAsync`):每 16 篇让出一拍,
 *   并带上本次调用的 budget(时间 + 确定性上界),而不是用一个同步 `.map`
 *   把整段事件日志一口气算完。
 */
async function buildCompactedBody(sq, scope, { config, limit, signal, redaction, budget, includeOthers = true }) {
	// ★ 一次调用拿到**全部**文本事件及其 surface 分类(见 `sessionSurfaceDocuments` 的说明):
	//   避免"filterEvents(shadowed) + readSurface"的**两次整档重放**。
	const { docs, counts, error } = await sessionSurfaceDocuments(sq, scope.sessionId, signal, budget);
	if (error) return { ok: false, code: "SESSION_QUERY_FAILED", error };
	const others = (counts.shadowed ?? 0) === 0 && includeOthers
		? await workspaceOtherSessions(sq, scope, limit, signal, budget)
		: [];
	return {
		ok: true,
		body: await renderCompactedBodyAsync(
			{ sessionId: scope.sessionId, scope, docs, counts, others, budget: config.maxInjectChars, redaction },
			{ budget }
		)
	};
}

/** 错误的结构化值与可读值共享同一份已脱敏、受预算约束的文本。 */
function failure(code, message, config) {
	const redaction = createRedactionContext();
	// 后端 code 不是可信正文;只保留无凭据形态的短机器码,避免 heading 成为旁路。
	const rawCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)
		? code : "SESSION_QUERY_FAILED";
	const codeText = redaction.text(rawCode);
	const safeCode = codeText === rawCode ? rawCode : "SESSION_QUERY_FAILED";
	const published = publish(`${message}`, {
		kind: "notice", maxChars: config.maxInjectChars, heading: `[${safeCode}]`, redaction
	});
	return {
		ok: false,
		mode: "error",
		error: { code: safeCode, message: published.text },
		published
	};
}
