/**
 * 脱敏测试:13 类凭据各一条,外加一条"不误杀正常文本"的反向用例。
 *
 * 反向用例和正向同样重要 —— 一个把所有长串都打码的脱敏器会让这个插件的价值
 * (把旧对话的细节带回来)归零。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MASK, RULES, entropyPerChar, looksLikePlaceholder, redact } from "../lib/redact.js";

/**
 * ★ 假凭据夹具**一律在运行时拼出来**,源码里不留完整形态。
 *
 * 为什么:GitHub 的 push protection / secret scanning 是按各家服务商的**形态**扫源码的
 * —— 哪怕是纯假夹具,`ghp_` + 36 位这种字面量也可能让整次 push 被拒。
 * 拼出来既能继续真正测到 lib/redact.js 的规则,又不在仓库里留下可被拦的形态。
 * 每条后面注明它对应的规则。
 */
const FAKE_OPENAI = `sk-${"a".repeat(20)}`;                        // /\bsk-[A-Za-z0-9_-]{16,}/
const FAKE_GITHUB = `gh${"p"}_${"A".repeat(36)}`;                  // /\bgh[pousr]_[A-Za-z0-9]{20,}/
const FAKE_SLACK = `xox${"b"}-${"1".repeat(10)}-${"a".repeat(12)}`; // /\bxox[abprs]-[A-Za-z0-9-]{10,}/
const FAKE_AWS = "AKIA" + "I".repeat(16);                          // /\bAKIA[0-9A-Z]{16}\b/
const FAKE_SONAR = `sq${"p"}_${"1".repeat(20)}`;                   // /\bsq[ap]_[A-Za-z0-9]{16,}/
const FAKE_JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4fwpM"].join(".");
const PEM_HEAD = "-----BEGIN " + "RSA " + "PRIVATE " + "KEY-----";
const PEM_TAIL = "-----END " + "RSA " + "PRIVATE " + "KEY-----";
const PEM_HEAD_OPENSSH = "-----BEGIN " + "OPENSSH " + "PRIVATE " + "KEY-----";

test("规则表就是 15 条(私钥块由两条实现:整块 + 未闭合兜底)", () => {
	// 15 条规则 = 13 类凭据 + 私钥多出来的一条实现 + ★ 独立的「URL 路径中的凭据」
	assert.equal(RULES.length, 15);
	assert.equal(new Set(RULES.map((rule) => rule.label)).size, 15);
	// ★ 安全回归:这条规则必须还在(去掉它,推送服务那类密钥就会明文进模型)
	assert.ok(RULES.some((rule) => rule.label === "URL 路径中的凭据"), "URL 路径凭据规则不得被删");
});

test("① OpenAI 风格 API key", () => {
	const out = redact(`key=${FAKE_OPENAI} 结束`);
	assert.ok(!out.text.includes(FAKE_OPENAI));
	assert.ok(out.text.includes(MASK));
	assert.ok(out.labels.some((label) => label.startsWith("OpenAI")));
});

test("② GitHub token", () => {
	const out = redact(`token ${FAKE_GITHUB} 结束`);
	assert.ok(!out.text.includes(`gh${"p"}_`));
	assert.equal(out.count, 1);
});

test("③ Slack token", () => {
	const out = redact(`${FAKE_SLACK} 结束`);
	assert.ok(!out.text.includes(`xox${"b"}-`));
	assert.equal(out.count, 1);
});

test("④ AWS access key id", () => {
	const out = redact(`${FAKE_AWS} 结束`);
	assert.ok(!out.text.includes(FAKE_AWS));
	assert.equal(out.count, 1);
});

test("⑤ SonarQube token", () => {
	const out = redact(`${FAKE_SONAR} 结束`);
	// ★ 直接比对拼出来的夹具:若写成固定字面量,
	//   夹具若全为 1,固定字面量那句就永远为真 —— 是个**空转断言**,等于没有守卫。
	assert.ok(!out.text.includes(FAKE_SONAR));
	assert.equal(out.count, 1);
});

