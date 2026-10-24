/**
 * 单次召回的工作预算:**硬取消** + **时间** + **确定性上界**。
 *
 * 为什么不能只有时间预算:
 *   · 宿主 `filterEvents` / `readSurface` **不收** `Signal`(官方签名如此);
 *     `readEvent` **支持** `Signal`,但同样**不能保证硬抢占** —— 我们也不承诺
 *     去抢占宿主 I/O,一次调用仍可能比整个预算还长;
 *   · 一次 `redact()` 要跑 15 条规则,单字段上限 1 MB ⇒ **一个**文档就可能吃掉
 *     几十到上百毫秒,而检查点只能放在循环边界,永远切不进单个同步单元;
 *   · 因此"墙钟 < 150 ms"这类断言在 CI 上不稳定,**不作为验收依据**。
 *
 * 于是本模块给出三层约束,全部**可确定性断言**(注入 `now` / `yieldFn` 即可):
 *   ① 硬取消:`signal.aborted` 或调用方 `seal()` ⇒ `check()` 立刻抛 `BudgetError`;
 *      **抛错而不是返回空串**,这样不会有人把"取消"当成"没有内容"继续发布。
 *   ② 时间:相对单调时钟的 deadline(默认 `performance.now()`,退化到 `Date.now()`);
 *      到期不抛错,由**循环**用 `timeExpired()` 收尾 —— 抛在一半会丢已算好的部分结果。
 *   ③ 确定性上界:`admit(chars)` 同时计**条数**与**源字符数**,上界与机器速度无关。
 *
 * ⚠️ **这里的"上界"只覆盖被准入渲染的文档,不是全路径 CPU/内存硬上限。**
 *   `planCompactedEntries` 的 `filter()` / `sort()` / 工具配对仍会同步遍历调用方
 *   已拿到的整个 `docs` 数组(只读元数据与长度,不脱敏正文);这部分成本随宿主
 *   返回的事件数增长,不计入 `maxSourceChars`。同步导出(不传预算的
 *   `renderCompactedBody` / `renderExpandBody`)因此只有**确定性条数/字符上限**,
 *   没有 deadline/取消,不能让出事件循环 —— 生产路径必须走异步入口。
 *
 * 调用约定(所有新入口都必须遵守):
 *   · 循环每轮先 `shouldStop()`:返回原因就**优雅收尾**(已算好的结果 + 如实标注);
 *   · 入口处要"立刻不再产出"时用 `check()`(取消/封存 ⇒ 抛错);
 *   · 每处理一篇文档先 `admit(原文长度)`(在脱敏**之前**计量,不裁切原文);
 *   · 发布/脱敏用 `assertPublishable()`(只拦封存),结果返回后 `seal()`:
 *     之后任何遗留任务再碰脱敏/发布都会抛错,**不得**在返回之后再改统计或补发布。
 *
 * @module dsh-memory-unlocked/budget
 */

/** 自动注入路径的总预算(挡在模型步骤前面,不能拖住用户这一轮)。 */
export const AUTO_BUDGET_MS = 8000;
/** 工具路径的总预算(比自动宽,但仍必须有;官方 `timeoutMs` 只是协作式)。 */
export const TOOL_BUDGET_MS = 20000;
/** "被压缩掉的部分"模式最多处理多少条候选事件(按 seq 升序的条数上界)。 */
export const COMPACT_MAX_DOCS = 5000;
/** 同模式最多读取多少**源字符**(在脱敏之前计量;超限则跳过整条,绝不裁切原文)。 */
export const COMPACT_MAX_SOURCE_CHARS = 1_500_000;
/**
 * 触到上界时**额外尝试**处理的区间末尾条数(尽力而为,不是保证)。
 *
 * 只按前缀截断会让"最后一条用户消息"消失;末尾窗口给尾部一次机会。但它
 * **仍然受源字符上限约束** —— 前缀已把字符额度用尽时,尾部一条也进不来,
 * 所以**不能**把它说成"首末一定看得见"。渲染层只在本轮全量覆盖区间时
 * 才写"区间首/末条";否则写"本次已展开的首/末条"。
 * 固定 64 条,是确定性常量,不随会话大小变化。
 */
export const COMPACT_TAIL_WINDOW = 64;
/** `recall_expand` 最多读取多少源字符(窗口本身已由 MAX_WINDOW 限住条数)。 */
export const EXPAND_MAX_SOURCE_CHARS = 400_000;
/** 异步渲染每处理多少篇让出一次事件循环。 */
export const COMPACT_YIELD_EVERY = 16;
/** `recall_expand` 异步渲染每处理多少条事件让出一次事件循环(窗口最多 101 条)。 */
export const EXPAND_YIELD_EVERY = 8;

/** `BudgetError.name` —— 调用方靠它把"预算/取消"与"真的失败"分开。 */
export const BUDGET_ERROR_NAME = "MemoryBudgetError";

/**
 * 预算/取消导致的停止。**消息里绝不放 `signal.reason`**
 * (那可能是宿主或调用方塞进来的任意对象,甚至含凭据);`reason` 只给机器读。
 */
export class BudgetError extends Error {
	/**
	 * @param message - 固定的安全文案(不含调用方数据)。
	 * @param reason - `"signal" | "sealed"`。
	 */
	constructor(message, reason) {
		super(message);
		this.name = BUDGET_ERROR_NAME;
		this.reason = reason;
	}
}

/** 单调时钟(performance.now 不受系统时间跳变影响;没有就退化)。 */
function defaultNow() {
	return typeof performance !== "undefined" && typeof performance.now === "function"
		? performance.now()
		: Date.now();
}

