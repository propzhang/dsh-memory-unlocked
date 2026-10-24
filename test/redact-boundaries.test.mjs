/** Boundary regressions contain synthetic text only; no real keys or sessions. */
import test from "node:test";
import assert from "node:assert/strict";
import { MASK, MAX_REDACT_CHARS, RULES, redact } from "../lib/redact.js";

const begin = (type = "RSA ") => "-----BEGIN " + type + "PRIVATE " + "KEY-----";
const end = (type = "RSA ") => "-----END " + type + "PRIVATE " + "KEY-----";
const body = (length) => "q".repeat(length); // deliberately low entropy: no unrelated fallback may hide a leak
function assertStable(result) {
	const twice = redact(result.text);
	assert.equal(twice.text, result.text);
	assert.equal(twice.count, 0);
	assert.deepEqual(twice.labels, []);
}

for (const [userLength, passwordLength] of [[65, 8], [5, 129], [200, 200], [10000, 10000]]) {
	test(`URL userinfo masks the whole value with username ${userLength} / password ${passwordLength}`, () => {
		const user = "u".repeat(userLength), password = "p".repeat(passwordLength);
		const input = `before https://${user}:${password}@example.invalid/repo after`;
		const result = redact(input);
		assert.equal(result.text, `before https://${user}:${MASK}@example.invalid/repo after`);
		assert.equal(result.count, 1);
		assert.deepEqual(result.labels, ["URL 内嵌凭据×1"]);
		assertStable(result);
	});
}

test("multiple URL credentials and JSON strings retain hosts without leaking value tails", () => {
	const password = "p".repeat(1024) + "SYNTHETIC_TAIL";
	const input = JSON.stringify({ first: `https://alice:${password}@one.invalid/a`, second: `ssh://bob:${password}@two.invalid/b` });
	const result = redact(input);
	assert.ok(!result.text.includes(password));
	assert.ok(!result.text.includes("SYNTHETIC_TAIL"));
	assert.ok(result.text.includes("@one.invalid/a") && result.text.includes("@two.invalid/b"));
	assert.equal(result.count, 2);
	assertStable(result);
});

test("URL references and ordinary no-userinfo links remain readable", () => {
	for (const text of ["https://alice:${TOKEN}@example.invalid/repo", "https://alice:YOUR_TOKEN@example.invalid", "https://example.invalid/" + "a".repeat(5000)]) {
		assert.equal(redact(text).text, text);
	}
});

for (const length of [4000, 4001, 20000]) {
	for (const separator of ["\n", "\r\n", "\\n", " "]) {
		test(`closed PEM length ${length} with separator ${JSON.stringify(separator)} masks body before transforms`, () => {
			const secret = body(length);
			const input = `before ${begin()}${separator}${secret}${separator}${end()} after`;
			const result = redact(input);
			assert.equal(result.text, `before ${MASK} after`);
			assert.equal(result.count, 1);
			assert.deepEqual(result.labels, ["私钥块×1"]);
			assertStable(result);
		});
	}
}

test("separate complete PEM blocks count once each and preserve unrelated text", () => {
	const input = `first ${begin()}\n${body(5000)}\n${end()} middle ${begin("OPENSSH ")}\n${body(8000)}\n${end("OPENSSH ")} last`;
	const result = redact(input);
	assert.equal(result.text, `first ${MASK} middle ${MASK} last`);
	assert.equal(result.count, 2);
	assertStable(result);
});

for (const malformed of [
	`${begin()}\n${body(8000)}`,
	`${begin()}\\n${body(8000)}\\n`,
	`${begin()}\n${body(8000)}\n${end("EC ")}`,
	`${begin()}\n${body(100)}\n${begin("EC ")}\n${body(100)}\n${end("EC ")}`,
	`${body(8000)}\n${end()}`,
	`${begin()}\n${body(20)}\n${end()}\n${begin()}\n${body(8000)}`
]) {
	test(`incomplete or ambiguous PEM fails closed for the complete source field (${malformed.length} units)`, () => {
		const result = redact(`unrelated prefix ${malformed} unrelated suffix`);
		assert.equal(result.text, MASK);
		assert.equal(result.count, 1);
		assert.deepEqual(result.labels, ["私钥头(未闭合)×1"]);
		assertStable(result);
	});
}

test("JSON-escaped incomplete PEM drops the entire field rather than exposing its body", () => {
	const result = redact(JSON.stringify({ key: `${begin()}\n${body(10000)}`, ordinary: "not kept when key boundary is unknown" }));
	assert.equal(result.text, MASK);
	assert.equal(result.count, 1);
	assertStable(result);
});

test("private-key body with known credential-shaped text is processed as one block", () => {
	const synthetic = "gh" + "p_" + "A".repeat(36);
	const result = redact(`before ${begin()}\n${synthetic}\n${end()} after`);
	assert.equal(result.text, `before ${MASK} after`);
	assert.equal(result.count, 1);
	assert.deepEqual(result.labels, ["私钥块×1"]);
	assertStable(result);
});

test("public-key and certificate delimiters are not private-key indicators", () => {
	const text = ["-----BEGIN " + "PUBLIC KEY-----", body(200), "-----END " + "PUBLIC KEY-----"].join("\n");
	assert.equal(redact(text).text, text);
});

test("near-failure URL text with repeated colons and schemes stays unchanged", () => {
	const inputs = [
		" a:".repeat(33333),
		"https://u:" + "a:".repeat(50000),
		"https://alice:ppp".repeat(6000),
		"https://" + "u".repeat(100000),
		"https://u:" + "p".repeat(100000)
	];
	for (const input of inputs) {
		const result = redact(input);
		assert.equal(result.text, input);
		assert.equal(result.count, 0);
	}
});

test("many unterminated private-key starts and overlong fields remain fail closed", () => {
	const starts = (begin() + "\n").repeat(10000) + body(1000);
	const result = redact(starts);
	assert.equal(result.text, MASK);
	assertStable(result);
	const oversized = begin() + body(MAX_REDACT_CHARS);
	const over = redact(oversized);
	assert.ok(over.text.includes("字段过长"));
	assert.ok(over.text.length < 100);
	assertStable(over);
	assert.equal(RULES.length, 15, "keep the existing rule-table contract");
});
