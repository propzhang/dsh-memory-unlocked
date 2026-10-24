/**
 * 检索层:索引优先 + 扫描兜底 + **有界候选窗口**。
 *
 * ★ **范围 = 当前工作区**(由调用方解析出 `{sessionId, cwd}` 传进来)。
 *   索引路径把它编译成 `kind:'cwd'` 过滤器(拿不到 cwd 时退化为 `kind:'id'`);
 *   扫描路径只解压**当前工作区**里的会话日志。这里没有"全部会话"这条退路 ——
 *   范围是安全边界,不是参数。
 *
 * 为什么还留着"扫描兜底":SQLite FTS5 索引可能没建好、被禁用
 * (`SESSION_QUERY_SEARCH_DISABLED`),或者干脆还没 reconcile。没有兜底就会
 * **静默查不到** —— 那比慢一点严重得多("查不到"会被模型当成"历史上没有")。
 *
 * ★ 扫描策略:不设最低候选数 —— 那等于**每一次关键词召回
 *   都整档重放多份会话日志**(多会话时就是多次 `filterEvents`,
 *   每次 load+validate 整条日志,秒级起步)。策略:
 *     ① 当前会话永远第一个、**单独**扫;② 其余会话从新到旧并发扩张,凑够 `limit`
 *     立即停手;③ 时间预算兜底;④ 没扫到的会话数如实写进正文
 *     (`inspected` / `candidates` / `stoppedAtLimit`)。
 *   每个会话只取最近的一条命中:命中密集时成本约 `limit` + 一个并发批次
 *   (默认 limit=5 ⇒ 1~9 次 `filterEvents`,而不是固定 30~120 次);
 *   **零命中查询仍会扫满候选窗口**(≤ `INSPECT_MAX`,受 8s 预算约束)——
 *   这个策略消除的是"凑够之后的空转读取",不是"没命中必须翻完"这件事。
 *
 * @module dsh-memory-unlocked/search
 */
import {
	extractText,
	normalizeSearchHit,
	normalizeSessionRecord
} from "./normalize.js";
import { BUDGET_ERROR_NAME } from "./budget.js";
import {
	MAX_LIMIT,
	buildReadEventRequest,
	buildSearchRequest
} from "./recall.js";
import { redact } from "./redact.js";

/**
 * 取消检查点:**先看 Signal,再看预算**。
 *
 * 预算的 `check()` 只拦"硬取消/已封存"(不拦时间到期 —— 时间到期由每个循环
 * 用 `timeExpired()` 收尾,免得把已拿到的部分结果一起丢掉)。两道都抛之后,
 * 调用方用 `isAbortError` 统一识别成本轮已中止。
 */
function checkpoint(signal, budget) {
	signal?.throwIfAborted();
	budget?.check();
}

