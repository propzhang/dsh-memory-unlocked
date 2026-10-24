/**
 * 官方返回值形状归一化。
 *
 * 为什么单独一层:官方 `ctx.sessionQuery` 的返回**在三个调用路径上形状不同**,
 * 而现有文档与源码对 `readTitle` 甚至给出了互相矛盾的结论(一说裸 string、
 * 一说 `{title:string}`)。实测自宿主检查接口与安装包后端的结论是:
 *
 *   readTitle(id)                 → SessionTitleSnapshot | undefined
 *                                    = { title: string, messageSeqs, source, eventSeq, updatedAt }
 *                                    ⇒ 要取的是 `.title`(**是个对象,不是裸字符串**)
 *   readTitleSnapshot(id)         → SessionTitleObservation = { session, title?: SessionTitleSnapshot }
 *   readTitleSnapshots([id])[i]   → { sessionId, status:'fulfilled', value:SessionTitleObservation }
 *                                 | { sessionId, status:'rejected', reason }   ← 批量是 settled 结果
 *                                    ⇒ 要取的是 `.value.title.title`
 *
 * 即"三种形状"其实分属三条调用路径。这里把三条都建模出来,并且**任何一条
 * 拿到意外形状都返回 undefined 而不是抛异常** —— 检索失败不该让整轮对话崩掉。
 *
 * ⚠️ `pickTitle*` 系列**目前没有任何调用点**:标题只用于给"别的会话列表"贴标签,
 *    而本插件不列别的会话(也省掉 `readTitleSnapshots` 每个 id 重新解压整条日志的开销)。
 *    这几个纯函数保留:它们不读宿主、零运行时成本,形状归一化也确实是本模块的职责;
 *    不与"只能读当前工作区"这条边界冲突。若确认无用,可整段删除(连带
 *    test/normalize.test.mjs 里对应的 5 条用例)。
 *
 * @module dsh-memory-unlocked/normalize
 */

/** 是不是普通对象(排除 null / 数组)。 */
export function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 从"可能是标题"的任意值里取字符串标题。
 *
 * 三种形状都吃(不同调用路径返回的形状不同),顺序无关:
 *   'text'                     → 'text'
 *   { title: 'text' }          → 'text'          ← readTitle 的真实形状
 *   { title: { title: 'text' } } → 'text'        ← readTitleSnapshots 多一层
 *
 * @param value - 任意值。
 * @returns 标题字符串;取不到时返回 undefined。
 */
export function pickTitle(value) {
	if (typeof value === "string") return value;
	if (!isPlainObject(value)) return undefined;
	if (typeof value.title === "string") return value.title;
	if (isPlainObject(value.title) && typeof value.title.title === "string") return value.title.title;
	// 极端防御:某些后端可能把标题再包一层 { snapshot: { title } }
	if (isPlainObject(value.snapshot) && typeof value.snapshot.title === "string") return value.snapshot.title;
	return undefined;
}

/**
 * 从 `readTitleSnapshot` 的 `SessionTitleObservation` 里取标题。
 * @param observation - `{ session, title? }`。
 * @returns 标题字符串或 undefined。
 */
export function pickTitleFromObservation(observation) {
	if (!isPlainObject(observation)) return undefined;
	return pickTitle(observation.title);
}

/**
 * 从 `readTitleSnapshots` 的批量结果元素里取标题(**先看 status**)。
 *
 * 批量返回的是 settled 结果数组,失败项带 `reason` —— 直接读 `.value.title`
 * 会在失败项上抛 TypeError,所以这里必须判 status。
 *
 * @param result - `{ sessionId, status, value|reason }`。
 * @returns 标题字符串或 undefined。
 */
export function pickTitleFromObservationResult(result) {
	if (!isPlainObject(result)) return undefined;
	if (result.status === "rejected") return undefined;   // 单会话失败不影响其它
	if (result.status === "fulfilled") return pickTitleFromObservation(result.value);
	// 没有 status 字段(未经 settle 的实现):两种都试一次
	return pickTitleFromObservation(result.value) ?? pickTitle(result);
}

/**
 * 把 `readTitleSnapshots` 的结果数组折成 `Map<sessionId, title>`。
 * 失败的会话直接不进 Map(而不是塞个 undefined),调用方用 `??` 兜底。
 *
 * @param results - `SessionTitleObservationResult[]`。
 * @returns `Map<string, string>`。
 */
export function titleMapFromResults(results) {
	const map = new Map();
	if (!Array.isArray(results)) return map;
	for (const result of results) {
		const title = pickTitleFromObservationResult(result);
		if (typeof title !== "string" || title.length === 0) continue;
		const id = typeof result?.sessionId === "string" ? result.sessionId
			: (typeof result?.value?.session?.id === "string" ? result.value.session.id : undefined);
		if (id) map.set(id, title);
	}
	return map;
}

