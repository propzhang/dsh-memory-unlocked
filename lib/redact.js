/**
 * 出口脱敏:把从历史会话取回的文本里**已知形态**的凭据打码。
 *
 * 为什么需要:你三个月前在某个会话里粘过的 API key,今天被检索出来就会进入
 * 模型上下文,还会写进当前会话日志、二次扩散。只做私密标记是不够的,必须
 * 在这个出口把凭据形态挡掉。
 *
 * 边界(必须说清楚):这只覆盖**已知形态**,是纵深防御,**不是保险箱**。
 * 非常规格式的密钥照样会漏;真正的防线是"默认只看当前工作目录" + 只用
 * `ctx.sessionQuery` 的服务端过滤。
 *
 * 规则共 15 条,每条都刻意写成**有界或线性**的:没有嵌套量词、没有 `.*` 与
 * 回溯的组合,在长文本上不会退化。
 *
 * @module dsh-memory-unlocked/redact
 */

/** 打码后的占位文本。带类型说明,让模型知道这里代表敏感值。 */
export const MASK = "«已打码»";
/** 单字段最大 UTF-16 长度;超限整段省略,绝不发布未扫描的头尾。 */
export const MAX_REDACT_CHARS = 1_000_000;
const OVERSIZED_TEXT = `${MASK}[字段过长,已整段省略]`;

/** 只认完整、有限的模板词元,不能把 TEST/FAKE 等任意前缀当成豁免。 */
const NAMED_PLACEHOLDER = /^(?:YOUR|EXAMPLE|PLACEHOLDER|REDACTED|CHANGEME|DUMMY|FAKE|TEST|MOCK)(?:[-_](?:(?:API|ACCESS|SECRET|PRIVATE)[-_])?(?:KEY|TOKEN|PASSWORD|PASSWD|PWD|SECRET|CREDENTIAL|PASSPHRASE|VALUE)(?:[-_]HERE)?)?$/iu;
const PLACEHOLDER_TYPE = /^(?:(?:API|ACCESS|SECRET|PRIVATE)[-_])?(?:KEY|TOKEN|PASSWORD|PASSWD|PWD|SECRET|CREDENTIAL|PASSPHRASE|VALUE)$/iu;

/** 赋值型规则认得的键名关键词(小写、按分隔符拆成片段后比对)。 */
const SECRET_KEYWORDS = new Set([
	"password", "passwd", "pwd", "secret", "token", "apikey", "privatekey",
	"accesskey", "secretkey", "credential", "authorization", "passphrase"
]);

/** 取出 replaceAll 回调里的捕获组(去掉 match、offset、string)。 */
function groupsOf(args) {
	return args.slice(1, Math.max(1, args.length - 2));
}