/** 完整事件先脱敏,再围绕命中词摘录;绝不在未脱敏原文上做字符裁切。 */
export function safeSnippet(text, query = "", redaction = undefined) {
	const cleaned = redaction ? redaction.text(text) : redact(text).text;
	const flat = cleaned.replace(/\s+/gu, " ").trim();
	if (flat.length <= SNIPPET_CHARS) return flat;
	const needle = redact(query).text.replace(/\s+/gu, " ").trim();
	const match = needle ? flat.toLowerCase().indexOf(needle.toLowerCase()) : -1;
	let start = Math.max(0, match - 60);
	// 不把 UTF-16 代理对切成两个无效字符。
	if (start > 0 && /[\uDC00-\uDFFF]/u.test(flat[start])) start += 1;
	const prefix = start > 0 ? "…" : "";
	let end = Math.min(flat.length, start + SNIPPET_CHARS - prefix.length - 1);
	if (end < flat.length && /[\uD800-\uDBFF]/u.test(flat[end - 1])) end -= 1;
	return prefix + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

const OMITTED_SNIPPET = "[摘要已省略:无法安全取得完整事件;请用 recall_expand 指定该 sessionId 和 seq 展开]";

/**
 * 最多检查这么多候选会话;超出就如实告知"候选窗口已用尽"。
 *
 * ★ 只保留这个上限:配合"凑够 limit 立即停"和时间预算,
 *   避免每次召回被拖成几十到上百次整档重放。
 */
export const INSPECT_MAX = 120;
/** 扫描兜底时的并发度(与官方 persistedReadConcurrency 默认值一致)。 */
export const SCAN_CONCURRENCY = 4;
/**
 * 扫描兜底的**总时间预算**(ms)。★ 只影响"要不要再**启动**下一个会话的扫描",
 * 不打断已经在飞的那几个(`filterEvents` 没有 AbortSignal 参数,想打断也打不断)。
 *
 * 为什么必须有:官方 tool `timeoutMs` 是**协作式**的,超时既不取消工具也不还回结果;
 * 实测全部候选要数百毫秒到数秒,而有界窗口上限是 120 个 ——
 * 没有预算时最坏情况会把用户的这一轮拖到难以接受。宁可**如实返回部分结果**
 * (经 `truncatedWindow` 明说"不全"),也不要假装扫完了。
 */
export const SCAN_BUDGET_MS = 8000;
/** 兜底扫描的片段长度(官方 snippetChars 默认 240 码点)。 */
export const SNIPPET_CHARS = 240;

/** 官方错误 → `{ code, message }`(保留 error.code,不吞掉)。 */
export function describeError(error) {
	if (error && typeof error === "object") {
		const code = typeof error.code === "string" ? error.code : undefined;
		const message = typeof error.message === "string" ? error.message : String(error);
		return { code: code ?? "SESSION_QUERY_UNKNOWN", message, text: code ? `${code}: ${message}` : message };
	}
	return { code: "SESSION_QUERY_UNKNOWN", message: String(error), text: String(error) };
}

/**
 * 工作区路径比较用的规范化。
 *
 * ★ Windows 上同一个目录可能以 `C:\Work\Proj` / `c:\work\proj\` 两种写法出现
 *   (宿主记录的是会话创建时的 cwd,大小写与尾分隔符都可能不同)。精确比较会把
 *   同一工作区的会话判成"范围外"而**静默漏掉** —— 用户看到的是"查不到"。
 *   win32 下折叠大小写并去掉尾部分隔符;其它平台保持原样(大小写敏感文件系统
 *   不能折叠,否则会跨目录)。
 */
export function normalizeWorkspacePath(value) {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const trimmed = value.replace(/[\\/]+$/, "");
	if (process.platform !== "win32") return trimmed;
	// ★ Windows 上 `C:/Work/Proj` 与 `C:\Work\Proj` 是同一个目录,分隔符也要折叠,
	//   否则"只换了一种写法"的会话会被判成范围外。
	return trimmed.replace(/[\\/]+/g, "\\").toLowerCase();
}

/**
 * 过滤候选会话(`listSessions()` 的返回 → 归一化记录)。**扫描路径上唯一的范围闸门。**
 *
 * 范围规则:范围是**当前工作区**,不是"当前会话"也不是"全部会话"。
 *   · 显式给了 `sessionIds` ⇒ **只按 id**,不套别的过滤(见下面的陷阱);
 *   · 否则:**当前会话永不排除**;`cwd` 已知 ⇒ 只留 `record.cwd === cwd`
 *     (win32 大小写/尾分隔符不敏感,见 `normalizeWorkspacePath`);
 *     `cwd` 未知 ⇒ 只剩当前会话(**更窄**的安全降级,绝不放宽);
 *   · 子代理会话(`origin === "subagent"`)在**工作区模式**下排除 —— 它们是实现噪音
 *     (实测日志里大多数是子代理会话),但**当前会话自己无论如何都要留下**。
 *
 * ⚠️ **显式给了 id 时不要套子代理过滤**:当前会话**自己**可能就是子代理会话
 *   (用户在子代理里说了触发词)。按 `origin` 滤掉它会**静默返回空** —— 那不是更安全,
 *   那是坏掉:模型会以为"历史上没有"。
 *
 * @param records - `listSessions()` 的返回值。
 * @param options - `{ sessionIds?, cwd?, currentSessionId? }`。
 * @returns 归一化后的候选会话记录(范围外的一个都不留)。
 */
export function filterRecords(records, { sessionIds, cwd, currentSessionId } = {}) {
	const list = Array.isArray(records) ? records : [];
	const wanted = Array.isArray(sessionIds) && sessionIds.length > 0 ? new Set(sessionIds) : undefined;
	const workspace = typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
	const workspaceKey = normalizeWorkspacePath(workspace);
	return list
		.map(normalizeSessionRecord)
		.filter((record) => record.sessionId !== null)
		.filter((record) => {
			if (wanted !== undefined) return wanted.has(record.sessionId);   // 显式 id:只认 id
			if (record.sessionId === currentSessionId) return true;          // ★ 当前会话永不排除
			if (record.isSubagent) return false;                             // 工作区模式排除子代理噪音
			// cwd 未知 ⇒ 什么都不给
			return workspaceKey !== undefined && normalizeWorkspacePath(record.cwd) === workspaceKey;
		});
}

/**
 * 扫描候选的**处理顺序**:当前会话永远第一,其余保持 `listSessions()` 的
 * newest-first 顺序(宿主按 `createdAt` 倒序,越新的会话越可能相关)。
 *
 * ★ 当前会话优先是有意为之:用户刚在说的事最可能就在这里,而且它**单独先扫**
 *   (不与其它会话并发),既保证第一条命中来自当前会话,也让预算/中止的判定确定。
 *
 * @param candidates - `filterRecords()` 的输出。
 * @param currentSessionId - 当前会话 id。
 * @returns 新数组;当前会话排第一(不在候选里时保持原顺序)。
 */
export function orderScanCandidates(candidates, currentSessionId) {
	const list = Array.isArray(candidates) ? candidates : [];
	const current = list.find((record) => record?.sessionId === currentSessionId);
	const others = list.filter((record) => record?.sessionId !== currentSessionId);
	return current === undefined ? others : [current, ...others];
}

/**
 * ★ 取本会话**全部有文本的事件**,连同它们的 `surface` 分类 —— 无关键词模式的数据源。
 *
 * 为什么这就是"真的忘了"的部分:官方 `filterEvents` 的 `surface` 子句取值
 * `current` / `shadowed` / `log-only`,判定逻辑是
 *   `surface = current.has(seq) ? "current" : replacedBy.has(seq) ? "shadowed" : "log-only"`
 * ——`shadowed` 正是被 `folded.replacements[].shadowedSeqs` 替换掉的那些事件
 * (都在官方 `@deepseek-ai/dsh-session-query` 的实现里)。
 * 它们**还在日志里,但已经不在模型的上下文里**,所以回顾它们才有意义。
 * 反过来,"给最近的 N 条"是**错的**:那几条从没离开上下文。
 *
 * ★ 为什么一次要**三个** surface 值而不是只要 `shadowed`:这样一次调用就能同时拿到
 *   ① 可恢复的 `shadowed` 事件、② 分类计数(`current` / `shadowed` / `log-only`),
 *   而**不必再单独调 `readSurface`** —— 官方对 `readSurface` 与 `filterEvents` 都会
 *   **重放整条日志**,所以这样做把无关键词模式的成本从**两次整档解析降到一次**。
 *   (`surface` 子句的三个取值就是官方允许的全集,所以这个过滤器等于"全都要"。)
 *
 * 官方返回的文档形状是 `{ sessionId, seq, type, time, surface, text }`,**按 seq 升序**,
 * 且空文本的结构事件已被跳过。
 *
 * @param sq - `ctx.sessionQuery`。
 * @param sessionId - 当前会话(只有它会被读)。
 * @param signal - 可选的 AbortSignal(filterEvents 不接受 signal,故只在端点检查)。
 * @returns `{ docs, counts, error? }`;`docs` 按 seq 升序(全部三种 surface)。
 */
export async function sessionSurfaceDocuments(sq, sessionId, signal, budget = undefined) {
	try {
		checkpoint(signal, budget);
		const docs = await sq.filterEvents(sessionId, [{ kind: "surface", values: ["current", "shadowed", "log-only"] }]);
		checkpoint(signal, budget);
		const list = (Array.isArray(docs) ? docs : [])
			// ★★ 本地复筛:官方文档**带 `sessionId`**,所以能独立核对"这条真的属于我问的会话吗"。
			//   缺这一道的话,不听话的后端把别的工作区的正文塞回来就会漏出去。
			.filter((doc) => typeof doc?.sessionId !== "string" || doc.sessionId === sessionId)
			.map((doc) => ({
				seq: typeof doc?.seq === "number" ? doc.seq : null,
				type: typeof doc?.type === "string" ? doc.type : null,
				time: typeof doc?.time === "number" ? doc.time : null,
				surface: typeof doc?.surface === "string" ? doc.surface : null,
				text: typeof doc?.text === "string" ? doc.text : ""
			}))
			.filter((doc) => doc.text.length > 0)
			.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
		const counts = { current: 0, shadowed: 0, "log-only": 0, other: 0 };
		for (const doc of list) {
			if (doc.surface === "current" || doc.surface === "shadowed" || doc.surface === "log-only") counts[doc.surface] += 1;
			else counts.other += 1;
		}
		return { docs: list, counts };
	} catch (error) {
		return { docs: [], counts: { current: 0, shadowed: 0, "log-only": 0, other: 0 }, error: describeError(error).text };
	}
}

/** 本插件自己的工具名。 */
const SELF_TOOL_NAMES = ["recall_history", "recall_expand"];

/** 这一行是不是"调用本插件工具"的那一行(工具名独占一行,或紧跟参数/冒号)。 */
function isSelfToolLine(line) {
	const text = String(line ?? "").trim();
	if (text.length === 0) return false;
	return SELF_TOOL_NAMES.some((name) =>
		text === name || text.startsWith(`${name} `) || text.startsWith(`${name}{`) || text.startsWith(`${name}:`));
}

/**
 * ★★ 这条文档是不是**本插件自己那次调用**留下的痕迹?
 *
 * **为什么必须排除**:调用本身会被记进会话日志,而它的参数里**正好含
 * 查询词**,于是下一次检索会命中自己,并把真正的历史命中**挤掉**。**这不是噪音,是错误
 * 结果** —— 模型会以为"查到了",而它查到的只是自己刚问过的话;一个**凭空编的词**
 * 也会显得"被找到过"。
 *
 * ★ 第二种形态(只挡第一种是不够的):
 *
 * ```
 * 查询:「zzz-nonexistent-term-qqq」          ← 绝对不存在的词
 * 命中 1 条
 * 1. session=… · seq=… · assistant/message · live        ← 命中了我自己的助手消息
 * ```
 *
 * 根因在官方文本抽取:助手消息的文本里**包含它携带的 tool-call 块**
 * (官方 `blockText`:`case "tool-call": return [block.name, block.arguments]`)
 * ⇒ 发起调用的那条 `assistant/message` **本身就含查询词**。
 * 只判 `type === "tool/call"` 会漏掉它。
 *
 * ⚠️ 因此这里对 **`tool/call` 与 `assistant/message` 两类**都检查"文本里有没有一行是
 *   本插件的工具名"。代价:一条**恰好**调用过本插件工具、但正文本身有价值的助手消息
 *   会被整体排除(它仍可用 `recall_expand` 按 seq 读到)。**误杀一条真命中 < 让编造词
 *   看起来被找到** —— 取前者。
 * ⚠️ 别的工具调用(比如 `read`)是正经历史,不能一起杀。
 */
export function isSelfToolCallDoc(type, text) {
	if (type !== "tool/call" && type !== "assistant/message") return false;
	const lines = String(text ?? "").split(/\r?\n/u);
	return lines.some(isSelfToolLine);
}

/** Signal 被取消,或预算硬取消(取消/封存)。 */
function isAbortError(error, signal) {
	if (signal?.aborted === true) return true;
	if (error?.name === "AbortError") return true;
	// ★ 预算取消与 Signal 取消在这里**同一语义**:都是"本轮停止",不是"服务坏了"。
	return error?.name === BUDGET_ERROR_NAME;
}

/**
 * 限并发遍历;`fn` 返回 true 表示"够了,别再继续"。
 *
 * ★ 带**有界预算**:过了 `deadline` 就不**启动**新的条目(在飞的那几个自然收尾),
 * 并把 `budgetExhausted` 交给调用方 —— 调用方据此走 `truncatedWindow` 如实告知,
 * 而不是拿部分结果冒充全部。不传 `deadline` 时行为无界。
 *
 * @param items - 待遍历条目。
 * @param concurrency - 并发度。
 * @param fn - `(item, index) => Promise<boolean>`(true=够了)。
 * @param options - `{ deadline }`,epoch ms;缺省不设预算。
 * @returns `{ budgetExhausted }`。
 */
async function forEachConcurrent(items, concurrency, fn, { deadline = Infinity } = {}) {
	let next = 0;
	let stop = false;
	let budgetExhausted = false;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (!stop) {
			if (Date.now() >= deadline) {
				// ★ 只有"还有条目没派出去"才算真的不全;全派出去了就不能谎报截断
				if (next < items.length) budgetExhausted = true;
				stop = true;
				return;
			}
			const index = next;
			next += 1;
			if (index >= items.length) return;
			try {
				const done = await fn(items[index], index);
				if (done) stop = true;
			} catch (error) {
				stop = true;
				throw error;
			}
		}
	});
	// 任一 worker 抛错(尤其取消)后先收完已启动读取,避免返回后仍修改结果/脱敏计数。
	const settled = await Promise.allSettled(workers);
	const failed = settled.find((entry) => entry.status === "rejected");
	if (failed) throw failed.reason;
	return { budgetExhausted };
}

