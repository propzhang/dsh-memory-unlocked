/** Security regressions use invented values only; no live credentials or session data. */
import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";
import { createRedactionContext, publish } from "../lib/publish.js";
import { normalizeConfig, skeletonEntry } from "../lib/recall.js";
import { MASK, MAX_REDACT_CHARS, looksLikePlaceholder, redact } from "../lib/redact.js";
import { safeSnippet, searchCorpus } from "../lib/search.js";
import { fakeCtx, fakeSessionQuery, sessionRecord, userMessage } from "./helpers.mjs";

const ME = "synthetic-current";
const AGENT = { id: ME };
const CONFIG = normalizeConfig();
const PASSWORD = "b8R!" + "9qS2";
const URL = `https://alice:${PASSWORD}@example.invalid/repo`;
const JSON_SECRET = "Z9synthetic" + "!42";
const doc = (text, extra = {}) => ({ sessionId: ME, seq: 1, type: "user/message", time: 1, surface: "shadowed", text, ...extra });
function setup(overrides = {}, config = {}) {
	const fake = fakeSessionQuery(overrides);
	const fixture = fakeCtx({ sessionQuery: fake.sq });
	apply(fixture.ctx, config);
	return { ...fixture, ...fake };
}
function indexHit(seq = 1, id = ME, snippet = PASSWORD) {
	return { header: { id, cwd: "C:\\work", createdAt: 1 }, live: true, persisted: false,
		bestMatch: { sessionId: id, seq, type: "user/message", time: 1, surface: "shadowed", snippet } };
}
function boundaryText(width, prefix = "") {
	const padding = width - prefix.length - URL.indexOf("@");
	assert.ok(padding > 0);
	return prefix + "a".repeat(padding - 1) + " " + URL;
}
function assertAbsent(value, secret = PASSWORD) {
	assert.equal(JSON.stringify(value).includes(secret), false, "synthetic secret must not survive any output field");
}

for (const type of ["user/message", "assistant/message"]) {
	test(`complete ${type} is redacted before the 80-character skeleton cut`, () => {
		const context = createRedactionContext();
		const entry = skeletonEntry(doc(boundaryText(80), { type }), undefined, context);
		assertAbsent(entry);
		assert.ok(entry.line.includes(MASK));
		const output = publish(entry.line, { redaction: context });
		assert.equal(output.redacted, 1, "source redaction count must survive final publication");
	});
}

test("complete tool arguments are redacted before the 60-character target cut", () => {
	const text = "read\n" + boundaryText(60, '{"url":"') + '"}';
	const entry = skeletonEntry(doc(text, { type: "tool/call" }));
	assertAbsent(entry);
	assert.ok(entry.line.includes(MASK));
});

test("complete tool result is redacted before the 40-character outcome cut", () => {
	const entry = skeletonEntry(doc('read\n{"file_path":"sample.txt"}', { type: "tool/call" }),
		doc(boundaryText(40), { seq: 2, type: "tool/result" }));
	assertAbsent(entry);
	assert.ok(entry.line.includes(MASK));
});

test("multiline private-key body is removed before assistant first-line selection", () => {
	const head = "-----BEGIN " + "RSA PRIVATE " + "KEY-----";
	const tail = "-----END " + "RSA PRIVATE " + "KEY-----";
	const body = "SYNTHETIC_KEY_BODY_123";
	const entry = skeletonEntry(doc(`${head}\n${body}\n${tail}`, { type: "assistant/message" }));
	assertAbsent(entry, body);
	assert.ok(entry.line.includes(MASK));
});

test("scan sanitizes full text before its 240-character excerpt", async () => {
	const fixture = setup({
		async listSessions() { return [sessionRecord(ME)]; },
		async filterEvents() { return [doc(boundaryText(240))]; }
	});
	const value = await fixture.tools.get("recall_history").execute({ query: "a" }, { agent: AGENT });
	assert.equal(value.ok, true);
	assertAbsent(value);
	assert.equal(value.published.redacted, 1);
});

test("query-centered safeSnippet finds late text and preserves Unicode within 240 units", () => {
	for (const prefix of ["ordinary ".repeat(200), "😀".repeat(200)]) {
		const text = prefix + "needle " + "suffix 😀 ".repeat(100);
		const snippet = safeSnippet(text, "needle");
		assert.ok(snippet.includes("needle"));
		assert.ok(snippet.length <= 240);
		assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(snippet), false);
	}
});