test("⑥ Bearer token", () => {
	const out = redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz 结束");
	assert.ok(!out.text.includes("abcdefghijklmnopqrstuvwxyz"));
	assert.equal(out.count, 1);
});

test("⑦ 私钥块(整块遮掉)", () => {
	const text = [
		PEM_HEAD,
		"MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyz",
		"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=",
		PEM_TAIL
	].join("\n");
	const out = redact(text);
	assert.ok(!out.text.includes("MIIEowIBAAKCAQEA"));
	assert.ok(!out.text.includes(PEM_HEAD));
	assert.equal(out.count, 1);
});

test("⑦b 未闭合的私钥头也遮", () => {
	const out = redact(`被我截断的密钥头:${PEM_HEAD_OPENSSH}`);
	assert.ok(!out.text.includes(PEM_HEAD_OPENSSH));
	assert.equal(out.count, 1);
});

test("⑧ JWT", () => {
	const out = redact(`token ${FAKE_JWT} 结束`);
	assert.ok(!out.text.includes("eyJhbGciOiJIUzI1NiJ9"));
	assert.equal(out.count, 1);
});

test("⑨ URL 内嵌凭据(只遮密码,保留用户名与主机)", () => {
	const out = redact("clone https://alice:s3cr3tP4ss@example.com/repo.git");
	assert.ok(!out.text.includes("s3cr3tP4ss"));
	assert.ok(out.text.includes("https://alice:"), "用户名与 scheme 应保留,方便回忆当时在操作什么");
	assert.ok(out.text.includes("@example.com"), "主机应保留");
	assert.equal(out.count, 1);
});

test("⑩ 中文口语凭据", () => {
	const out = redact("当时他说密码是 hunter2hunter2,我记下来了");
	assert.ok(!out.text.includes("hunter2hunter2"));
	assert.ok(out.text.includes("密码是"), "键名保留");
	assert.equal(out.count, 1);
	// 冒号形态
	assert.equal(redact("密钥:abcd1234efgh").count, 1);
});

test("⑪ 本地路径中的用户名(★ 只遮用户名,不遮整条路径)", () => {
	// 用通用用户名做夹具:这条规则要覆盖 Windows 大写形式与 POSIX 小写形式,
	// 而**不该**把真实用户名写进仓库。
	const out = redact("改了 C:\\Users\\Alice\\AppData\\Local\\x.txt 和 /home/alice/proj/a.py");
	assert.ok(!out.text.includes("alice"));
	assert.ok(!out.text.includes("Alice"));
	// 路径本身必须留着 —— 那是"当时在改哪个文件"的关键线索
	assert.ok(out.text.includes("C:\\Users\\") && out.text.includes("\\AppData\\Local\\x.txt"));
	assert.ok(out.text.includes("/home/") && out.text.includes("/proj/a.py"));
	assert.equal(out.count, 2);
});

test("⑫ 赋值型密钥(认键名、遮值、留键)", () => {
	const out = redact("DB_PASSWORD=sup3rs3cr3tValue\napi_key: A1b2C3d4E5f6G7h8");
	assert.ok(!out.text.includes("sup3rs3cr3tValue"));
	assert.ok(!out.text.includes("A1b2C3d4E5f6G7h8"));
	assert.ok(out.text.includes("DB_PASSWORD="), "键名保留,便于理解上下文");
	assert.equal(out.count, 2);
});

test("⑬ 高熵裸串(带阈值)", () => {
	const blob = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2";
	assert.ok(entropyPerChar(blob) >= 3.5, `熵应 >= 3.5,实测 ${entropyPerChar(blob).toFixed(2)}`);
	const out = redact(`这是那个串 ${blob} 结束`);
	assert.ok(!out.text.includes(blob));
	assert.equal(out.count, 1);
});

