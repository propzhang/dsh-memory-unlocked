/**
 * 纯函数层:配置规整 / 参数校验 / 请求构造 / 触发词检测 / 渲染。
 *
 * 这一层不碰网络、不碰 fs、不碰 ctx,因此可以脱离 DSH 单测(见 test/)。
 * 把逻辑与接线揉在一起时,文档里写的断言往往覆盖不到真正的失败路径 ——
 * 比如 `/recall` 空参返回 `kind:"success"` 这类 bug 就抓不到。
 * 这一层单独成文件,就是为了让那些 bug 有地方被抓。
 *
 * @module dsh-memory-unlocked/recall
 */
import { clampInt, extractText, isPlainObject } from "./normalize.js";
import {
	COMPACT_MAX_DOCS,
	COMPACT_MAX_SOURCE_CHARS,
	COMPACT_TAIL_WINDOW,
	COMPACT_YIELD_EVERY,
	EXPAND_MAX_SOURCE_CHARS,
	EXPAND_YIELD_EVERY,
	createBudget
} from "./budget.js";
import { redact } from "./redact.js";

/** 工具可返回的最大会话数(官方后端 limit 上限是 100,这里更保守)。 */
export const MAX_LIMIT = 20;
/** 官方 `readWindowMax` 默认 50:`readEvent` 的 before/after 超了会抛 INVALID_WINDOW。 */
export const MAX_WINDOW = 50;
/** 查询串长度上限:500 字符。 */
export const MAX_QUERY_CHARS = 500;
/** 单个触发词的长度上限。 */
export const MAX_TRIGGER_CHARS = 32;
/** 触发词条数上限(免得配置里塞一个超长数组把正则撑爆)。 */
export const MAX_TRIGGERS = 8;
/** 注入块的默认预算。 */
export const DEFAULT_MAX_INJECT_CHARS = 3000;

/**
 * 出厂触发词:**三个都生效**。
 * 大小写折叠由正则的 `iu` 标志完成 ⇒ `Memory unlocked` / `MEMORY UNLOCKED` 等价
 *(不是手工 `toLowerCase()`,原因见 `findTrigger`:手工折叠会让下标错位)。
 * 匹配取"最靠左"的那个命中,这样"触发词后面的内容"才是检索关键词。
 * ⚠️ 顺序**只在平局时**才有意义:两个触发词在同一位置都能匹配时,正则 alternation
 * 取**先写**的那条(所以 `["DJYHFS 证书", "DJYHFS"]` 与反过来写,keyword 会不同)。
 * 出厂这三个互不为前缀,顺序无影响。
 */
export const DEFAULT_TRIGGERS = Object.freeze(["Memory unlocked", "大记忆恢复术", "DJYHFS"]);

/**
 * 出厂配置。`enabled` / `triggers` 是可配的两道闸。
 *
 * ★ 这里**故意没有** scope / includeSubagents / … 这类"检索范围"配置项。
 *   本插件只读**当前工作区**(见 `resolveScope`),范围是**安全边界,不是偏好**:
 *   一旦做成配置项,就等于给模型(或任何能改 profile 的人)留了一条读取别的会话的路。
 *   官方 `sessionQuery` 的 README 把话写得很直白 —— "No caller authorization:
 *   this is trusted context-wide infrastructure; a model tool or UI must constrain
 *   which sessions its caller may inspect" —— 服务本身不鉴权,约束只能硬编码在
 *   调用方这里。所以约束就写死在代码里,而不是"默认收紧、可以放宽"。
 */
export const DEFAULT_CONFIG = Object.freeze({
	enabled: true,
	triggers: DEFAULT_TRIGGERS,
	maxInjectChars: DEFAULT_MAX_INJECT_CHARS,
	limit: 5,
	before: 3,
	after: 3
});

/**
 * 把配置里的触发词规整成**去重后的非空数组**。**永不抛**。
 * 接受两种写法:
 *   `triggers: ["Memory unlocked", "大记忆恢复术", "DJYHFS"]`  (数组)
 *   `trigger: "大记忆恢复术"`                                   (单值)
 * 全部非法/为空时回落到 `DEFAULT_TRIGGERS`(返回副本,不把冻结数组交出去)。
 * @param raw - 原始配置值。
 * @returns 触发词数组(至少一条)。
 */
export function normalizeTriggers(raw) {
	const list = Array.isArray(raw) ? raw : (typeof raw === "string" ? [raw] : []);
	const out = [];
	const seen = new Set();
	for (const item of list) {
		if (typeof item !== "string") continue;
		const value = item.trim().slice(0, MAX_TRIGGER_CHARS);
		if (value.length === 0) continue;
		// 按小写去重 —— 匹配本来就大小写不敏感,重复的只留一条
		const key = value.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(value);
		if (out.length >= MAX_TRIGGERS) break;   // 上限保护:正则分支数有界
	}
	return out.length > 0 ? out : [...DEFAULT_TRIGGERS];
}

/**
 * 规整插件配置。**永不抛**:非法值一律回落到默认。
 *
 * ★ 只认"行为"旋钮(enabled / triggers / 预算 / 条数 / 窗口)。
 *   scope / includeSubagents 这类**范围**旋钮一律不读 —— 读了就等于承认范围可配。
 * @param raw - 来自 profile patch 的原始配置。
 * @returns 规整后的配置。
 */
export function normalizeConfig(raw) {
	const input = isPlainObject(raw) ? raw : {};
	return {
		enabled: input.enabled === undefined ? DEFAULT_CONFIG.enabled : input.enabled !== false,
		// 同时接受数组写法 `triggers: [...]` 与单值写法 `trigger: "..."`。
		triggers: normalizeTriggers(input.triggers ?? input.trigger),
		maxInjectChars: clampInt(input.maxInjectChars, 400, 20000, DEFAULT_CONFIG.maxInjectChars),
		limit: clampInt(input.limit, 1, MAX_LIMIT, DEFAULT_CONFIG.limit),
		before: clampInt(input.before, 0, MAX_WINDOW, DEFAULT_CONFIG.before),
		after: clampInt(input.after, 0, MAX_WINDOW, DEFAULT_CONFIG.after)
	};
}

/**
 * ★ 解析"当前会话"的 id —— 范围解析的起点会话。
 *
 * 依次尝试两条权威来源:
 *   ① `agent.session?.header?.id` —— 会话头 `SessionHeader.id`(权威 id)
 *   ② `agent.id`                 —— 宿主契约 `Agent { readonly id: SessionId }`
 *
 * 只有非空且不含 NUL 的字符串才算解析成功;否则返回 `undefined`。
 *
 * ⚠️ **每一个调用点都必须在拿到 `undefined` 时 fail closed**(显式失败,或自动路径
 *    原样返回不注入)—— **绝不**回落到"更大的范围"。特别地:不要写"拿不到当前
 *    会话 id 就查全部"这种兜底 —— 那正是这条边界要拦下的行为。范围不是可选参数,
 *    它没有默认值可退。
 *
 * @param agent - `exec.agent` / `payload.agent` / `invocation.agent`。
 * @returns 会话 id(非空字符串)或 `undefined`(调用方必须 fail closed)。
 */
export function resolveSessionId(agent) {
	const candidates = [agent?.session?.header?.id, agent?.id];
	for (const value of candidates) {
		if (typeof value === "string" && value.length > 0 && !value.includes("\0")) return value;
	}
	return undefined;
}

/**
 * ★ 解析**检索范围**:`{ sessionId, cwd }`。
 *
 * 范围是**当前工作区**,不是"当前会话"也不是"全部会话":
 *   · `cwd` 拿得到 ⇒ 范围 = **当前工作区**(该工作目录下的所有非子代理会话 + 当前会话自己);
 *   · `cwd` 拿不到(`SessionHeader.cwd` 是**可选**字段)⇒ **退化为"只读当前会话"**。
 *
 * ⚠️ 注意那个退化方向:会话 ⊂ 工作区,所以"拿不到 cwd 就只看当前会话"是**更窄**的范围,
 *    是安全方向的降级,不是放宽。**绝不允许**出现"拿不到 cwd 就查全部"。
 *    调用方必须把 `cwd` 是否解析到**如实写进输出**(见两个渲染器的范围行)。
 *
 * `cwd` 的权威来源是 `agent.session.header.cwd` —— 官方系统提示里的 `{{cwd}}` 就是从
 * 同一个字段渲染的(`ctx.systemPrompt.variable("cwd", (context) => context.agent?.session.header.cwd)`),
 * 已实测确认它取得到值。
 *
 * @param agent - `exec.agent` / `payload.agent` / `invocation.agent`。
 * @returns `{ sessionId, cwd }`;`sessionId` 为 `undefined` 时调用方必须 fail closed。
 */