/**
 * 索引优先 + 扫描兜底。★ **范围 = 当前工作区**(`{sessionId, cwd}` 由调用点解析;
 * `cwd` 拿不到时退化为只读当前会话,是**更窄**的安全降级)。
 *
 * @param sq - `ctx.sessionQuery`。
 * @param args - 工具参数(已校验;★ 只有 query/limit 会被读)。
 * @param options - `{ config, sessionId, cwd, signal, scanBudgetMs }`。
 *                  `sessionId` 是**当前会话**,由调用点解析;拿不到时调用点必须
 *                  fail closed,绝不能把 `undefined` 当成"不加过滤"传下来。
 *                  `signal` 来自 `exec.signal`(官方 `timeoutMs` 不取消工具,
 *                  只有真 Signal 能喊停);`scanBudgetMs` 只是测试用的预算覆盖。
 *                  `budget` 是本次调用的共享预算:`remainingMs()` 会**进一步收紧**各阶段
 *                  的墙钟窗口,硬取消则与 Signal 同语义(中止)。
 * @returns `{ hits, mode, degraded, error, inspected, candidates, stoppedAtLimit,
 *   currentSessionMissing, truncatedWindow, truncatedReason, incomplete }`。
 *   `candidates` 是范围内候选总数;`inspected` 在**扫描路径**是已检查的会话数,
 *   在**索引路径**是"返回命中涉及的会话数"(按 sessionId 去重,不是命中事件数;
 *   也不宣称这些会话的补读都已完成——补读失败由 `degraded` 标注)。
 *   `stoppedAtLimit` 表示"凑够 limit 提前停手"(与 `truncatedWindow` 互斥:预算/窗口才是结果不全)。
 *   `incomplete` 为 true 表示本轮没有覆盖应扫范围(未开始/降级/中止),零命中不得当完整结论。
 */