test("★ 不误杀正常文本(否则插件价值归零)", () => {
	const normal = [
		"我们讨论了大记忆恢复术这个插件的设计,决定用 ctx.sessionQuery 而不是自己解析 zstd。",
		"The quick brown fox jumps over the lazy dog.",
		"commit 9f2c1a4b8e7d6c5f4a3b2c1d0e9f8a7b6c5d4e3f 修好了问题",   // 40 位 hex = git SHA
		"XMLHttpRequestEventTargetImplementation 这个长标识符不该被打码",
		"password=$DB_PASSWORD 和 token=<your-token-here> 都是变量引用",
		"https://example.com/path?a=1&b=2 这个 URL 没有凭据",
		"UUID 550e8400-e29b-41d4-a716-446655440000 也要放过"
	].join("\n");
	const out = redact(normal);
	assert.equal(out.text, normal, `正常文本被误改了:${out.labels.join(",")}`);
	assert.equal(out.count, 0);
});

test("looksLikePlaceholder 认得变量引用/尖括号/CHANGEME", () => {
	for (const value of ["$SONAR_TOKEN", "${TOKEN}", "<your-key-here>", "xxxxxx", "CHANGEME_me", "YOUR_TOKEN", "«已打码»"]) {
		assert.equal(looksLikePlaceholder(value), true, `${value} 应视为占位符`);
	}
	// 真口令里带 $ 不能因此放过
	assert.equal(looksLikePlaceholder("hunter$hunter2"), false);
});

test("脱敏后的占位符不会被后续规则二次处理", () => {
	const out = redact(`密码是 abcdefgh1234 和 token=${FAKE_GITHUB}`);
	assert.equal((out.text.match(/«已打码»/gu) ?? []).length, 2);
	assert.ok(!out.text.includes(`gh${"p"}_`));
});

/**
 * ★★ 安全回归:推送服务密钥**粘在域名后面、没有键名**时,必须能被遮掉。
 *
 * 原因:唯一的"裸串高熵"规则要求长度 **≥ 32**,而 推送服务这类密钥只有 20 出头;
 * 同一串写成 `token: xxx` 时能被"赋值型密钥"遮掉 —— 因为那里**有键名**;
 * 换成 URL 形式就没有键名了,于是必须靠位置 + 熵来判。
 *
 * ⚠️ 测试里用的是**同形态的合成 token**(长度/大小写/数字/熵与真的一致),
 *   **真实密钥绝不入库**。
 */
const FAKE_PUSH_KEY = "SYNTH4ticKey9Q2mZ4rT6y";   // 22 字符、混合大小写+数字、熵 > 3.5

test("★★ URL 路径里的高熵密钥必须被打码(没有键名也认得出)", () => {
	// 长度/形态必须覆盖这个洞,否则测不住
	assert.equal(FAKE_PUSH_KEY.length, 22);
	assert.ok(entropyPerChar(FAKE_PUSH_KEY) >= 3.5, "熵要过阈值,测试才有意义");
	const line = `示例文本 https://push.example.invalid/${FAKE_PUSH_KEY}`;
	const out = redact(line);
	assert.ok(!out.text.includes(FAKE_PUSH_KEY), "★★ 密钥不得明文留下(否则会以明文形式发布)");
	assert.ok(out.text.includes(MASK), "应当遮成占位符");
	assert.ok(out.text.includes("https://push.example.invalid/"), "URL 前缀要保留,不然读不懂上下文");
	// URL 之外的裸串仍然按原阈值(≥32)处理,不受这条新规则影响
	const bare = `开头就有 ${FAKE_PUSH_KEY} 结尾`;   // 22 字符、没有键名
	assert.equal(redact(bare).text.includes(FAKE_PUSH_KEY), true, "裸串阈值不变(≥32),这里仍然放过");
});

test("★ URL 规则不许误杀正常链接(否则 README 里的地址全成马赛克)", () => {
	const normal = [
		"https://github.com/propzhang/dsh-memory-unlocked",
		"https://example.com/ExamplePath2024",
		"https://push.example.invalid/abcdefghijklmnop",
		"https://docs.example.com/api/v2/Endpoints"
	].join("\n");
	const out = redact(normal);
	assert.equal(out.text, normal, `正常 URL 被误改了:${out.labels.join(",")}`);
});