export function resolveScope(agent) {
	const header = agent?.session?.header;
	const rawCwd = header?.cwd;
	const cwd = typeof rawCwd === "string" && rawCwd.length > 0 && !rawCwd.includes("\0")
		? rawCwd
		: undefined;
	return { sessionId: resolveSessionId(agent), cwd };
}

/**
 * 取触发词之后的**第一行 / 第一句**作为检索词。
 *
 * 为什么必须切:把一段含触发词的长文粘进来时,"触发词后面全部(最多 500 字符)"
 * 如果被整段当成检索词,必然 0 命中(实测会取到 500 字符的正文)。
 * 只取第一行/第一句,既能拿到人真正想查的那个词,又不会把整篇文档当查询。
 *
 * 切分顺序:先按换行,再按中英文句末标点(`。!?！？;；`),最后 trim。
 * 全是空白/标点 ⇒ 返回 `""`,调用方按"没有关键词"处理。
 *
 * @param text - 触发词之后的原文。
 * @returns 检索词(可能为空串)。
 */
export function firstSentenceAfter(text) {
	const stripped = String(text ?? "").replace(/^[\s:：,,-]+/u, "");
	const line = stripped.split(/\r?\n/u)[0] ?? "";
	const sentence = line.split(/[。!?！？;；]/u)[0] ?? "";
	return sentence.trim().slice(0, MAX_QUERY_CHARS);
}

/** 校验 `recall_history` 参数;返回错误串或 null。 */
export function validateHistoryArgs(args) {
	const input = isPlainObject(args) ? args : {};
	const query = input.query;
	if (query !== undefined && query !== null) {
		if (typeof query !== "string") return "query 必须是字符串";
		if (query.length > MAX_QUERY_CHARS) return `query 太长(${query.length} > ${MAX_QUERY_CHARS})`;
		if (query.includes("\0")) return "query 不能包含 NUL 字节";
	}
	if (input.limit !== undefined && input.limit !== null) {
		if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIMIT) {
			return `limit 必须是 1..${MAX_LIMIT} 的整数`;
		}
	}
	// ★ 这里**故意不读** `args.sessionIds` / `args.scope`(连"校验它们"都不做):
	//   这两个范围类参数不在参数表里,但敌意或困惑的调用方仍然会发过来。
	//   忽略是**要求**,校验反而会把"这些字段是有意义的"这件事留在代码里,
	//   下一个读代码的人就可能把它们再接回检索路径。检索范围由调用点用
	//   `resolveSessionId(exec.agent)` 决定,与参数无关。
	return null;
}

/** 校验 `recall_expand` 参数;返回错误串或 null。 */
export function validateExpandArgs(args) {
	const input = isPlainObject(args) ? args : {};
	// sessionId 是**可选**的:省略=当前会话。给了就必须是非空字符串 ——
	// 它还要在调用点与当前会话 id 比对,形状不对就早点显式报错。
	if (input.sessionId !== undefined && input.sessionId !== null) {
		if (typeof input.sessionId !== "string" || input.sessionId.length === 0) {
			return "sessionId 必须是非空字符串(可省略:省略=当前会话)";
		}
		if (input.sessionId.includes("\0")) return "sessionId 不能包含 NUL 字节";
	}
	if (input.seq !== undefined && input.seq !== null) {
		if (!Number.isInteger(input.seq) || input.seq < 0) return "seq 必须是非负整数";
	}
	for (const key of ["before", "after"]) {
		const value = input[key];
		if (value === undefined || value === null) continue;
		if (!Number.isInteger(value) || value < 0 || value > MAX_WINDOW) {
			return `${key} 必须是 0..${MAX_WINDOW} 的整数(官方 readWindowMax)`;
		}
	}
	return null;
}

/** 从消息里取可读文本(消息可能是 MessageBase 或裸字符串)。 */
export function messageText(message) {
	if (typeof message === "string") return message;
	if (!isPlainObject(message)) return "";
	const candidate = message.content ?? message.message?.content;
	if (Array.isArray(candidate)) {
		return candidate.map((block) => {
			if (typeof block === "string") return block;
			if (isPlainObject(block) && typeof block.text === "string") return block.text;
			return "";
		}).filter(Boolean).join("\n");
	}
	if (typeof message.text === "string") return message.text;
	return "";
}

/** 正则转义:触发词是用户可配的,直接拼进 `RegExp` 会炸。 */
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * ★ 纯函数:在待进入本步的消息里找触发词。**三个触发词任意命中一个即可。**
 *
 * 从**最新**的消息往前找(最新的用户消息优先);只看 `role === "user"`,
 * 免得把模型自己的输出或工具结果里的触发词也算上。
 * 大小写不敏感:`Memory unlocked` / `MEMORY UNLOCKED` / `memory unlocked` 等价。
 *
 * 支持两种形态(以任一触发词为例):
 *   只说触发词          → `{ keyword: "" }`(回顾当前会话被 compaction 挤掉的部分)
 *   触发词 + <关键词>   → `{ keyword: "<关键词>" }`(在当前会话里检索)
 * 同一句里出现多个触发词时,**取最靠左的那个** —— 它后面的内容才算关键词。
 *
 * ★ 还会跳过**本插件自己注入的那条消息**(它 `role:"user"`,正文里可能含触发词,
 *   因为召回的历史天然带着这些词)。识别靠 `INJECTED_ID_PREFIX` 前缀 ——
 *   这正是 `buildInjectedMessage` **无论如何都要给注入消息发一个 id** 的原因
 *   (即使模板上没有 id)。
 *
 *   ⚠️ 这是**纵深防御,不是当前唯一防线,也不是"闭合回路的原因"**:按宿主源码,
 *   `ReactLoopInbox.claim()` 只把待处理输入排空,从不重新提供会话消息面,所以注入块
 *   在任何**当前可达**路径上都不会被再次 claim —— "自我触发"目前并不可达。仍然保留
 *   是因为:① 可达性依赖宿主的具体实现,一旦宿主改成"每步重扫会话消息"就立刻变可达,
 *   而这里只是每步一次字符串前缀比较;② 前缀顺带让会话日志里一眼能认出"这条不是用户打的"。
 *
 * @param messages - `UserMessage[]`(★ 调用方必须传**用户这一步实际提交的输入**,
 *                   不能传宿主拼好的 `decision.messages` —— 后者掺着运行时上下文)。
 * @param config - 规整后的配置(读 `triggers`;缺失时回落到 `DEFAULT_TRIGGERS`)。
 * @returns `{ keyword, messageIndex, rawTail }` 或 `null`(形状保持不变)。
 */
export function findTrigger(messages, config = DEFAULT_CONFIG) {
	if (!Array.isArray(messages)) return null;
	const triggers = Array.isArray(config?.triggers) && config.triggers.length > 0
		? config.triggers
		: DEFAULT_TRIGGERS;
	const needles = [...new Set(triggers
		.filter((item) => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim()))];
	if (needles.length === 0) return null;
	// `iu` 两个标志一起给:大小写折叠交给正则引擎,不做手工 toLowerCase 后对下标
	//(手工折叠在个别字符上会让下标错位,例如 'İ'.toLowerCase() 长度会变),
	//同时 `u` 让中文与 emoji 的匹配语义正确。
	const pattern = new RegExp(needles.map(escapeRegExp).join("|"), "iu");
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		// ① 跳过本插件自己注入的回顾块 —— 纵深防御(可达性论证见函数头)
		if (isPlainObject(message) && typeof message.id === "string" && message.id.startsWith(INJECTED_ID_PREFIX)) continue;
		// ② 只看用户消息:模型自己的输出、工具结果里的触发词都不算
		if (isPlainObject(message) && message.role !== undefined && message.role !== "user") continue;
		const text = messageText(message);
		if (!text) continue;
		const hit = pattern.exec(text);
		if (hit === null) continue;
		const tail = text.slice(hit.index + hit[0].length);
		// ★ 只取触发词之后的**第一行/第一句**(见 `firstSentenceAfter` 的说明:
		//   把后面 500 字符整段当检索词时必然 0 命中)
		const keyword = firstSentenceAfter(tail);
		return { keyword, messageIndex: index, rawTail: keyword };
	}
	return null;
}

/**
 * 同一轮 turn 内只触发一次。按 `agentId#turn` 记忆。
 *
 * ★ 为什么不是"只记最后一个键":多个 agent 在同一轮里交错时
 *   `a#7 → b#7 → a#7`,单槽写法第三次**会再次放行**(同一轮注入两次)。
 *   所以这里记住"已经注入过的键的集合",并且**有界**(FIFO 挤出最旧的)——
 *   这是常驻进程级的对象,不能让它无限增长。
 *   被挤出去的键属于很多轮之前,不可能再出现,所以挤出是安全的。
 *
 * @param options - `{ maxEntries }` 记忆上限,默认 64。
 * @returns `{ shouldInject, reset, lastKey }`。
 */