/** 会话头 → 小记录(只取需要的字段,绝不复制活对象)。 */
export function normalizeSessionRecord(record) {
	const header = isPlainObject(record?.header) ? record.header : {};
	return {
		sessionId: typeof header.id === "string" ? header.id : null,
		cwd: typeof header.cwd === "string" ? header.cwd : null,
		createdAt: typeof header.createdAt === "number" ? header.createdAt : null,
		parentSession: typeof header.parentSession === "string" ? header.parentSession : null,
		isSubagent: header.origin === "subagent",
		live: record?.live === true,
		persisted: record?.persisted === true
	};
}

/**
 * `SessionSearchHit` → 配对后的命中记录。★ 这里保留 `seq`。
 *
 * 官方 `SessionSearchHit extends SessionRecord { bestMatch: SessionEventSearchHit }`,
 * 而 `SessionEventSearchHit extends SessionEventRecord { snippet }`,所以
 * `seq` 在 `hit.bestMatch.seq` 上 —— 只读 `hit.seq` 会拿不到位置,
 * 于是"定位 → 展开原文"的钻取链断掉。
 *
 * @param hit - `searchSessions` 的一个命中。
 * @returns 平面记录(含 seq)。
 */
export function normalizeSearchHit(hit) {
	const best = isPlainObject(hit?.bestMatch) ? hit.bestMatch : {};
	const record = normalizeSessionRecord(hit);
	return {
		...record,
		seq: typeof best.seq === "number" ? best.seq : null,
		time: typeof best.time === "number" ? best.time : null,
		type: typeof best.type === "string" ? best.type : null,
		surface: typeof best.surface === "string" ? best.surface : null,
		snippet: typeof best.snippet === "string" ? best.snippet : ""
	};
}

/** `SessionEventRecord` → 平面记录。 */
export function normalizeEventRecord(event) {
	return {
		sessionId: typeof event?.sessionId === "string" ? event.sessionId : null,
		seq: typeof event?.seq === "number" ? event.seq : null,
		type: typeof event?.type === "string" ? event.type : null,
		time: typeof event?.time === "number" ? event.time : null,
		surface: typeof event?.surface === "string" ? event.surface : null
	};
}

/**
 * `SessionEventWindow` → 平面记录。
 * @param window - `readEvent` 的返回值。
 * @returns `{ sessionId, startSeq, endSeq, inheritedEventCount, events[] }`。
 */
export function normalizeEventWindow(window) {
	const events = Array.isArray(window?.events) ? window.events : [];
	return {
		sessionId: typeof window?.session?.id === "string" ? window.session.id : null,
		startSeq: typeof window?.startSeq === "number" ? window.startSeq : null,
		endSeq: typeof window?.endSeq === "number" ? window.endSeq : null,
		inheritedEventCount: typeof window?.inheritedEventCount === "number" ? window.inheritedEventCount : null,
		events: events.map((event) => ({
			...normalizeEventRecord(event),
			text: extractText(event)
		}))
	};
}

/** 内容块 → 一行文本。未知类型降级成占位符,绝不抛。 */
function blockToText(block) {
	if (typeof block === "string") return block;
	if (!isPlainObject(block)) return "";
	switch (block.type) {
		case "text":
			return typeof block.text === "string" ? block.text : "";
		case "reasoning":
			return typeof block.text === "string" ? `[思考] ${block.text}` : "[思考]";
		case "tool-call":
			return `[调用工具 ${typeof block.name === "string" ? block.name : "?"}]`;
		case "image":
			return "[图片]";
		case "file":
			return `[文件 ${typeof block.attachment?.name === "string" ? block.attachment.name : "?"}]`;
		default:
			return typeof block.text === "string" ? block.text : "";
	}
}

/**
 * 从一个 `SessionEvent` 里抽出可读文本。
 *
 * 事件形状不统一:有的把消息放在 `data` 自身(`user/message`),
 * 有的包一层 `data.message`(`assistant/message` / `tool/result`)。
 * 两条路都试,再兜底 `data.text`。**不认识就返回空串,绝不抛** ——
 * 历史上任何一个新事件类型都不该让检索炸掉。
 *
 * @param event - `SessionEvent`。
 * @returns 文本(可能为空串)。
 */
export function extractText(event) {
	const data = isPlainObject(event?.data) ? event.data : {};
	const candidates = [data.message, data];
	for (const candidate of candidates) {
		if (!isPlainObject(candidate)) continue;
		if (Array.isArray(candidate.content)) {
			const text = candidate.content.map(blockToText).filter(Boolean).join("\n").trim();
			if (text) return text;
		}
		if (typeof candidate.text === "string" && candidate.text.trim()) return candidate.text;
	}
	if (typeof data.text === "string") return data.text;
	if (typeof data.arguments === "string") return data.arguments;
	return "";
}

/**
 * 把任意值夹成合法整数。
 * @param value - 输入。
 * @param min - 下界。
 * @param max - 上界。
 * @param fallback - 非法时的默认值。
 * @returns 夹好的整数。
 */
export function clampInt(value, min, max, fallback) {
	if (!Number.isInteger(value)) return fallback;
	if (value < min) return min;
	if (value > max) return max;
	return value;
}
