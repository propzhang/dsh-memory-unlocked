/**
 * 测试用假件:假 ctx、假 sessionQuery。
 *
 * 之所以手写而不是用 mock 库:这个插件**不允许 npm install**(硬性约束),
 * 而且标准 `node:test` 足够。另外手写的假件能把"官方契约的哪一部分被用到了"
 * 显式写出来 —— 接线层测试的价值就在这里。
 */

/** 造一条用户消息。 */
export function userMessage(text, extra = {}) {
	return { role: "user", content: [{ type: "text", text }], ...extra };
}

/** 造一个会话记录(官方 SessionRecord 形状)。 */
export function sessionRecord(id, { cwd = "C:\\work", createdAt = 1, origin } = {}) {
	const header = { id, cwd, createdAt, isSeeded: false };
	if (origin) header.origin = origin;
	return { header, live: false, persisted: true };
}

/**
 * 假 sessionQuery。每个方法都可以被覆盖成"抛错"或自定义返回值。
 * @param overrides - 覆盖任意方法。
 */
export function fakeSessionQuery(overrides = {}) {
	const calls = { searchSessions: [], listSessions: 0, filterEvents: [], filterSessions: [], readEvent: [], readSurface: [], readTitleSnapshots: [] };
	const base = {
		async searchSessions(request) {
			calls.searchSessions.push(request);
			return { items: [] };
		},
		async listSessions() {
			calls.listSessions += 1;
			return [];
		},
		// ★ 工作区校验用(`recall_expand` 判定请求的会话是否属于当前工作区)。
		//   默认返回空 ⇒ "不属于" ⇒ 拒绝:测试想放行就自己覆盖成返回一条。
		async filterSessions(filters) {
			calls.filterSessions.push(filters);
			return [];
		},
		async filterEvents(sessionId, filters) {
			calls.filterEvents.push({ sessionId, filters });
			return [];
		},
		async readEvent(request) {
			calls.readEvent.push(request);
			return { session: { id: request.sessionId }, inheritedEventCount: 0, startSeq: 0, endSeq: 0, target: null, events: [] };
		},
		async readSurface(sessionId) {
			calls.readSurface.push(sessionId);
			return { session: { id: sessionId }, inheritedEventCount: 0, capturedThroughSeq: 0, events: [] };
		},
		async readTitleSnapshots(ids) {
			calls.readTitleSnapshots.push(ids);
			return ids.map((sessionId) => ({ sessionId, status: "fulfilled", value: { session: { id: sessionId } } }));
		}
	};
	return { sq: { ...base, ...overrides }, calls };
}

/**
 * 假 ctx。记录注册了哪些工具/命令/监听器/effect。
 *
 * ★ `cwd` 参数不由插件读取:检索范围只来自 agent(见 `resolveSessionId`),
 *   `ctx.cwd` 在生产宿主的 ctx 上也不存在(cwd 是 `SessionHeader` 的字段)。
 *   保留参数只是免得改一堆只传不改的调用点。
 */
export function fakeCtx({ sessionQuery, cwd } = {}) {
	const tools = new Map();
	const commands = [];
	const listeners = new Map();
	const effects = [];
	const commandsService = {
		register(definition) {
			commands.push(definition);
			return () => {
				const at = commands.indexOf(definition);
				if (at >= 0) commands.splice(at, 1);
			};
		}
	};
	const ctx = {
		cwd,
		tools: {
			register(definition) {
				tools.set(definition.name, definition);
				return () => tools.delete(definition.name);
			}
		},
		get(name) {
			if (name === "commands") return commandsService;
			if (name === "sessionQuery") return sessionQuery;
			return undefined;
		},
		on(event, handler) {
			listeners.set(event, handler);
			return () => listeners.delete(event);
		},
		effect(fn, label) {
			effects.push(label);
			return fn();
		}
	};
	return { ctx, tools, commands, listeners, effects };
}