export function createTurnGuard({ maxEntries = 64 } = {}) {
	const done = new Set();
	const order = [];
	return {
		shouldInject(agentId, turn) {
			const key = `${agentId ?? "?"}#${turn ?? "?"}`;
			if (done.has(key)) return false;     // ★ 这一轮已经注入过(含交错回来的情况)
			done.add(key);
			order.push(key);
			while (order.length > maxEntries) done.delete(order.shift());
			return true;
		},
		reset() { done.clear(); order.length = 0; },
		get lastKey() { return order.length > 0 ? order[order.length - 1] : null; }
	};
}

/**
 * 构造 `searchSessions` 请求。★ 字段名是 `sessionFilters`(复数)。
 *
 * ★ **永远**只带一个 `kind:'id'` 过滤器,值就是当前会话 —— 这个函数里**不存在**
 *   "不加过滤器"的分支:不加过滤器 = 搜全部会话,那正是要禁止的行为。
 *   `sessionId` 由调用点用 `resolveSessionId` 解析、拿不到就 fail closed,所以正常
 *   情况下这里一定是合法 id;万一真传进垃圾值,后端也只会"什么都匹配不到"
 *   (官方过滤器语义:`empty list values match nothing`)—— 依然 fail closed,
 *   而绝不会把范围放开。范围没有"退而求其次"的写法。
 *
 * @param args - 工具参数(★ 只读 `query` / `limit`;绝不读 `args.scope` / `args.sessionIds`)。
 * @param config - 规整后的配置。
 * @param sessionId - 当前会话 id。
 */
export function buildSearchRequest(args, config = DEFAULT_CONFIG, scope = {}) {
	const input = isPlainObject(args) ? args : {};
	const { sessionId, cwd } = isPlainObject(scope) ? scope : {};
	return {
		query: typeof input.query === "string" ? input.query.trim() : "",
		limit: clampInt(input.limit, 1, MAX_LIMIT, config.limit),
		// ★ cwd 已知 ⇒ 当前工作区;cwd 未知 ⇒ 退化到"只查当前会话"(更窄,安全方向)。
		//   两个分支都带过滤器,**没有**"不加过滤器"的写法。
		sessionFilters: typeof cwd === "string" && cwd.length > 0
			? [{ kind: "cwd", values: [cwd] }]
			: [{ kind: "id", values: [sessionId] }]
	};
}

/** 构造 `readEvent` 请求(before/after 已在 MAX_WINDOW 内)。 */
export function buildReadEventRequest(args, config = DEFAULT_CONFIG) {
	const input = isPlainObject(args) ? args : {};
	return {
		sessionId: input.sessionId,
		seq: input.seq,
		before: clampInt(input.before, 0, MAX_WINDOW, config.before),
		after: clampInt(input.after, 0, MAX_WINDOW, config.after)
	};
}

/**
 * epoch ms → **本地**可读时间(`YYYY-MM-DD HH:mm:ss`)。
 *
 * ★ 必须用本地 getter,不能用 `toISOString()`(那是 **UTC**)——
 *   否则"本地时间"会**差 8 小时**。证据:骨架里那条
 *   `--- seq=42 … 2026-01-01 00:00:00` 对应的原始消息自己写着
 *   `Time sampled while preparing turn 1, step 1: 2026-01-01T00:00:00+08:00`。
 *
 * 对一个"回忆前面聊过什么"的功能,时间戳是重要线索 —— UTC 会让"昨天"显示成"前天"。
 *
 * 不带时区后缀:本地时间就是用户与模型共同的参照系;要绝对时间可以看 seq。
 */