/** 把命中的键名切成小写片段:`DB_PASSWORD=` → ['db','password']。 */
function keyTokens(key) {
	return String(key)
		.toLowerCase()
		.replaceAll(/["'\s=:]/gu, "")
		.split(/[_-]+/u)
		.filter(Boolean);
}

/** 赋值式左边是不是"疑似密钥键名"。按**完整片段**比对,`tokenizer=` 不会被误伤。 */
function isSecretKey(key) {
	const tokens = keyTokens(key);
	return tokens.some(
		(token, index) =>
			SECRET_KEYWORDS.has(token) ||
			(index > 0 && SECRET_KEYWORDS.has(tokens[index - 1] + token))
	);
}

/**
 * 判断一段"值"是否是完整变量引用或明确占位符,而不是真凭据。
 *
 * 必须匹配**整个值**,仅移除一对匹配的引号。`Testing42!`、`$hunter2!`、
 * `${TOKEN}tail` 和 `«已打码»tail` 都不能因前缀看起来像模板就被放过。
 * 尖括号内也只认明确模板词元;任意 `<...>` 内容并非安全的凭据豁免。
 */
export function looksLikePlaceholder(value) {
	let text = String(value);
	if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.at(-1) === text[0]) {
		text = text.slice(1, -1);
	}
	if (!text || text === MASK) return true;
	if (/^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/u.test(text)) return true;
	if (/^[x*]+$/iu.test(text)) return true;
	if (NAMED_PLACEHOLDER.test(text) || /^CHANGEME[-_]ME$/iu.test(text)) return true;
	if (text.startsWith("<") && text.endsWith(">")) {
		const inner = text.slice(1, -1);
		return NAMED_PLACEHOLDER.test(inner) || PLACEHOLDER_TYPE.test(inner);
	}
	return false;
}

/** 单字符香农熵(bits/char)。 */
export function entropyPerChar(text) {
	if (!text) return 0;
	const counts = new Map();
	for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let entropy = 0;
	for (const n of counts.values()) {
		const p = n / text.length;
		entropy -= p * Math.log2(p);
	}
	return entropy;
}

/**
 * 高熵裸串(第 14 条规则)。用函数而不是正则,因为要算熵。
 *
 * 判定刻意保守,避免误杀正常文本:
 *   · 长度 ≥ 32
 *   · 同时含小写、大写、数字(纯单词、长标识符、纯小写 UUID 都会因此放过)
 *   · 香农熵 ≥ 3.5 bits/char
 *   · 排除纯十六进制(那是 git SHA / md5,不是凭据)与 `data:`/`sha256-` 前缀
 *
 * 已知局限:全小写+数字的 base64 密钥可能漏过(牺牲召回换精度)。
 */
function highEntropySpans(text) {
	const spans = [];
	const pattern = /[A-Za-z0-9+/_=-]{32,200}/gu;
	let match;
	while ((match = pattern.exec(text)) !== null) {
		const token = match[0];
		if (looksLikePlaceholder(token)) continue;
		if (/^[0-9a-f]+$/u.test(token)) continue;
		if (/^(?:sha256-|sha512-|data:)/u.test(token)) continue;
		const hasLower = /[a-z]/u.test(token);
		const hasUpper = /[A-Z]/u.test(token);
		const hasDigit = /[0-9]/u.test(token);
		if (!(hasLower && hasUpper && hasDigit)) continue;
		if (entropyPerChar(token) < 3.5) continue;
		spans.push([match.index, match.index + token.length]);
	}
	return spans;
}

/**
 * ★ URL 路径/查询里的凭据段(第 15 条规则)。
 *
 * **为什么必须单列一条**:唯一的"裸串高熵"规则要求长度 **≥ 32**,而推送服务的密钥
 * 通常 **20 出头**、直接粘在域名后面、**没有任何键名**:
 *
 *   `示例文本 https://<host>/<key>`
 *                                                  ^^^^^^^^^ 16~24 字符 ⇒ 单靠"裸串"规则看不见
 *
 * (同一串写成 `token: <key>` 时会被"赋值型密钥"规则遮掉 —— 因为那里**有键名**。
 *  换成 URL 形式就没有键名了,所以只能靠位置 + 熵来判。)
 *
 * 判定仍然保守,避免把正常 URL 打成马赛克:
 *   · 只扫 **URL 之后的第一个路径/查询段**;
 *   · 长度 ≥ 16(比裸串的 32 低,因为它已经被"在 URL 里"这个位置条件约束住了);
 *   · 同时含小写、大写、数字(⇒ `dsh-memory-unlocked`、`ExamplePath2024` 之类都放过);
 *   · 香农熵 ≥ 3.5 bits/char;排除纯十六进制。
 */
function urlSecretSpans(text) {
	const spans = [];
	const url = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>"'\u0060]{0,160}/giu;
	// ⚠️ 字符集里**不含 `/`**:URL 里 `/` 是分段符,含进来会把 `com/ExamplePath2024` 拼成一段,
	//    从而误杀 `https://example.com/ExamplePath2024` 这种正常链接。
	const segment = /[A-Za-z0-9+_=-]{16,200}/gu;
	let outer;
	while ((outer = url.exec(text)) !== null) {
		const base = outer.index;
		segment.lastIndex = 0;
		let inner;
		while ((inner = segment.exec(outer[0])) !== null) {
			const token = inner[0];
			if (looksLikePlaceholder(token)) continue;
			if (/^[0-9a-f]+$/u.test(token)) continue;
			if (!(/[a-z]/u.test(token) && /[A-Z]/u.test(token) && /[0-9]/u.test(token))) continue;
			if (entropyPerChar(token) < 3.5) continue;
			spans.push([base + inner.index, base + inner.index + token.length]);
		}
	}
	return spans;
}

/**
 * 单向扫描完整 PEM 标记,不对每个 BEGIN 重新搜索其后全文。
 * 只接受一层且类型相同的 BEGIN/END;未闭合、嵌套、错配或孤立 END
 * 意味着字段边界不可信,整个源字段遮掉。JSON 的 \\n / \\r 不影响标记识别。
 * 不猜测 Base64 熵,也不以 4000 字符窗口放行尾部;总输入限界仍在 redact 入口。
 */
function scanPrivateKeys(text) {
	const marker = /-----(BEGIN|END) ([A-Z ]{0,32})PRIVATE KEY-----/gu;
	const spans = [];
	let pending;
	let match;
	while ((match = marker.exec(text)) !== null) {
		if (match[1] === "BEGIN") {
			if (pending) return { spans: [], incomplete: true };
			pending = { start: match.index, type: match[2] };
		} else {
			if (!pending || pending.type !== match[2]) return { spans: [], incomplete: true };
			spans.push([pending.start, marker.lastIndex]);
			pending = undefined;
		}
	}
	return { spans, incomplete: pending !== undefined };
}

/**
 * 15 条规则。`keep` = 保留第几个捕获组(只遮值、留键名);
 * `accept` 在保留组基础上再判一次;`fn` 是自定义扫描(PEM 标记或高熵串)。
 */
export const RULES = [
	// PEM 先于其它规则:完整块只计一次,边界不可信时整字段遮挡而非仅遮头。
	{ label: "私钥头(未闭合)", fn: (text) => scanPrivateKeys(text).incomplete ? [[0, text.length]] : [] },
	{ label: "私钥块", fn: (text) => scanPrivateKeys(text).spans },
	{ label: "OpenAI 风格 API key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/gu },
	{ label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/gu },
	{ label: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu },
	{ label: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/gu },
	{ label: "SonarQube token", pattern: /\bsq[ap]_[A-Za-z0-9]{16,}/gu },
	{ label: "Bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gu },
	{ label: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/gu },
	{
		label: "URL 内嵌凭据",
		// 用 lookahead 保住 `@`:否则 `user:pass@host` 里的 `@` 会被一起吃掉,
		// 结果变成 `https://alice:«已打码»example.com/...`(主机名粘在掩码上)。
		// 用户名/密码按分隔符扫描完整值,不因超过 64/128 字符而整条漏掉。
		pattern: /([a-z][a-z0-9+.-]{1,15}:\/\/[^/\s:@]+:)([^/\s@]+)(?=@)/giu,
		keep: 1
	},
	{
		label: "中文口语凭据",
		// 完整遮掉值,不在第 64 字符留下明文尾部;单字段总长已在入口限界。
		pattern: /((?:密码|口令|密钥|秘钥|令牌)\s*(?:是|为|改成|设为|[:=：])\s*)([^\s,;,。;;]{4,})/gu,
		keep: 1
	},
	{
		label: "本地路径中的用户名",
		// ★ 只遮用户名,不遮整条路径:整条路径遮掉会把"我们当时在改哪个文件"
		//   这个最有用的回忆抹平,而用户名才是 PII。
		// Windows Users 大小写不敏感;连续分隔符兼容 JSON 转义(双反斜杠),保留原样。
		// 用户名取完整一段,不能在固定长度后留下未扫描的尾部。
		pattern: /([A-Za-z]:[\\/]+[Uu][Ss][Ee][Rr][Ss][\\/]+|\/home\/|\/Users\/)([^\\/\s"']+)/gu,
		keep: 1
	},
	{
		label: "赋值型密钥",
		pattern: /(\b[A-Z0-9_-]{1,60}["']?\s*[=:]\s*)(["'][^"'\n]{8,}["']|[^\s"',;]{8,})/giu,
		keep: 1,
		accept: isSecretKey
	},
	{ label: "高熵裸串", fn: highEntropySpans },
	// ★ 放在最后:URL 段扫描比裸串更宽松(阈值 16 vs 32),但位置条件更强
	{ label: "URL 路径中的凭据", fn: urlSecretSpans }
];

/** 按一条规则打码,返回新文本与命中数。 */
function applyRule(text, rule) {
	let hits = 0;
	if (typeof rule.fn === "function") {
		const spans = rule.fn(text);
		if (spans.length === 0) return { text, hits: 0 };
		let out = "";
		let cursor = 0;
		for (const [start, end] of spans) {
			out += text.slice(cursor, start) + MASK;
			cursor = end;
		}
		out += text.slice(cursor);
		return { text: out, hits: spans.length };
	}
	const replaced = text.replaceAll(rule.pattern, (...args) => {
		const match = args[0];
		const kept = rule.keep ? String(groupsOf(args)[rule.keep - 1] ?? "") : "";
		if (rule.accept && !rule.accept(kept)) return match;
		const value = rule.keep ? match.slice(kept.length) : match;
		if (looksLikePlaceholder(value)) return match;
		hits += 1;
		return `${kept}${MASK}`;
	});
	return { text: replaced, hits };
}

/**
 * 给一段文本里的已知凭据形态打码。
 * @param input - 待处理文本(非字符串按空串处理)。
 * @returns `{ text, count, labels }`。
 */
export function redact(input) {
	if (typeof input !== "string" || input.length === 0) {
		return { text: typeof input === "string" ? input : "", count: 0, labels: [] };
	}
	if (input.length > MAX_REDACT_CHARS) {
		return { text: OVERSIZED_TEXT, count: 1, labels: ["超长字段×1"] };
	}
	let text = input;
	let count = 0;
	const labels = [];
	for (const rule of RULES) {
		const result = applyRule(text, rule);
		if (result.hits > 0) {
			text = result.text;
			count += result.hits;
			labels.push(`${rule.label}×${result.hits}`);
			// 短口令/用户名替成 MASK 后可能变长;同样限界,保证下一轮不会才触发超限。
			if (text.length > MAX_REDACT_CHARS) {
				return { text: OVERSIZED_TEXT, count: count + 1, labels: [...labels, "超长字段×1"] };
			}
		}
	}
	return { text, count, labels };
}