export async function searchCorpus(sq, args, options) {
	const { config, sessionId, cwd, signal, redaction, budget } = options;
	const limit = Math.min(args.limit ?? config.limit, MAX_LIMIT);
	// ★ 范围永远是"当前工作区"(cwd 拿不到时退化为只查当前会话);请求里必须带过滤器。
	const request = buildSearchRequest(args, config, { sessionId, cwd });
	/** 本阶段的墙钟预算 = min(测试覆盖值 / 默认 8s,调用方预算剩余)。 */
	const stageBudgetMs = (fallback) => Math.min(
		options.scanBudgetMs ?? fallback,
		budget === undefined ? Infinity : budget.remainingMs()
	);
	// 本地复用的"这个命中在范围内吗":cwd 已知 ⇒ 同工作区即可;否则只认当前会话。
	// ★ 与 filterRecords 同一套路径归一化:索引后端有权忽略过滤,这道本地复筛必须
	//   和扫描候选用同一个"同一工作区"判据(win32 大小写/分隔符/尾分隔符)。
	const workspaceKey = normalizeWorkspacePath(cwd);
	const inScope = workspaceKey !== undefined
		? (hit) => hit.sessionId === sessionId || normalizeWorkspacePath(hit.cwd) === workspaceKey
		: (hit) => hit.sessionId === sessionId;
	const result = {
		hits: [], mode: "index", degraded: undefined, error: undefined,
		inspected: 0, candidates: 0, stoppedAtLimit: false, currentSessionMissing: false,
		truncatedWindow: false, truncatedReason: undefined, incomplete: false
	};

	// ---- ① 索引 ----
	let indexError;
	try {
		checkpoint(signal, budget);
		// ★ 后端读的是 `exec?.signal`(第二参是执行上下文对象,不是 AbortSignal)。
		//   传裸 Signal 会让 `exec.signal === undefined`,索引路径的取消被静默丢弃。
		const page = await sq.searchSessions(request, { signal });
		checkpoint(signal, budget);
		const items = Array.isArray(page?.items) ? page.items : [];
		// ★ 即便请求里已经限定了范围,这里还要**再挡一道**:索引后端有权忽略过滤
		//   (官方 README 明说这个服务不鉴权、由调用方约束)。别让一个不听话/有 bug
		//   的后端把范围外的会话 id 带进给模型的文本里。
		const seen = new Set();
		const hits = items
			// header 与最佳事件身份冲突时拒绝,不得拿一个会话的范围为另一条事件背书。
			.filter((item) => typeof item?.bestMatch?.sessionId !== "string" || item.bestMatch.sessionId === item?.header?.id)
			.map(normalizeSearchHit)
			.filter(inScope)
			.filter((hit) => !isSelfToolCallDoc(hit.type, hit.snippet))
			.filter((hit) => {
				const key = JSON.stringify([hit.sessionId, hit.seq]);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		if (hits.length > 0) {
			// 后端 snippet 已经裁切,可能没有密钥的键名/scheme/@。绝不把它当完整原文。
			// 只补选中命中的语义事件,保持索引排序;失败保留定位但明确省略摘要。
			result.hits = hits.slice(0, limit).map((hit) => ({ ...hit, snippet: OMITTED_SNIPPET }));
			// ★ N1:渲染文字写的是"检查了 N 个**会话**"。索引命中是**事件**,
			//   同一会话可以有多个 seq ⇒ 这里按 sessionId 去重后再计数;
			//   直接写 `hits.length` 会把事件数冒充成会话数。
			result.inspected = new Set(
				result.hits.map((hit) => hit.sessionId).filter((id) => typeof id === "string")
			).size;
			const deadline = Date.now() + stageBudgetMs(SCAN_BUDGET_MS);
			await forEachConcurrent(result.hits, SCAN_CONCURRENCY, async (hit) => {
				checkpoint(signal, budget);
				if (!Number.isInteger(hit.seq) || hit.seq < 0 || typeof hit.sessionId !== "string") return false;
				try {
					const docs = await sq.filterEvents(hit.sessionId, [{ kind: "seq", from: hit.seq, to: hit.seq }]);
					checkpoint(signal, budget);
					const doc = Array.isArray(docs) ? docs.find((entry) => entry?.sessionId === hit.sessionId && entry?.seq === hit.seq) : undefined;
					if (!doc || typeof doc.text !== "string") return false;
					if (isSelfToolCallDoc(doc.type, doc.text)) {
						hit.omit = true;
						return false;
					}
					hit.snippet = safeSnippet(doc.text, request.query, redaction);
				} catch (error) {
					if (isAbortError(error, signal)) throw error;
					// 不回显可能包含历史正文/凭据的异常,也不回退到不完整的原始 snippet。
				}
				return false;
			}, { deadline });
			checkpoint(signal, budget);
			result.hits = result.hits.filter((hit) => !hit.omit);
			if (result.hits.some((hit) => hit.snippet === OMITTED_SNIPPET)) {
				result.degraded = "部分索引命中无法安全取得完整事件,已省略摘要;定位仍可用于展开";
			}
			if (result.hits.length > 0) return result;
		}
		result.degraded = "索引没有返回命中,已用扫描兜底(索引可能未建立或被禁用)";
	} catch (error) {
		// ★ 中止不是"索引坏了":别谎报降级、也别接着扫,如实收尾(ok 值仍为 true)
		if (isAbortError(error, signal)) return abortResult(result, limit, "索引阶段");
		indexError = describeError(error);
		result.error = indexError.text;
		result.degraded = "索引检索失败,已用扫描兜底";
	}
	result.mode = "scan";
	// ★ 索引阶段的 inspected 只是"命中涉及会话数",不是扫描进度。回退扫描后必须归零,
	//   否则候选为 0 的降级路径会拿它冒充"检查了 1 个会话"。
	result.inspected = 0;

	// ---- ② 扫描兜底(只解压范围内的会话)----
	let records;
	try {
		records = await sq.listSessions(signal);
	} catch (error) {
		if (isAbortError(error, signal)) return abortResult(result, limit, "读取会话列表阶段");
		result.error = describeError(error).text;
		result.degraded = "连会话列表也读不到,本次无法检索";
		result.incomplete = true;
		return result;
	}
	// ★ 工作区模式:同 cwd 的非子代理会话 + 当前会话自己(它可能是子代理会话,绝不排除)
	const candidates = filterRecords(records, { cwd, currentSessionId: sessionId });
	if (candidates.length === 0) {
		// ★ 如实说出来:否则"当前会话不在列表里"会被模型读成"这里真的没有"。
		//   官方 `listSessions()` 声称包含 live 会话,但这是宿主的实现细节,
		//   不该让一句"没有命中"替它撒谎。
		result.degraded = "当前会话没有出现在会话列表里,本次没能扫描(不是'历史里没有')";
		result.incomplete = true;
		return result;
	}
	// ★ 候选顺序:当前会话永远第一,其余保持 `listSessions()` 的 newest-first。
	//   这是"当前会话优先 + 惰性扩张"策略的落点:当前会话**单独**先扫,再从最近的
	//   会话开始并发扩展,凑够 limit 立即停,不设固定的最低候选数。
	// ⚠️ 当前会话可能不在 `listSessions()` 里(cwd 已知时仍可能有邻居候选):
	//   那时"当前会话优先"并不成立,要如实披露(见下面的 `currentSessionMissing`)。
	const currentSessionMissing = !candidates.some((record) => record.sessionId === sessionId);
	if (currentSessionMissing) {
		result.currentSessionMissing = true;
		result.incomplete = true;
		result.degraded = result.degraded === undefined
			? "当前会话没有出现在会话列表里,本次只扫描了同工作区的其它会话(不是'历史里没有')"
			: `${result.degraded};当前会话没有出现在会话列表里,本次只扫描了同工作区的其它会话`;
	}
	const ordered = orderScanCandidates(candidates, sessionId);
	const window = ordered.slice(0, INSPECT_MAX);
	const totalInScope = candidates.length;
	const query = request.query;
	const found = [];
	let inspected = 0;
	let stoppedAtLimit = false;
	const deadline = Date.now() + stageBudgetMs(SCAN_BUDGET_MS);
	let budgetExhausted = false;

	/** 扫一个会话:每个会话只取**最近的一条**命中(保持既有排序语义)。 */
	const scanOne = async (record) => {
		checkpoint(signal, budget);
		inspected += 1;
		try {
			const docs = await sq.filterEvents(record.sessionId, [{ kind: "text", text: query }]);
			// 已经解码完成的本次命中可安全返回;下方处理完再检查取消,不启动下一次读取。
			// ★★ 本地复筛(与索引路径那道同源):官方 `SessionEventSearchDocument` **带
			//   `sessionId` 字段**,所以这里能独立核对"这条文档真的属于我刚问的那个会话吗"。
			//   不加这一道的话,一个不听话/有 bug 的后端把**别的会话**的正文塞回来,
			//   就会原样漏进给模型的文本。
			const mine = Array.isArray(docs)
				? docs.filter((item) => typeof item?.sessionId !== "string" || item.sessionId === record.sessionId)
					// ★ 排除"本插件自己那次调用"(见 isSelfToolCallDoc):它会把真命中挤掉
					.filter((item) => !isSelfToolCallDoc(item?.type, item?.text))
				: [];
			const doc = mine.length > 0 ? mine[mine.length - 1] : undefined;
			if (doc) {
				found.push(normalizeSearchHit({
					header: { id: record.sessionId, cwd: record.cwd, createdAt: record.createdAt },
					live: record.live,
					persisted: record.persisted,
					bestMatch: { ...doc, snippet: safeSnippet(doc.text, query, redaction) }
				}));
			}
			signal?.throwIfAborted();
			budget?.check();
		} catch (error) {
			if (isAbortError(error, signal)) throw error;
			// ★ 单个会话读失败 ⇒ 这个会话**没有检查完**:零命中不得表述成"范围内没有"。
			//   用独立的 incomplete 标记,而不是让渲染层看 result.error —— 索引失败后
			//   扫描成功兜底时 result.error 仍然存在,但那次是**完整**的。
			result.incomplete = true;
			if (!result.error) result.error = describeError(error).text;
		}
	};

	try {
		// 窗口为空时也要能看见"已经中止"这件事
		checkpoint(signal, budget);
		const firstIsCurrent = window.length > 0 && window[0].sessionId === sessionId;
		let startIndex = 0;
		if (firstIsCurrent) {
			if (Date.now() < deadline && !budget?.timeExpired()) {
				// ① 当前会话**单独**先扫:先拿到最相关的一条,也不让并发提前拉起别的会话。
				await scanOne(window[0]);
				startIndex = 1;
			} else {
				budgetExhausted = true;   // 预算一开始就用尽:一个会话都不扫
			}
		}
		// ② 其余候选并发惰性扩张:凑够 limit 立即停,没扫到的会话如实披露。
		if (!budgetExhausted && found.length < limit && startIndex < window.length) {
			const outcome = await forEachConcurrent(window.slice(startIndex), SCAN_CONCURRENCY, async (record) => {
				await scanOne(record);
				if (found.length >= limit) {
					stoppedAtLimit = true;
					return true;
				}
				return false;
			}, { deadline });
			budgetExhausted = outcome.budgetExhausted;
		} else if (!budgetExhausted && found.length >= limit) {
			stoppedAtLimit = true;
		}
		// ★ 收尾前再问一次信号:否则"扫描途中被取消"会被漏掉,结果就会被当成"扫完了"。
		checkpoint(signal, budget);
	} catch (error) {
		if (!isAbortError(error, signal)) throw error;
		// ★ 中止的部分结果照样交回去(已经解压出来的命中丢掉才是真的浪费)
		result.inspected = inspected;
		result.candidates = totalInScope;
		found.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
		result.hits = found.slice(0, limit);
		return abortResult(result, limit, "扫描阶段");
	}
	result.inspected = inspected;
	result.candidates = totalInScope;
	// ★ 提前停手不是"结果不全":返回的正是调用方要的 limit 条。但没检查的会话要如实
	//   写出来,所以单独给 `stoppedAtLimit`(渲染层用一行 ℹ 说明),不与"截断"混为一谈。
	// ⚠️ 预算耗尽优先:若 budgetExhausted 与"凑够 limit"同时发生(worker 时序上完全
	//   可能),结果是**因预算不全**,不能再宣称"提前停手是正常收尾" —— 否则正文会
	//   同时出现"预算耗尽结果可能不全"和"命中数已达上限"两套矛盾口径。
	result.stoppedAtLimit = !budgetExhausted && stoppedAtLimit && totalInScope > inspected;
	// 预算用尽 / 候选窗口用尽才是"结果不全",共用一个截断通道,但原因分开写
	result.truncatedReason = budgetExhausted ? "budget"
		: (result.stoppedAtLimit ? undefined : (totalInScope > INSPECT_MAX ? "window" : undefined));
	result.truncatedWindow = result.truncatedReason !== undefined;
	found.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
	// ★ 这里**不**为命中补标题(`readTitleSnapshots` 每个 id 都要重新解压整条日志,
	//   只为一个装饰性标题不值)。标题只用于给"别的会话列表"贴标签,而本插件不列
	//   别的会话 —— 顺带省掉一次整档解码。
	result.hits = found.slice(0, limit);
	return result;
}

/**
 * 中止(Signal 被取消)不是检索失败:交回已经拿到的部分,并让渲染层显式写出"不完整"。
 * @param result - 正在构造的结果。
 * @param limit - 返回条数上限。
 * @param stage - 在哪一步被中止(要能照着排查)。
 */
function abortResult(result, limit, stage) {
	result.mode = "aborted";
	// 具体是"中止"这件事由 truncatedReason 那条披露去说,这里只补上**在哪一步**
	result.degraded = `本轮已中止(${stage})`;
	result.truncatedWindow = true;
	result.truncatedReason = "abort";
	result.hits = result.hits.filter((hit) => !hit.omit).slice(0, limit);
	return result;
}

/**
 * 以某个 (sessionId, seq) 为中心展开原文。
 * @param sq - `ctx.sessionQuery`。
 * @param args - 工具参数(已校验;★ `sessionId` 由调用点保证等于当前会话)。
 * @param config - 规整后的配置。
 * @param signal - 可选的 AbortSignal(`readEvent` 接受它)。
 * @returns `{ ok, events, startSeq, endSeq, targetSeq, inheritedEventCount, clamped }`
 *          或 `{ ok:false, error }`。
 */
export async function expandAt(sq, args, config, signal, budget = undefined) {
	const request = buildReadEventRequest(args, config);
	const clamped = {
		before: (args.before ?? config.before) > request.before,
		after: (args.after ?? config.after) > request.after
	};
	try {
		checkpoint(signal, budget);
		const window = await sq.readEvent(request, signal);
		checkpoint(signal, budget);
		const events = Array.isArray(window?.events) ? window.events : [];
		if (window?.session?.id !== request.sessionId || events.some((event) =>
			typeof event?.sessionId === "string" && event.sessionId !== request.sessionId)) {
			return { ok: false, code: "SESSION_QUERY_SCOPE_MISMATCH", error: "宿主返回的事件窗口与请求会话不一致,已拒绝读取内容", clamped };
		}
		return {
			ok: true,
			sessionId: typeof window?.session?.id === "string" ? window.session.id : request.sessionId,
			startSeq: typeof window?.startSeq === "number" ? window.startSeq : null,
			endSeq: typeof window?.endSeq === "number" ? window.endSeq : null,
			targetSeq: request.seq,
			inheritedEventCount: typeof window?.inheritedEventCount === "number" ? window.inheritedEventCount : null,
			events: events.map((event) => ({
				seq: typeof event?.seq === "number" ? event.seq : null,
				type: typeof event?.type === "string" ? event.type : null,
				time: typeof event?.time === "number" ? event.time : null,
				text: extractText(event)
			})),
			clamped
		};
	} catch (error) {
		const described = describeError(error);
		return { ok: false, error: described.text, code: described.code, clamped };
	}
}

/**
 * 没给 seq 时的兜底:读该会话的当前模型表层,取最后 N 个事件。
 * (官方 `readSurface` 会 load+validate 整条日志,所以只在显式请求时用。)
 * @param sq - `ctx.sessionQuery`。
 * @param sessionId - 目标会话。
 * @param options - `{ limit = 8, signal }`(signal 会透给 `readSurface`)。
 */
export async function expandTail(sq, sessionId, { limit = 8, signal } = {}) {
	try {
		if (typeof sq.readSurface !== "function") {
			return { ok: false, error: "ctx.sessionQuery.readSurface 不可用", code: "SESSION_QUERY_UNSUPPORTED" };
		}
		const surface = await sq.readSurface(sessionId, signal);
		const events = Array.isArray(surface?.events) ? surface.events : [];
		const tail = events
			.slice()
			.sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0))
			.slice(-limit);
		return {
			ok: true,
			sessionId: typeof surface?.session?.id === "string" ? surface.session.id : sessionId,
			startSeq: typeof tail[0]?.seq === "number" ? tail[0].seq : null,
			endSeq: typeof tail[tail.length - 1]?.seq === "number" ? tail[tail.length - 1].seq : null,
			targetSeq: null,
			inheritedEventCount: typeof surface?.inheritedEventCount === "number" ? surface.inheritedEventCount : null,
			events: tail.map((event) => ({
				seq: typeof event?.seq === "number" ? event.seq : null,
				type: typeof event?.type === "string" ? event.type : null,
				time: typeof event?.time === "number" ? event.time : null,
				text: extractText(event)
			})),
			clamped: { before: false, after: false }
		};
	} catch (error) {
		const described = describeError(error);
		return { ok: false, error: described.text, code: described.code };
	}
}