export function formatTime(ms) {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "?";
	try {
		const date = new Date(ms);
		const pad = (value) => String(value).padStart(2, "0");
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
			`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	} catch {
		return "?";
	}
}

/** sessionQuery 缺失时的修复指引(要能照着做,不能只说"不可用")。 */
export function renderUnavailable() {
	// ⚠️ 这段会作为工具结果回到模型眼前,首词**绝不能**是任何触发词
	//    (否则等于我们主动往对话里放了一个触发词)。
	return "记忆恢复检索当前不可用:这个组合里没有 `ctx.sessionQuery` 服务。\n" +
		"修法:确认 profile 挂载了官方后端 `@deepseek-ai/dsh-session-query-sqlite`" +
		"(官方 web profile 自带),或用 plugin_manager 把它装进当前 profile," +
		"然后重启 DSH 让服务上线。";
}

/**
 * 渲染 `recall_history` 的正文(交给 publish() 做出口处理)。
 *
 * ★ 排序规则必须**按模式**说,不能一句通吃:部署里全文索引可能被关闭 ⇒
 *   真正跑的可能是扫描路径,而扫描路径的结果是
 *   **time DESC**(第一条就是最近的那次命中)。索引路径才是
 *   match_count DESC → document_length ASC → time DESC → seq DESC。
 *   把索引规则当成唯一规则印在扫描结果上,等于每次都在骗模型
 *   (它会以为第一条"不是最近的",于是挑错会话去钻取)。
 *
 * ★ 还要把**范围**印在正文里(`scopeLine`):范围是安全边界,
 *   模型必须每次都看得见它,而不是靠工具描述里的一句话自觉。
 *
 * @param value - `searchCorpus` 的返回 + `{ query, scope }`。
 */
/**
 * ★ 范围行的文字 —— **单一来源**,两个渲染器都用它。
 *
 * 范围是**当前工作区**(设计决定,不可配置):
 *   · `cwd` 已知 ⇒ `当前工作区 <cwd>`;
 *   · `cwd` 未知 ⇒ `仅当前会话 <id>`,并**明说**是"没拿到工作目录、已收窄" ——
 *     这是比工作区**更窄**的范围,模型有权知道它看到的比别人少。
 *
 * @param scope - `{ sessionId, cwd }`(见 `resolveScope`)。
 * @param sessionId - 兜底用的会话 id(调用方可能只传这个)。
 * @returns 不带 `范围:` 前缀的描述串。
 */
export function scopeText(scope, sessionId) {
	const cwd = typeof scope?.cwd === "string" && scope.cwd.length > 0 ? scope.cwd : undefined;
	if (cwd !== undefined) return `当前工作区 ${cwd}`;
	const id = sessionId ?? scope?.sessionId ?? "?";
	return `仅当前会话 ${id}(未拿到工作目录,已收窄)`;
}

/** 完整的范围行(带 `范围:` 前缀)。 */
function scopeLine(scope, sessionId) {
	return `范围:${scopeText(scope, sessionId)}`;
}

/** 骨架:用户消息保留多少字(建议 80)。 */
export const SKELETON_QUOTE_CHARS = 80;
/** 骨架:工具调用的"目标"保留多少字。 */
export const SKELETON_TOOL_CHARS = 60;
/** 骨架:工具结果的摘要保留多少字(要短 —— 它挤占的是"人都说了什么"的预算)。 */
export const SKELETON_RESULT_CHARS = 40;

/**
 * ★ 把一个 `tool/call` 与它的 `tool/result` 配对。
 *
 * **只能用相邻配对**:官方 `filterEvents` 返回的文档字段只有
 * `{sessionId, seq, type, time, surface, text}`,**没有 callId**
 * (建文档的逻辑在官方 `@deepseek-ai/dsh-session-query` 的
 * `buildSessionEventSearchDocuments` 里)。原始事件上虽然有 `sourceEventSeqs`,
 * 但它不进文档,只能靠 `readEvent`/`traceEvent` 取,而两者**都会整档重放**整条日志。
 *
 * ⚠️ **已知上限**:同一 step 里并发执行的工具调用可能让"后一个 result"错配到"前一个 call"。
 *   这是本方案的固有误差,故渲染用**中性措辞**("结果 seq=…:摘要"),**不声称成功/失败**。
 *
 * @param docs - 按 seq 升序的文档。
 * @returns `Map<callSeq, resultDoc>`。
 */
export function pairToolResults(docs) {
	const pairs = new Map();
	for (let index = 0; index < docs.length; index += 1) {
		if (docs[index]?.type !== "tool/call") continue;
		const next = docs[index + 1];
		if (next?.type === "tool/result") pairs.set(docs[index].seq, next);
	}
	return pairs;
}

/**
 * ★ 前缀命中即排除:这些是 **DSH 自己注入**的消息 —— 它们在会话日志里的 `role` **也是 `user`**,
 *   所以光看 role 分不出"这句话是不是人说的"。
 *
 * 骨架里可能混进 `This is an automatically generated checkpoint …`、
 * `background job pwsh-0000 (…)`、`<goal_round> Objective: …`、`Team message … from …`、
 * `Background subagent … finished and will do no further work` —— **没有一条是人说的**。
 *
 * ⚠️ 匹配**大小写不敏感**:宿主会给出 `background job`(小写)形态。
 */
export const INJECTED_PREFIXES = [
	"Time sampled",
	"Current runtime context",
	"Elapsed since the preceding",
	"Current DSH file policy",
	"Background subagent",
	"Background job",
	"Team message",
	"automatically generated checkpoint",     // 覆盖 "This is an automatically generated checkpoint…"
	"this is an automatically generated checkpoint",
	"<goal_round>",
	"Agent Teams",
	"You are "                                 // 子智能体的任务书基本都以它开头
];

/**
 * ★ 特征块:**出现 ≥2 个**才判为注入 —— 兜住"不以上面任何前缀开头"的注入正文。
 *
 * ⚠️ **这里故意只留"绝不出现在正常对话里"的技术标记**。`subagent` / `checkpoint` /
 *   `compaction` / `tool call` 这几类词**没有**采用:真实对话里讨论这些词时,
 *   按"≥2 个即排除"会把**真话**判成"不是人说的",而它恰恰是最需要出现在骨架里的。
 *   代价是这几类词不设防 —— 但注入正文通常以上面的前缀开头(已覆盖)。
 */
export const INJECTED_FEATURES = [
	"DSH file policy",
	"approval policy",
	"spawn_teammate",
	"team_task_",
	"contextWindow",
	"automatically generated checkpoint"
];

/**
 * ★ 前缀之外还需要正则的:这些注入消息**不以固定词开头**(id / 取值都是变的)。
 *
 *   · 子智能体消息:`Agent <id> sent a message: …`
 *   · **策略变更通知**:`The approval policy changed from "ask" to "<新策略>".`
 *     (还有别的形态)
 *
 * ⚠️ 策略那条**要求"声明式"结构**(`policy:` / `policy changed from|to` / `policy is now`),
 *   否则 `The approval policy is wrong, fix it` 这种**真人话**会被误杀 ——
 *   本项目里讨论策略的话极常见,所以必须收窄。
 */
export const INJECTED_PATTERNS = [
	/^agent\s+\S{1,80}\s+sent a message\s*:/iu,
	/^agent\s+\S{1,80}\s+finished and will do no further work/iu,
	/^(?:the\s+)?(?:approval|file|sandbox|permission)\s+polic(?:y|ies)\s*(?::|changed\s+(?:from|to)|is now|now\b)/iu
];

/**
 * 这条消息**是不是人说的**?返回 `true` = 判为 DSH 注入的噪声(不进骨架)。
 *
 * ⚠️ **不要按长度判**:实测上 `?` 这种极短消息**是真的**(用户就问了一个问号),必须保留。
 *   所以这里只做三件事:前缀命中、正则命中、特征块命中 ≥2。
 */
export function isInjectedMessage(text) {
	const trimmed = String(text ?? "").trimStart();
	if (trimmed.length === 0) return true;
	const lower = trimmed.toLowerCase();
	if (INJECTED_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase()))) return true;
	if (INJECTED_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
	let hits = 0;
	for (const feature of INJECTED_FEATURES) {
		if (lower.includes(feature.toLowerCase())) hits += 1;
		if (hits >= 2) return true;
	}
	return false;
}

/** 语义别名:注入消息过滤(保留该导出名供调用方使用)。 */
export const isRuntimeNoise = isInjectedMessage;

/** 压成单行、去掉多余空白。 */
function oneLine(text) {
	return String(text ?? "").replace(/\s+/gu, " ").trim();
}

/**
 * 把一条事件压成**骨架**里的一行;返回 `null` 表示这类事件不进骨架。
 *
 * 为什么要骨架而不是"前 N 字符":回顾块可能达到**数 MB**,而发布预算只有 3000 字符
 * (`…[已截断:原文 N 字符,本次只发布前 M 字符]`)—— 于是**永远只看得到开头**,
 * 中间和后面全丢。而"回忆前面聊过什么"要的是**全貌**:谁说过什么、调过什么工具、
 * 大概在什么时候。原文仍然随时可以用 `recall_expand({seq})` 展开,所以骨架不需要正文。
 *
 * @param doc - `{ seq, type, time, surface, text }`。
 * @param redaction - 可选的本次召回脱敏计数器。
 * @returns `{ kind, seq, time, line, quote }` 或 `null`。
 */
export function skeletonEntry(doc, resultDoc = undefined, redaction = undefined) {
	const raw = String(doc?.text ?? "");
	if (raw.length === 0 || isInjectedMessage(raw)) return null;
	// 先处理完整事件,再压白/取首行/截断,否则可能切掉 URL 的 @ 或私钥 END。
	const clean = (input) => redaction ? redaction.text(input) : redact(input).text;
	const text = clean(raw);
	const seq = doc?.seq ?? "?";
	const stamp = formatTime(doc?.time);
	const type = String(doc?.type ?? "");
	if (type === "user/message") {
		const quote = oneLine(text).slice(0, SKELETON_QUOTE_CHARS);
		return { kind: "user", seq, time: doc?.time, quote, line: `seq=${seq} ${stamp} 用户:${quote}` };
	}
	if (type === "tool/call") {
		// 宿主给的可读文本形如 `read\n{"file_path":"…"}` 或 `recall_history {"limit":3}`。
		// 骨架只要"工具名 + 目标",不要正文。
		const flat = oneLine(text);
		const brace = flat.indexOf("{");
		const name = (brace >= 0 ? flat.slice(0, brace) : flat).trim() || "?";
		const target = (brace >= 0 ? flat.slice(brace) : "").slice(0, SKELETON_TOOL_CHARS);
		const quote = target ? `${name} ${target}` : name;
		// ★ 附上这次调用的**结果**:只写"工具 + 参数"看不出这一步产生了什么。
		//   配对只能靠**相邻**(call 之后紧跟的 tool/result):官方文档字段只有
		//   `{sessionId, seq, type, time, surface, text}`,**没有 callId**。
		//   ⚠️ 并发工具调用下可能错配 —— 已知上限,写入注释与 README。
		//   ⚠️ **不判"成功/失败"**:文档里没有可靠的成败标志,`tool/result` 的文本只是
		//   `正文 + error.name + error.code` ⇒ 声称成败会是**不诚实的**。
		//   只给结果摘要;失败时错误名/码天然会出现在摘要里。
		const outcome = resultDoc
			? ` → 结果 seq=${resultDoc.seq ?? "?"}: ${oneLine(clean(resultDoc.text)).slice(0, SKELETON_RESULT_CHARS)}`
			: " → (无结果)";
		return { kind: "tool", seq, time: doc?.time, quote, line: `seq=${seq} ${stamp} 工具:${quote}${outcome}` };
	}	if (type === "assistant/message") {
		// 只取第一行(助手的长文展开对"全貌"没有价值;`[思考]` 也一样)
		const first = String(text).split(/\r?\n/u).find((line) => line.trim().length > 0) ?? "";
		const quote = oneLine(first).slice(0, SKELETON_QUOTE_CHARS);
		return { kind: "assistant", seq, time: doc?.time, quote, line: `seq=${seq} ${stamp} 助手:${quote}` };
	}
	// tool/result 等:正文巨大且对"全貌"无贡献 ⇒ 不进骨架
	return null;
}

/**
 * 把骨架折到预算之内(**折叠而不是截断**)。
 *
 * ① 逐条一行;放得下就用它(传入的条目全部能逐条放下)。
 * ② 放不下 ⇒ **按「用户消息」分段**:每段给出"用户说了什么 + 这段里的工具调用摘要"。
 *    ★ 为什么不是"每 N 条一组":按事件数分桶会产出大量**没有用户消息的空桶**
 *      (形如 `--- seq 22..24 · 3 条` 刷二十几行),既烧预算又不提供信息。
 *      以用户消息为锚点分段,才是"谁在什么时候说了什么"的骨架。
 * ③ 还放不下 ⇒ 只保留用户消息行(丢掉工具摘要)。
 * ④ 仍放不下 ⇒ **等距抽样**用户消息行(写明抽样比),区间首末另有锚点行兜底
 *    (只有全量覆盖时才称"区间首/末";触界时称"本次已展开的",尾锚点不保证)。
 */
export function foldSkeleton(entries, budget, excludeSeqs = new Set()) {
	// ★ 去重:区间首末的锚点已经在正文**之前**印过了(见 renderCompactedBody),
	//   所以正文里不重复它们(同一个 seq 只出现一次:锚点或抽样列表)。
	const kept = entries.filter((entry) => !excludeSeqs.has(entry.seq));
	const perEntry = kept.map((entry) => entry.line);
	if (perEntry.join("\n").length <= budget) return { level: 1, lines: perEntry };

	// 按用户消息分段(工具调用归到它前面那一段)
	const groups = [];
	let current = null;
	for (const entry of kept) {
		if (entry.kind === "user") {
			current = { user: entry, tools: [] };
			groups.push(current);
		} else if (entry.kind === "tool") {
			if (current === null) { current = { user: null, tools: [] }; groups.push(current); }
			current.tools.push(entry);
		}
		// 助手长文在折叠层不进摘要:信息密度最低、最占地方
	}
	const render = (withTools) => groups.flatMap((group) => {
		const lines = [];
		if (group.user) lines.push(`--- seq ${group.user.seq} · ${formatTime(group.user.time)} 用户:${group.user.quote}`);
		if (withTools && group.tools.length > 0) {
			const names = [...new Set(group.tools.map((tool) => tool.quote.split(" ")[0]))];
			lines.push(`    ${group.tools.length} 次工具调用:${names.slice(0, 6).join("、")}${names.length > 6 ? " …" : ""}`);
		}
		return lines;
	});
	const withTools = render(true);
	if (withTools.join("\n").length <= budget) return { level: 2, lines: withTools };
	const usersOnly = render(false);
	if (usersOnly.join("\n").length <= budget) return { level: 3, lines: usersOnly };
	const total = usersOnly.join("\n").length;
	const step = Math.max(2, Math.ceil(total / budget));
	const sampled = usersOnly.filter((_line, index) => index % step === 0);
	return {
		level: 4,
		sampled: step,
		// ★ 不额外补 slice(0,4)/slice(-2):那会和抽样结果**重复同一个 seq**。
		//   首末锚点已印在正文之前;但只有全量覆盖区间时它们才代表真实区间端点,
		//   触界时正文会改称"本次已展开的"(见 composeCompactedBody)。
		lines: [`（用户消息过多,以下每 ${step} 条取 1 条;首末消息锚点见上面)`, ...sampled]
	};
}

/**
 * ★★ 渲染"被 compaction 挤掉的部分"的正文(无关键词模式)。
 *
 * 必须写清三件事:① 范围;② **分类计数**(可见 / 被挤掉可恢复 / 不在表层),
 * 让模型知道"你看的是哪一段、总共还有多少";③ 若一条都没有 ⇒ **如实说**,不编造。
 *
 * ★ 呈现方式是**骨架 + 折叠**,不是"取前 N 字符":回顾块可能达到数 MB,
 *   截断成前几千字符等于只给你开头。全量覆盖时骨架覆盖**整个区间**;
 *   触到条数/字符/取消上界时只覆盖**本次已展开的候选**,正文会如实标注。
 *
 * ★★ 两条渲染通道,**同一套输出**:
 *   · `renderCompactedBody(value)` —— 同步(纯函数层 API,测试与同步调用直接使用);
 *   · `renderCompactedBodyAsync(value, { budget })` —— 异步,每 `COMPACT_YIELD_EVERY`
 *     篇让出一拍,并带上调用方的**时间预算 + 硬取消**。接线层用后者。
 *   两者都受**确定性条数/源字符上界**约束(`COMPACT_MAX_DOCS` / `COMPACT_MAX_SOURCE_CHARS`):
 *   时间预算单独不够 —— 一次脱敏不可中断,单篇 1 MB 就能吃掉整份预算。
 *   ⚠️ 同步导出的上界只是"被准入渲染的条数/字符数";它仍会同步 `filter` / `sort` /
 *   工具配对调用方传入的整个 `docs` 数组(只读元数据与长度),这部分成本不计入字符上界,
 *   也不能取消/让出 —— 生产路径必须用异步入口。
 *   ⚠️ 触到上界时会**额外尝试**补读区间末尾 `COMPACT_TAIL_WINDOW` 篇,但它仍受源字符
 *   上限约束,是尽力而为:只有全量覆盖区间时才写"区间首/末条",否则只写"本次已展开的"。
 *
 * @param value - `{ sessionId, scope, docs, counts, others, budget }`(见 index.js 的 `buildCompactedBody`)。
 */
export function renderCompactedBody(value) {
	const removed = shadowedDocs(value);
	// ★ 确定性上界**永远生效**(不只是有调用方预算时):这正是"只有时间预算不够"的补丁。
	const budget = createBudget({
		maxDocs: COMPACT_MAX_DOCS,
		maxSourceChars: COMPACT_MAX_SOURCE_CHARS,
		label: "compacted"
	});
	const plan = collectCompactedEntries(removed, value?.redaction, budget);
	return composeCompactedBody(value, removed, plan, budget);
}

/**
 * `renderCompactedBody` 的异步版本(接线层用)。
 *
 * @param value - 同上。
 * @param options - `{ budget?, yieldEvery? }`。`budget` 由调用方创建(带 deadline + signal);
 *                  不传时退回"只有确定性上界"的本地预算(测试用)。
 */
export async function renderCompactedBodyAsync(value, options = {}) {
	const removed = shadowedDocs(value);
	const budget = options?.budget ?? createBudget({
		maxDocs: COMPACT_MAX_DOCS,
		maxSourceChars: COMPACT_MAX_SOURCE_CHARS,
		label: "compacted"
	});
	const plan = await collectCompactedEntriesAsync(
		removed,
		value?.redaction,
		budget,
		options?.yieldEvery ?? COMPACT_YIELD_EVERY
	);
	return composeCompactedBody(value, removed, plan, budget);
}

/** 只取 `surface === "shadowed"` 的文档 —— 那才是"已经不在可见表面上"的。 */
function shadowedDocs(value) {
	return (Array.isArray(value?.docs) ? value.docs : []).filter((doc) => doc.surface === "shadowed");
}

/** 进骨架的事件类型。 */
const SKELETON_DOC_TYPES = Object.freeze(["user/message", "assistant/message", "tool/call"]);

/**
 * 排出"要处理哪些候选事件"的确定性计划:前缀尽量多,触界后**尝试**补末尾窗口。
 *
 * 为什么是"前缀 + 末尾窗口"而不是"纯前缀":纯前缀会让区间末条用户消息消失。
 * 但末尾窗口只是**尽力而为** —— 它越过条数上限(`ignoreDocCap`)却仍受源字符
 * 上限约束,前缀把字符额度用尽时尾部一条也进不来。因此这里**不保证**尾锚点,
 * 渲染层必须按真实覆盖情况措辞(见 `composeCompactedBody` 的 `fullRange`)。
 * 末尾窗口固定 64 条,不随会话规模增长 ⇒ 仍然是确定性上界。
 *
 * ⚠️ 这里只做**计数准入**(原文长度),不读也不裁切正文 —— 于是不存在
 *    "先截断再脱敏";被跳过的文档整条不处理,绝不留未扫描的头尾。
 *
 * ⚠️ `filter` / `sort` / `pairToolResults` 仍同步遍历整个 `removed` 数组
 *    (只读元数据与长度),其成本不计入源字符上界;这是"确定性上界"而不是
 *    "全路径 CPU 硬上限"。
 *
 * @returns `{ candidates, indices, total, processed, capped, stoppedBy }`。
 */
function planCompactedEntries(removed, budget) {
	const candidates = removed.filter((doc) => SKELETON_DOC_TYPES.includes(doc.type));
	// ★ 工具调用的**配对结果正文**同样会被完整脱敏(见 skeletonEntry 的 40 字摘录),
	//   所以它也必须计入源字符上界 —— 否则"5000 条小 call + 5000 条 1 MB result"
	//   就能绕过字符上界,把一次召回拖成几个 GB 的扫描。
	const pairs = pairToolResults(removed);
	const costOf = (doc) => {
		const own = typeof doc?.text === "string" ? doc.text.length : 0;
		const paired = doc?.type === "tool/call" ? pairs.get(doc.seq) : undefined;
		const extra = typeof paired?.text === "string" ? paired.text.length : 0;
		return { own, extra };
	};
	const indices = [];
	let capped = false;
	for (let index = 0; index < candidates.length; index += 1) {
		// ★ 取消/时间到期/已封存 ⇒ **优雅收尾**(不抛):已经排好的条目照常渲染,
		//   并在正文里如实标注"只展开了一部分"。抛错会连已算好的部分结果一起丢掉。
		if (budget.shouldStop()) {
			capped = true;
			break;
		}
		const { own, extra } = costOf(candidates[index]);
		if (!budget.admit(own, { extraChars: extra })) {
			capped = true;
			break;
		}
		indices.push(index);
	}
	if (capped && indices.length < candidates.length) {
		// ★ 末尾窗口:**固定 64 条**,尽力兜住"区间末条用户消息"。
		//   它越过条数上限(`ignoreDocCap`),但**仍受源字符上限**约束 —— 前缀已经
		//   用尽额度时这里会全部 admit 失败。这不是 bug:不为保锚点无条件越过源
		//   字符限;渲染层据 `processed/total` 决定能否称"区间末条"。
		const from = Math.max(indices.length, candidates.length - COMPACT_TAIL_WINDOW);
		const taken = new Set(indices);
		const tail = [];
		for (let index = candidates.length - 1; index >= from; index -= 1) {
			if (budget.shouldStop()) break;
			if (taken.has(index)) continue;
			const { own, extra } = costOf(candidates[index]);
			if (!budget.admit(own, { ignoreDocCap: true, extraChars: extra })) break;
			tail.push(index);
		}
		tail.sort((a, b) => a - b);
		indices.push(...tail);
	}
	indices.sort((a, b) => a - b);
	return {
		candidates,
		pairs,
		indices,
		total: candidates.length,
		processed: indices.length,
		capped: capped && indices.length < candidates.length,
		stoppedBy: budget.stats().stoppedBy ?? budget.stopReason()
	};
}

/** 同步收集骨架条目。 */
function collectCompactedEntries(removed, redaction, budget) {
	const plan = planCompactedEntries(removed, budget);
	const entries = [];
	for (const index of plan.indices) {
		const doc = plan.candidates[index];
		const entry = skeletonEntry(doc, plan.pairs.get(doc.seq), redaction);
		if (entry) entries.push(entry);
	}
	return { ...plan, entries };
}

/** 异步收集:每 `yieldEvery` 篇让出一拍(让出只拦"已封存",取消由计划层收尾)。 */
async function collectCompactedEntriesAsync(removed, redaction, budget, yieldEvery) {
	const plan = planCompactedEntries(removed, budget);
	const entries = [];
	let sinceYield = 0;
	let processed = 0;
	for (const index of plan.indices) {
		// ★ 让出之后可能已被取消/已到期:这时**停止继续展开**,并把真实进度写回计划,
		//   让正文如实标注"只展开到哪一条"(不抛错,已算好的条目照常返回)。
		const stop = budget.shouldStop();
		if (stop) {
			plan.capped = true;
			plan.stoppedBy = plan.stoppedBy ?? stop;
			plan.processed = processed;
			break;
		}
		const doc = plan.candidates[index];
		const entry = skeletonEntry(doc, plan.pairs.get(doc.seq), redaction);
		if (entry) entries.push(entry);
		processed += 1;
		sinceYield += 1;
		if (sinceYield >= yieldEvery) {
			sinceYield = 0;
			await budget.yieldNow();
		}
	}
	return { ...plan, entries };
}

/** 组装正文(同步/异步两条通道共用,保证输出逐字一致)。 */
function composeCompactedBody(value, removed, plan, budget) {
	const scope = value?.scope;
	const target = typeof value?.sessionId === "string" && value.sessionId.length > 0
		? value.sessionId
		: (scope?.sessionId ?? "?");
	const counts = value?.counts ?? {};
	const lines = [];
	lines.push("模式:被 compaction 挤掉的部分(该会话已不在模型可见表面上的事件)");
	lines.push(`会话 ${target}`);
	lines.push(scopeLine(scope, scope?.sessionId));
	lines.push(`事件分类(本次扫描到的有文本事件):可见 ${counts.current ?? 0} 条 / ` +
		`被挤掉可恢复 ${counts.shadowed ?? 0} 条 / 不在表层(log-only)${counts["log-only"] ?? 0} 条`);
	if (removed.length === 0) {
		lines.push("");
		lines.push("（**该会话没有被压缩掉的内容** —— 没有「丢失的东西」可恢复。" +
			"这不等于会话里没有更早的事件:更早的仍然在「当前可见表面」上。)");
		const others = Array.isArray(value?.others) ? value.others : [];
		if (others.length > 0) {
			lines.push("");
			lines.push(`本工作区里另有 ${others.length} 个会话(**来源不同,单独列出**;要看哪个就指定它):`);
			others.forEach((record, index) => {
				lines.push(`${index + 1}. session=${record.sessionId ?? "?"} · ${formatTime(record.createdAt)}`);
				lines.push(`   看它被压缩掉的内容:recall_expand({ sessionId: "${record.sessionId}" })`);
			});
		}
		return lines.join("\n");
	}

	const entries = plan.entries;
	const firstSeq = removed[0]?.seq ?? "?";
	const lastSeq = removed[removed.length - 1]?.seq ?? "?";
	const users = entries.filter((entry) => entry.kind === "user");
	lines.push(`区间:seq ${firstSeq}..${lastSeq}(${removed.length} 条被挤掉的事件)`);
	// ★ 触到确定性上界/时间预算/取消 ⇒ **必须**如实写出来:否则"没看到的中间段"
	//   会被读成"没有"。
	if (plan.capped) {
		const limits = budget?.limits?.() ?? { maxDocs: COMPACT_MAX_DOCS, maxSourceChars: COMPACT_MAX_SOURCE_CHARS };
		const why = plan.stoppedBy === "time" ? "时间预算"
			: plan.stoppedBy === "signal" ? "本轮已取消"
				: plan.stoppedBy === "sealed" ? "本轮已结束"
					: plan.stoppedBy === "docs" ? `${limits.maxDocs} 条上限`
						: plan.stoppedBy === "chars" ? `${limits.maxSourceChars} 源字符上限`
							: "确定性上限";
		lines.push(`⚠ 本次只展开了区间内 ${plan.processed}/${plan.total} 条候选事件` +
			`(其余 ${plan.total - plan.processed} 条未展开;原因:${why})。` +
			"这些条目仍可用 recall_expand({ seq }) 逐条展开。");
	}
	// ★ 骨架只收 user / assistant / tool-call;若被挤掉的全是 tool/result 或宿主注入文本,
	//   entries 会为空。此时必须**如实说明并给出 seq**,而不是输出一个空骨架(已知边界)。
	const describeRemoved = (max = 12) => {
		const sample = removed.slice(0, max);
		const list = sample.map((doc) => `seq=${doc.seq ?? "?"} · ${formatTime(doc.time)} · ${doc.type ?? "?"}`);
		if (removed.length > sample.length) list.push(`…(共 ${removed.length} 条,只列前 ${max} 条)`);
		return list;
	};
	if (entries.length === 0) {
		lines.push("");
		if (plan.capped) {
			// 预算/上限在下第一刀之前就用尽(例如预取消、或单篇就超字符上界):
			// 不能谎称"这些事件里没有可进入骨架的文本"。
			lines.push("（本次**没有**展开任何骨架条目 —— 预算或确定性上限在开始前就用尽。" +
				"下面是这段区间的 seq,可用 recall_expand({ seq }) 展开任意一条。）");
		} else {
			lines.push(`（这 ${removed.length} 条被挤掉的事件里没有可进入骨架的文本:它们都是工具结果或宿主注入消息。` +
				"下面是这段区间的 seq,可用 recall_expand({ seq }) 展开任意一条。）");
		}
		lines.push(...describeRemoved());
		return lines.join("\n");
	}
	// ★ 全貌的两个锚点**放在正文之前**:发布截断时它们优先保留。
	//   正文里用 `anchorSeqs` 把它们排除掉,保证**同一个 seq 只出现一次**。
	// ★ 区间覆盖:只有**全量覆盖**区间时才能称"区间首/末条"。部分展开(条数/字符/取消触界)
	//   时末条锚点可能根本没进来(末尾窗口仍受源字符上限约束),必须降级成
	//   "本次已展开的",否则正文会把 seq 11 说成区间末条、而真实区间到 seq 15。
	const fullRange = plan.processed >= plan.total;
	const anchorLabel = fullRange ? "区间" : "本次已展开的";
	const anchorSeqs = new Set();
	if (users.length > 0) {
		lines.push(`★ ${anchorLabel}首条用户消息 seq=${users[0].seq}: ${users[0].quote}`);
		anchorSeqs.add(users[0].seq);
		const lastUser = users[users.length - 1];
		if (lastUser.seq !== users[0].seq) {
			lines.push(`★ ${anchorLabel}末条用户消息 seq=${lastUser.seq}: ${lastUser.quote}`);
			anchorSeqs.add(lastUser.seq);
		}
	}
	lines.push("");
	const budgetChars = Math.max(400, (typeof value?.budget === "number" ? value.budget : 3000) - 900);
	const folded = foldSkeleton(entries, budgetChars, anchorSeqs);
	// ★ 条目全被首末锚点排除(例如区间只有一条用户消息)时,folded.lines 会是空的 ——
	//   同样不能输出空骨架,给说明 + seq 列表兜底。
	if (folded.lines.length === 0) {
		lines.push("");
		lines.push("（骨架条目都被上面的首末用户消息锚点覆盖了;原文可用 recall_expand({ seq }) 展开:）");
		lines.push(...describeRemoved());
		return lines.join("\n");
	}
	const label = folded.level === 1
		? (fullRange
			? "以下是**骨架**(覆盖上面整个区间;每行一条,原文用 recall_expand({ seq }) 展开):"
			: "以下是**骨架**(只覆盖上面已展开的这部分候选;未展开的条目不在其中,原文用 recall_expand({ seq }) 展开):")
		: folded.level === 2
			? "以下是**骨架**(按用户消息分段,每段附该段的工具调用摘要;助手长文已略 —— 要用 recall_expand({ seq }) 展开):"
			: folded.level === 3
				? "以下是**骨架**(只列用户消息,工具摘要已省略;原文用 recall_expand({ seq }) 展开):"
				: "以下是**抽样骨架**(用户消息过多,已等距抽样):";
	lines.push(label);
	lines.push("");
	lines.push(...folded.lines);
	return lines.join("\n");
}

export function renderHistoryBody(value) {
	const lines = [];
	const modeText = value.mode === "index" ? "索引命中"
		: value.mode === "scan" ? "索引无果 → 扫描兜底"
			: value.mode === "aborted" ? "本轮已中止"
				: "检索";
	lines.push(`模式:${modeText}`);
	// ★ 范围必须**写在正文里**:模型不会去读工具描述里的那段话,更不会读插件源码。
	//   少了这一行,"当前工作区"就只是实现细节,而不是它看得见的事实。
	lines.push(`范围:${scopeText(value.scope, value.sessionId)}`);
	if (value.query) lines.push(`查询:「${value.query}」`);
	// ★ 候选数与已检查数分开说:模型据此判断"没命中"是不是因为"还没查完"。
	//   `inspected` 在两条检索路径上都必须是**会话数**(索引路径按 sessionId 去重)。
	const candidateTotal = typeof value.candidates === "number" && value.candidates > 0 ? value.candidates : 0;
	const inspected = typeof value.inspected === "number" && value.inspected > 0 ? value.inspected : 0;
	const candidateText = candidateTotal === 0 ? ""
		: (candidateTotal > inspected ? ` / 共 ${candidateTotal} 个候选` : " / 候选已全部检查");
	// ★ `inspected === 0` 时也必须把候选数说出来(预算一开始就用尽 ⇒ 一个会话都没查,
	//   这时"没命中"绝不能和"确实没有"混为一谈)。
	const checkedText = inspected > 0
		? (value.mode === "index"
			? `索引命中涉及 ${inspected} 个会话`
			: `检查了 ${inspected} 个会话${candidateText}`)
		: (candidateTotal > 0 ? `未检查任何会话 / 共 ${candidateTotal} 个候选` : "");
	// ★ 未完成检索:零命中只有在**范围内确实检查完**时才能说成"没有"。中止、截断、预算
	//   用尽或还有候选未检查时,零命中只是"本轮没看到" —— 不能冒充完整结论。
	const incomplete = value.incomplete === true
		|| value.mode === "aborted"
		|| value.truncatedWindow === true
		|| value.truncatedReason !== undefined
		|| (candidateTotal > 0 && inspected < candidateTotal)
		|| value.stoppedAtLimit === true;
	const zeroHitNote = value.hits.length === 0 && incomplete ? "(本轮未完成,零命中不等于范围内没有)" : "";
	lines.push(`命中 ${value.hits.length} 条${checkedText ? `(${checkedText})` : ""}${zeroHitNote}`);
	if (value.degraded) lines.push(`⚠ 降级:${value.degraded}`);
	if (value.error) lines.push(`⚠ 官方服务报错(已降级继续):${value.error}`);
	if (value.truncatedWindow) {
		lines.push(value.truncatedReason === "abort"
			? "⚠ 本轮已中止(Signal 被取消),只返回中止前已经拿到的结果 —— 结果不完整"
			: value.truncatedReason === "budget"
				? "⚠ 扫描时间预算已用尽,结果可能不全(还有会话没检查)"
				: "⚠ 候选窗口已用尽,结果可能不全(还有更多会话没检查)");
	}
	// ★ 提前停手是**正常收尾**(已经拿够 limit 条),不能说成"结果不全";
	//   但没检查的会话必须让模型知道,否则它会把"没查完"读成"更早的没有"。
	if (value.stoppedAtLimit === true) {
		const remaining = candidateTotal > inspected
			? `(共 ${candidateTotal} 个候选,按创建时间较早的 ${candidateTotal - inspected} 个未检查)`
			: "(更早的会话未检查)";
		const order = value.currentSessionMissing === true ? "按创建时间从新到旧" : "按「当前会话优先、其余从新到旧」";
		lines.push(`ℹ 返回条数已达上限:已${order}检查了 ${inspected} 个会话${remaining};` +
			"要查更早的内容,请换更具体的关键词。");
	}
	lines.push("");
	value.hits.forEach((hit, index) => {
		const bits = [
			`${index + 1}. session=${hit.sessionId ?? "?"}`,
			hit.seq === null || hit.seq === undefined ? "seq=(无)" : `seq=${hit.seq}`,
			formatTime(hit.time),
			hit.type ?? "?",
			hit.live ? "live" : (hit.persisted ? "persisted" : "?")
		];
		lines.push(bits.join(" · "));
		if (hit.snippet) lines.push(`   ${hit.snippet.replaceAll("\n", " ")}`);
	});
	if (value.hits.length === 0) {
		if (incomplete) {
			const why = value.mode === "aborted" ? "本轮已中止"
				: value.truncatedReason === "budget" ? "扫描预算已用尽"
					: value.truncatedReason === "window" ? "候选窗口已用尽"
						: value.stoppedAtLimit === true ? "已提前停手"
							: "本轮未完成";
			lines.push(`(⚠ ${why}:已检查的范围内没有命中的片段 —— **这不等于整个范围没有命中**,` +
				"也不是完整的零命中结论。范围见上面的「范围」行;可缩小关键词或稍后重试。)");
		} else {
			lines.push("(本次范围内没有命中的片段 —— 范围见上面的「范围」行。换个关键词再试。)");
		}
	}
	lines.push("");
	// ★ 一句通吃的排序说明在这里是**错**的:见函数头。两种模式各说各的真相。
	if (value.mode === "index") {
		lines.push("排序规则:match_count DESC → document_length ASC → time DESC → seq DESC" +
			"(**不是按时间**;命中词多、文档短的排前面)。");
	} else if (value.mode !== "aborted") {
		// ★ 提前停手 / 预算耗尽 / 候选窗口用尽时,"第一条就是最近的"只对**已检查的
		//   会话**成立,不能说满(预算与窗口都会让后面更近的会话没被看过)。
		const partialScan = value.stoppedAtLimit === true || value.truncatedWindow === true;
		lines.push(partialScan
			? "排序规则:在已检查的会话中按时间倒序(★**就是按时间**;每个会话只取最近的一条命中,第一条是已检查范围内最近的)。"
			: "排序规则:按时间倒序(★**就是按时间**;每个会话只取最近的一条命中,第一条就是最近的)。");
	}
	// ★ 范围是**工作区**:别的同工作区会话命中的 seq 也可以直接钻取
	//   (只要 sessionId 仍在本工作区内)。
	lines.push("要看原文就用 recall_expand({ seq });若该命中来自别的会话,再带上它的 sessionId" +
		"(sessionId 可省略=当前会话;**必须落在上面的范围内**,否则会被拒绝)。");
	return lines.join("\n");
}

/**
 * 渲染 `recall_expand` 的正文(也用于"没关键词 → 当前会话被 compaction 挤掉的部分")。
 * @param value - `expandAt` / `expandTail` 的返回。
 */
export function renderExpandBody(value) {
	const lines = expandHeaderLines(value);
	let used = 0;
	let omitted = 0;
	for (const event of value.events) {
		// ★ 确定性上界:窗口条数已由 MAX_WINDOW 限住,但单条正文可以很大 ⇒ 再限**源字符**。
		//   超界时**整条跳过**(不裁切原文:裁切必须发生在脱敏之后,见 safeSnippet/publish)。
		const raw = typeof event.text === "string" ? event.text.length : 0;
		if (used + raw > EXPAND_MAX_SOURCE_CHARS) {
			omitted += 1;
			continue;
		}
		used += raw;
		pushExpandEvent(lines, value, event);
	}
	if (omitted > 0) lines.push(expandOmittedNotice(omitted));
	return lines.join("\n");
}

/**
 * `renderExpandBody` 的异步版本(接线层用)。
 *
 * **窗口内每条都完整展开**(无源字符上界跳过、无预算停止)时与同步版逐字一致;额外做两件事:
 *   ① 每 `EXPAND_YIELD_EVERY` 条让出一次事件循环;
 *   ② 每一条**脱敏之前**检查调用方预算的取消/时间/封存;触界时停止继续展开
 *      (优雅收尾,不抛掉已算好的部分),并在正文里写明只展开到第几条 ——
 *      绝不把部分窗口伪装成完整窗口。
 *
 * 源字符上界(`EXPAND_MAX_SOURCE_CHARS`)始终独立生效,超界整条跳过,
 * 绝不在脱敏前裁切原文。同步导出面向纯函数与同步调用;它只有确定性上界,
 * 没有 deadline/取消,也不会让出。
 *
 * @param value - 同上。
 * @param options - `{ budget?, yieldEvery? }`。`budget` 由调用方创建(带 deadline + signal);
 *                  不传时退回只有确定性上界的本地预算(测试用)。
 */
export async function renderExpandBodyAsync(value, options = {}) {
	const budget = options?.budget ?? createBudget({ label: "expand" });
	const yieldEvery = Number.isInteger(options?.yieldEvery) && options.yieldEvery > 0
		? options.yieldEvery
		: EXPAND_YIELD_EVERY;
	const events = Array.isArray(value?.events) ? value.events : [];
	const header = expandHeaderLines(value);
	const lines = [...header];
	let used = 0;
	let omitted = 0;
	let processed = 0;
	let sinceYield = 0;
	let stoppedBy;
	for (let index = 0; index < events.length; index += 1) {
		const stop = budget.shouldStop?.();
		if (stop !== undefined) {
			stoppedBy = stop;
			break;
		}
		const event = events[index];
		const raw = typeof event?.text === "string" ? event.text.length : 0;
		if (used + raw > EXPAND_MAX_SOURCE_CHARS) {
			omitted += 1;
			continue;
		}
		used += raw;
		// ★ 硬取消/封存 ⇒ 抛错,而且抛在脱敏之前:不会产出任何半条历史文本。
		budget.check?.();
		pushExpandEvent(lines, value, event);
		processed += 1;
		sinceYield += 1;
		if (sinceYield >= yieldEvery && index + 1 < events.length) {
			sinceYield = 0;
			await budget.yieldNow?.();
		}
	}
	// ★ 部分结果标注放在**正文之前**(头部之后):否则发布预算截断时,末尾的
	//   "只展开了前 N 条"会和正文一起被切掉,模型只看到"已截断"而不知道是取消。
	const notices = [];
	if (stoppedBy !== undefined) {
		const remaining = events.length - processed - omitted;
		notices.push(`⚠ ${expandStopReasonText(stoppedBy)}:只展开了窗口内前 ${processed} 条事件` +
			`(共 ${events.length} 条,另有 ${remaining} 条未处理)—— 结果不完整;` +
			"请缩小 before/after 或稍后重试。");
	}
	if (omitted > 0) notices.push(expandOmittedNotice(omitted));
	if (notices.length > 0) lines.splice(header.length, 0, ...notices);
	return lines.join("\n");
}

/** `renderExpandBody` 的头部(同步/异步共用,保证两条通道逐字一致)。 */
function expandHeaderLines(value) {
	const lines = [];
	lines.push(`会话 ${value.sessionId ?? "?"}`);
	// ★ 范围行:与 renderHistoryBody 同源(见 `scopeLine`)
	lines.push(scopeLine(value.scope, value.sessionId));
	if (value.startSeq !== null && value.endSeq !== null) {
		// ★ 表层/tail 模式没有"目标事件"(`targetSeq` 为 null)⇒ **省掉那半句**,
		//   而不是印一个 `目标 seq=?`;那个 `?` 是纯噪音。
		const target = value.targetSeq === null || value.targetSeq === undefined
			? ""
			: `目标 seq=${value.targetSeq};`;
		lines.push(`窗口 seq ${value.startSeq}..${value.endSeq}` +
			`(${target}inheritedEventCount=${value.inheritedEventCount ?? "?"})`);
	} else {
		lines.push(`窗口:该会话最近的 ${value.events.length} 个表层事件`);
	}
	const clamped = [];
	if (value.clamped?.before) clamped.push("before");
	if (value.clamped?.after) clamped.push("after");
	if (clamped.length > 0) lines.push(`⚠ ${clamped.join("/")} 已被夹到官方上限 ${MAX_WINDOW}`);
	if (value.degraded) lines.push(`⚠ 降级:${value.degraded}`);
	lines.push("");
	return lines;
}

/** 渲染一条完整事件(先完整脱敏,再进正文)。 */
function pushExpandEvent(lines, value, event) {
	const mark = event.seq === value.targetSeq ? " ←目标" : "";
	lines.push(`--- seq=${event.seq ?? "?"} ${event.type ?? "?"} ${formatTime(event.time)}${mark}`);
	// 每条完整事件分别处理,不让前一条未闭合的敏感结构吞并下一条事件。
	const text = value.redaction ? value.redaction.text(event.text) : redact(event.text).text;
	lines.push(text || "(该事件没有可读文本)");
}

/** 源字符上界导致的整条省略。 */
function expandOmittedNotice(omitted) {
	return `⚠ 另有 ${omitted} 条事件未展开(单次展开的源字符上限 ${EXPAND_MAX_SOURCE_CHARS});` +
		"请用更小的 before/after 或指定具体 seq 再展开。";
}

/** 异步渲染触到预算时的固定文案(不含 signal.reason 等调用方数据)。 */
function expandStopReasonText(stop) {
	return stop === "signal" ? "本轮已取消"
		: stop === "time" ? "时间预算已用尽"
			: stop === "sealed" ? "本轮已结束"
				: "本轮未完成";
}

/** 从 `SessionEventWindow` 取文本(供调用方聚合)。 */
export function eventWindowText(window) {
	const events = Array.isArray(window?.events) ? window.events : [];
	return events.map((event) => extractText(event)).filter(Boolean).join("\n");
}

/**
 * ★ 注入消息的 id 前缀。两个用途:
 *   ① `findTrigger` 靠它跳过**自己注入**的回顾块 —— **纵深防御**,不是"闭合回路
 *      的原因"(宿主目前根本不会把会话表层重新 claim 一遍;完整论证见 `findTrigger`);
 *   ② 落进会话日志后能一眼看出"这条不是用户打的"。
 */
export const INJECTED_ID_PREFIX = "memory-unlocked-recall-";

/** 默认的合成消息 id 工厂(只在本模块内部用,避免引入额外依赖)。 */
function defaultIdFactory() {
	return `${INJECTED_ID_PREFIX}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * ★ 构造注入用的合成 `UserMessage`。
 *
 * **不凭猜字段名**:克隆 `messages` 里已有的那条 user 消息,只替换 `content` ——
 * 这样所有必需字段天然正确。
 *
 * 四个细节:
 *   · 优先克隆**触发的那条**消息(`hit.messageIndex`);找不到就退到第一条 user 消息。
 *   · 必须换一个**新** id(否则与源消息 id 重复,日志/去重都可能出问题)。
 *     ★ 即使模板上没有 `id` 也要补:已核实 `MessageBase` 必然有
 *     `readonly id: MessageId`(权威声明取自 DSH 的类型声明),补它不算"猜字段"。
 *     它同时是 `findTrigger` **跳过自己注入块**的标记 —— 那属于**纵深防御**:
 *     宿主 `ReactLoopInbox.claim()` 只取 pending 输入、不重读会话表层,所以注入块
 *     在可达路径上本就不会被再次 claim;留着是因为成本极低,且能在宿主行为变化时兜住。
 *   · ★ **不克隆模板的 `source`**,显式给 `{ kind: "user" }`。两个原因:
 *     ① 用户手打的消息 source 是 `{kind:'user', rpcId}` —— 克隆会把**人类的 rpcId 复制一份**;
 *     ② 若模板是宿主的运行时上下文消息,克隆体会带上那个 source,宿主的
 *        `RuntimeContextProjection` 监听器(`isOwned(event.data)`)会把它当成自己的快照,
 *        从而**劫持 `retained.seq`**。`{kind:'user'}` 是宿主 `MessageSourceMap` 的合法成员。
 *
 * @param messages - 当前待进入本步的消息数组。
 * @param hit - `findTrigger` 的返回(★ 其 `messageIndex` 必须与 `messages` 同源)。
 * @param text - 已发布的文本。
 * @param idFactory - 可注入的 id 工厂(测试用)。
 * @returns 合成消息;完全找不到模板时返回最小 `{ role, content, id, source }` 形状。
 */
export function buildInjectedMessage(messages, hit, text, idFactory = defaultIdFactory) {
	const list = Array.isArray(messages) ? messages : [];
	const at = Number.isInteger(hit?.messageIndex) ? hit.messageIndex : -1;
	const source = at >= 0 && at < list.length ? list[at] : undefined;
	const template = isPlainObject(source)
		? source
		: list.find((message) => isPlainObject(message) && message.role === "user");
	const content = [{ type: "text", text: String(text ?? "") }];
	const id = idFactory();
	// ★ 每次都新建一个对象,绝不从模板克隆 `source`(见函数头第三条)
	const injectedSource = { kind: "user" };
	if (!isPlainObject(template)) return { role: "user", content, id, source: injectedSource };
	return { ...template, role: "user", content, id, source: injectedSource };
}