test("index fragments are replaced by exact, complete semantic text before publication", async () => {
	const reads = [];
	const fixture = setup({
		async searchSessions() { return { items: [indexHit()] }; },
		async filterEvents(id, filters) { reads.push({ id, filters }); return [doc(boundaryText(240))]; }
	});
	const value = await fixture.tools.get("recall_history").execute({ query: "a" }, { agent: AGENT });
	assert.equal(value.mode, "index");
	assertAbsent(value);
	assert.equal(value.published.redacted, 1);
	assert.deepEqual(reads, [{ id: ME, filters: [{ kind: "seq", from: 1, to: 1 }] }]);
});

for (const mode of ["failure", "wrong-session", "wrong-seq", "missing"]) {
	test(`index hydration ${mode} omits unsafe raw snippet without echoing backend data`, async () => {
		const fixture = setup({
			async searchSessions() { return { items: [indexHit()] }; },
			async filterEvents() {
				if (mode === "failure") throw new Error(`password=${JSON_SECRET}`);
				if (mode === "missing") return [];
				return [doc(PASSWORD, mode === "wrong-session" ? { sessionId: "outside-synthetic" } : { seq: 2 })];
			}
		});
		const value = await fixture.tools.get("recall_history").execute({ query: "a" }, { agent: AGENT });
		assertAbsent(value);
		assertAbsent(value, JSON_SECRET);
		assert.ok(value.published.text.includes("摘要已省略"));
		assert.ok(value.published.text.includes("seq=1"));
	});
}

test("index rejects mismatched header/event identity before any hydration", async () => {
	let reads = 0;
	const hit = indexHit(); hit.bestMatch.sessionId = "outside-synthetic";
	const fixture = setup({ async searchSessions() { return { items: [hit] }; }, async filterEvents() { reads += 1; return []; } });
	const value = await fixture.tools.get("recall_history").execute({ query: "a" }, { agent: AGENT });
	assert.equal(reads, 0);
	assertAbsent(value, "outside-synthetic");
});

test("index deduplicates exact identity before reading, preserving distinct events", async () => {
	const reads = [];
	const fixture = setup({
		async searchSessions() { return { items: [indexHit(1), indexHit(1), indexHit(2)] }; },
		async filterEvents(id, filters) { const seq = filters[0].from; reads.push(seq); return [doc("safe", { seq })]; }
	});
	const result = await searchCorpus(fixture.sq, { query: "a" }, { config: CONFIG, sessionId: ME });
	assert.deepEqual(reads, [1, 2]);
	assert.deepEqual(result.hits.map((hit) => hit.seq), [1, 2]);
});

for (const name of ["recall_history", "recall_expand"]) {
	test(`${name} structured error shares safe bounded publication, including malicious code`, async () => {
		const error = new Error(`password=${JSON_SECRET} ` + "ordinary ".repeat(1000));
		error.code = `password=${JSON_SECRET}`;
		const fixture = setup({ async filterEvents() { throw error; }, async readEvent() { throw error; } }, { maxInjectChars: 400 });
		const args = name === "recall_expand" ? { seq: 1 } : {};
		const value = await fixture.tools.get(name).execute(args, { agent: AGENT });
		assert.equal(value.ok, false);
		assertAbsent(value, JSON_SECRET);
		assert.equal(value.error.message, value.published.text);
		assert.ok(value.error.message.length <= 400);
	});
	test(`${name} pre-cancelled compacted request never rejects with raw abort reason`, async () => {
		const controller = new AbortController(); controller.abort(new Error(`password=${JSON_SECRET}`));
		let reads = 0;
		const fixture = setup({ async filterEvents() { reads += 1; return []; } });
		const value = await fixture.tools.get(name).execute({}, { agent: AGENT, signal: controller.signal });
		assert.equal(value.ok, false);
		assert.equal(reads, 0);
		assertAbsent(value, JSON_SECRET);
	});
}

test("strict placeholders preserve complete references but not look-alike real passwords", () => {
	for (const value of ["$TOKEN", "${TOKEN}", "YOUR_TOKEN", "CHANGEME_me", "<your-key-here>", MASK]) {
		assert.equal(looksLikePlaceholder(value), true);
	}
	for (const value of ["Testing42!", "YourPass42!", "$hunter2!", "${TOKEN}tail", "<sensitive42!>", `${MASK}tail`]) {
		assert.equal(looksLikePlaceholder(value), false);
		assertAbsent(redact(`password=${value}`), value);
	}
});

test("Windows usernames are masked in lower-case and JSON-escaped paths", () => {
	for (const path of ["C:\\users\\ExamplePerson\\notes.txt", "C:/USERS/ExamplePerson/notes.txt", JSON.stringify({ file_path: "C:\\Users\\ExamplePerson\\notes.txt" })]) {
		const clean = redact(path);
		assertAbsent(clean, "ExamplePerson");
		assert.ok(clean.text.includes(MASK));
		assert.equal(redact(clean.text).count, 0);
	}
});