/** 默认让出:setImmediate 比 setTimeout(0) 少一次 1 ms 级延迟。 */
function defaultYield() {
	return new Promise((resolve) => {
		if (typeof setImmediate === "function") setImmediate(resolve);
		else setTimeout(resolve, 0);
	});
}

/**
 * 造一份预算。
 *
 * @param options - `{ deadlineMs, signal, now, yieldFn, maxDocs, maxSourceChars, label }`。
 *   `deadlineMs` 是**相对**当前时刻的毫秒数(`Infinity` = 不设时间预算);
 *   `now` / `yieldFn` 只为测试注入(生产不要传)。
 * @returns 预算对象(方法见模块头)。
 */
export function createBudget(options = {}) {
	const {
		deadlineMs = Infinity,
		signal = undefined,
		now = defaultNow,
		yieldFn = defaultYield,
		maxDocs = Infinity,
		maxSourceChars = Infinity,
		label = "recall"
	} = options;

	const startedAt = now();
	const bounded = Number.isFinite(deadlineMs) && deadlineMs >= 0;
	const expiresAt = bounded ? startedAt + deadlineMs : Infinity;

	let sealed = false;
	let docs = 0;
	let chars = 0;
	let yields = 0;
	let stoppedBy;

	const cancelled = () => signal !== undefined && signal !== null && signal.aborted === true;
	const timeExpired = () => bounded && now() >= expiresAt;
	const remainingMs = () => (bounded ? Math.max(0, expiresAt - now()) : Infinity);

	/** 当前**不该继续**的原因(不含时间:时间由循环自己收尾,见模块头)。 */
	const stopReason = () => {
		if (sealed) return "sealed";
		if (cancelled()) return "signal";
		return undefined;
	};

	/** 循环里的收尾判定:返回原因(`time` 也算),**不抛错**。 */
	const shouldStop = () => {
		const hard = stopReason();
		if (hard !== undefined) return hard;
		if (timeExpired()) {
			stoppedBy = stoppedBy ?? "time";
			return "time";
		}
		return undefined;
	};

	/**
	 * 硬检查:**已取消 / 已封存**就抛(用于"立刻不再产出"的入口)。
	 *
	 * ⚠️ 发布与脱敏用的是 `assertPublishable()`(只拦封存):已被取消的这一轮
	 * 仍然要把**已经算好的、带中止标注的**部分结果交给模型 —— 那是既有行为,
	 * 回归里钉住了(`wiring.test.mjs`:已中止仍 ok:true)。
	 */
	const check = () => {
		if (sealed) throw new BudgetError(`${label}:本次回顾已结束,拒绝继续处理`, "sealed");
		if (cancelled()) throw new BudgetError(`${label}:本次回顾已被取消`, "signal");
	};

	/**
	 * 发布闸门:**只拦"已封存"**。
	 *
	 * 封存发生在结果**已经构造好、即将返回**之后 —— 于是任何遗留任务
	 * 都不可能再补发布、也不可能再改动脱敏统计(两次约束合成一条:要改统计就得
	 * 先 `text()`,而 `text()` 同样过这道闸)。
	 */
	const assertPublishable = () => {
		if (sealed) throw new BudgetError(`${label}:本次回顾已结束,拒绝继续发布`, "sealed");
	};

	/**
	 * 准入一篇文档:`chars` 用**原文长度**(脱敏之前的真实工作量)。
	 *
	 * @param rawChars - 原文长度(不裁切、不改写;只用于计量)。
	 * @param options - `{ ignoreDocCap, extraChars }`。
	 *   `ignoreDocCap`:区间末尾窗口用 true —— 末尾窗口有自己的**固定条数**常量兜底,
	 *   所以可以越过条数上限,但**仍受源字符上限**约束(额度不够时尾部同样进不来,
	 *   因此它只是尽力而为,不是"末条锚点保证")。
	 *   `extraChars`:这篇文档**连带的**额外原文长度(如工具调用配对的结果正文 ——
	 *   它同样会被完整脱敏);计入字符上界,但不重复计条数。
	 * @returns 是否允许处理;不允许时**不改变**计数,并记下停止原因。
	 */
	const admit = (rawChars, options = {}) => {
		const extra = Number.isFinite(options.extraChars) && options.extraChars > 0 ? options.extraChars : 0;
		const cost = (Number.isFinite(rawChars) && rawChars > 0 ? rawChars : 0) + extra;
		if (options.ignoreDocCap !== true && docs >= maxDocs) {
			stoppedBy = stoppedBy ?? "docs";
			return false;
		}
		if (chars + cost > maxSourceChars) {
			stoppedBy = stoppedBy ?? "chars";
			return false;
		}
		docs += 1;
		chars += cost;
		return true;
	};

	/** 让出事件循环(让出前后都只拦"已封存";取消由循环用 `shouldStop()` 收尾)。 */
	const yieldNow = async () => {
		assertPublishable();
		yields += 1;
		await yieldFn();
		assertPublishable();
	};

	/** 结束本次工作:之后的 `check()` / `publish()` / `redaction.text()` 一律抛错。 */
	const seal = () => {
		sealed = true;
	};

	/** 只读统计(测试用它做**确定性**断言,不测墙钟)。 */
	const stats = () => ({
		docs,
		chars,
		yields,
		stoppedBy: stoppedBy ?? (timeExpired() ? "time" : undefined),
		reason: stopReason(),
		sealed,
		remainingMs: remainingMs()
	});

	/** 本次预算实际生效的确定性上界(渲染层用它把"原因"写准确)。 */
	const limits = () => ({ maxDocs, maxSourceChars });

	return {
		label,
		check,
		assertPublishable,
		admit,
		shouldStop,
		timeExpired,
		cancelled,
		remainingMs,
		stopReason,
		yieldNow,
		seal,
		stats,
		limits,
		get sealed() { return sealed; }
	};
}