test("long usernames and spoken passwords are removed in full without residual tails", () => {
	for (const size of [65, 200]) {
		const value = "a".repeat(size);
		for (const text of [`/home/${value}/notes`, `密码是 ${value}`]) {
			const clean = redact(text);
			assertAbsent(clean, "a".repeat(10));
			assert.equal(redact(clean.text).text, clean.text);
			assert.equal(redact(clean.text).count, 0);
		}
	}
});

test("more than 50 high-entropy secrets do not leave a clear-text tail", () => {
	const key = ["Ab1Cd2Ef3Gh4Ij5K", "l6Mn7Op8Qr9St0Uv"].join("");
	for (const text of [Array(60).fill(key).join(" "), Array(60).fill(`https://example.invalid/${key.slice(0, 22)}`).join(" ")]) {
		const clean = redact(text);
		assertAbsent(clean, key.slice(0, 22));
		assert.ok(clean.count >= 60);
		assert.equal(redact(clean.text).count, 0);
	}
});

test("oversized fields fail closed, including replacement expansion", () => {
	for (const text of ["ordinary ".repeat(Math.ceil(MAX_REDACT_CHARS / 9)) + JSON_SECRET, "/home/a ".repeat(125000)]) {
		const clean = redact(text);
		assert.ok(clean.text.includes("字段过长"));
		assertAbsent(clean, JSON_SECRET);
		assert.ok(clean.text.length < 100);
		assert.equal(redact(clean.text).text, clean.text);
		assert.equal(redact(clean.text).count, 0);
	}
});

test("heading and content share redaction and fit all supported publication budgets", () => {
	for (const maxChars of [201, 250, 300, 400, 700]) {
		for (const kind of ["history", "notice"]) {
			const output = publish("ordinary ".repeat(2000), { maxChars, kind, heading: `password=${JSON_SECRET} ` + "heading ".repeat(100) });
			assertAbsent(output, JSON_SECRET);
			assert.ok(output.chars <= maxChars);
			assert.equal(output.truncated, true);
			if (kind === "history") assert.ok(output.text.includes(`<<<END:${output.token}>>>`));
		}
	}
});

test("index observes cancellation after the last hydration microtask", async () => {
	const controller = new AbortController();
	const fixture = setup({
		async searchSessions() { return { items: [indexHit()] }; },
		async filterEvents() { queueMicrotask(() => queueMicrotask(() => controller.abort())); return [doc("safe")]; }
	});
	const result = await searchCorpus(fixture.sq, { query: "a" }, { config: CONFIG, sessionId: ME, signal: controller.signal });
	assert.equal(controller.signal.aborted, true);
	assert.equal(result.mode, "aborted");
	assert.equal(result.truncatedReason, "abort");
});

test("zero hydration budget publishes locations only, without reading or leaking fragments", async () => {
	let reads = 0;
	const fixture = setup({ async searchSessions() { return { items: [indexHit()] }; }, async filterEvents() { reads += 1; return []; } });
	const result = await searchCorpus(fixture.sq, { query: "a" }, { config: CONFIG, sessionId: ME, scanBudgetMs: 0 });
	assert.equal(reads, 0);
	assertAbsent(result);
	assert.ok(result.hits[0].snippet.includes("摘要已省略"));
});

for (const mismatch of ["header", "event"]) {
	test(`expand refuses ${mismatch} session identity mismatch without echoing content`, async () => {
		const fixture = setup({ async readEvent() {
			return { session: { id: mismatch === "header" ? "outside-synthetic" : ME }, startSeq: 1, endSeq: 1,
				events: [{ seq: 1, sessionId: mismatch === "event" ? "outside-synthetic" : ME, type: "user/message", data: { text: JSON_SECRET } }] };
		} });
		const result = await fixture.tools.get("recall_expand").execute({ seq: 1 }, { agent: AGENT });
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "SESSION_QUERY_SCOPE_MISMATCH");
		assertAbsent(result, JSON_SECRET);
		assertAbsent(result, "outside-synthetic");
	});
}

for (const cancelBefore of [true, false]) {
	test(`automatic recall skips injection on ${cancelBefore ? "pre-existing" : "in-flight"} cancellation`, async () => {
		const controller = new AbortController(); let reads = 0;
		if (cancelBefore) controller.abort();
		const fixture = setup({ async filterEvents() { reads += 1; controller.abort(); return [doc(`password=${JSON_SECRET}`)]; } });
		const decision = { kind: "enter", messages: [userMessage("Memory unlocked")], startsRequestSeries: true };
		const result = await fixture.listeners.get("agent/pre-step")({ agent: AGENT, messages: decision.messages, signal: controller.signal, turn: 1, step: 1 }, async () => decision);
		assert.equal(result, decision);
		assert.equal(reads, cancelBefore ? 0 : 1);
	});
}
