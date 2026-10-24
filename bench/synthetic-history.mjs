/**
 * Zero-dependency, synthetic-only plugin CPU/scheduling benchmark.
 * No real session logs, no network, no installed profile or business services.
 *
 * node --expose-gc --max-old-space-size=384 bench/synthetic-history.mjs
 * Optional: --modules=<local module directory> --label=<label> --samples=5
 * Optional: --out=<new JSON file> (must be inside bench/reports).
 * Samples exclude fixture creation and explicit GC. Fake filtering is timed and
 * reported separately; numbers are NOT measurements of DSH log I/O/replay/FTS.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(repositoryRoot, "bench", "reports");
const options = { modules: resolve(repositoryRoot, "lib"), label: "working-tree", samples: 5, out: undefined };
for (const arg of process.argv.slice(2)) {
	const [key, ...rest] = arg.split("=");
	const value = rest.join("=");
	if (key === "--modules") options.modules = resolve(value);
	else if (key === "--label") options.label = value;
	else if (key === "--samples") options.samples = Number(value);
	else if (key === "--out") options.out = resolve(value);
	else throw new Error(`Unknown benchmark option: ${key}`);
}
assert(Number.isInteger(options.samples) && options.samples >= 3 && options.samples <= 9, "samples must be 3..9");
if (options.out) {
	const rel = relative(outputRoot, options.out);
	assert(rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel), "output must be inside bench/reports");
}
const sourceNames = ["search.js", "recall.js", "redact.js", "publish.js", "normalize.js", "budget.js"];
async function sourceHashes() {
	return Object.fromEntries(await Promise.all(sourceNames.map(async (name) => [name,
		createHash("sha256").update(await readFile(resolve(options.modules, name))).digest("hex")])));
}
const hashesBefore = await sourceHashes();
const load = (name) => import(pathToFileURL(resolve(options.modules, name)).href);
const { searchCorpus, sessionSurfaceDocuments, SCAN_CONCURRENCY, INSPECT_MAX } = await load("search.js");
const { normalizeConfig, renderCompactedBody, renderHistoryBody } = await load("recall.js");
const { redact, MAX_REDACT_CHARS } = await load("redact.js");
const { publish, createRedactionContext } = await load("publish.js");
const config = normalizeConfig({ maxInjectChars: 3000, limit: 5 });
const WORKSPACE = "/synthetic-benchmark/workspace";
const FOREIGN_WORKSPACE = "/synthetic-benchmark/foreign";
const QUERY = "synthetic-needle";
const SECRET = "BenchOnly42!invented";
const ENTROPY = "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL";
const BASE_TIME = 1_700_000_000_000;
const scope = { sessionId: "bench-session-0000", cwd: WORKSPACE };
const started = performance.now();
const MEMORY_LIMIT = 512 * 1024 * 1024;
let sampledRssMax = 0;
let sampledHeapMax = 0;
function memorySample() {
	const usage = process.memoryUsage();
	sampledRssMax = Math.max(sampledRssMax, usage.rss);
	sampledHeapMax = Math.max(sampledHeapMax, usage.heapUsed);
	assert(usage.rss < MEMORY_LIMIT, "sampled RSS exceeded 512 MiB; reduce benchmark scale");
	return { rss: usage.rss, heapUsed: usage.heapUsed, external: usage.external };
}
function guardDuration() {
	assert(performance.now() - started < 55_000, "benchmark exceeded 55-second cooperative budget");
}
function rounded(value) { return Math.round(value * 1000) / 1000; }
function quantile(sorted, p) { return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]; }
function emptyCalls() { return { searchSessions: 0, listSessions: 0, filterEvents: 0, documentsExamined: 0, active: 0, maxActive: 0, fakeFilterMs: 0 }; }
function record(id, index, cwd = WORKSPACE) {
	return { header: { id, cwd, createdAt: BASE_TIME - index * 1000 }, live: index === 0, persisted: true };
}
function doc(id, seq, text, type = "user/message") {
	return { sessionId: id, seq, type, time: BASE_TIME + seq, surface: "shadowed", text };
}
function makeCorpus(sessionCount, perSession, hit = true) {
	const records = [];
	const documents = new Map();
	for (let s = 0; s < sessionCount; s += 1) {
		const id = `bench-session-${String(s).padStart(4, "0")}`;
		records.push(record(id, s));
		const docs = [];
		for (let i = 0; i < perSession; i += 1) {
			const text = hit && i === perSession - 1
				? `${QUERY} synthetic session ${s} event ${i}; password=${SECRET}; ordinary context for testing.`
				: `ordinary synthetic session ${s} event ${i}; no matching search phrase here.`;
			docs.push(doc(id, i, text));
		}
		documents.set(id, docs);
	}
	// A deliberate out-of-workspace decoy must never be hydrated or scanned.
	records.push(record("bench-foreign", sessionCount + 1, FOREIGN_WORKSPACE));
	return { records, documents, totalEvents: sessionCount * perSession };
}
function indexHit(rec, event) {
	return { ...rec, bestMatch: { ...event, snippet: "UNTRUSTED_INDEX_FRAGMENT" } };
}
function fakeService(corpus, indexed, calls) {
	return {
		async searchSessions(request, exec) {
			calls.searchSessions += 1;
			assert.deepEqual(request.sessionFilters, [{ kind: "cwd", values: [WORKSPACE] }]);
			exec?.signal?.throwIfAborted();
			if (!indexed) return { items: [] };
			const items = corpus.records.filter((r) => r.header.cwd === WORKSPACE).slice(0, request.limit)
				.map((r) => indexHit(r, corpus.documents.get(r.header.id).at(-1)));
			items.push(indexHit(corpus.records.at(-1), doc("bench-foreign", 0, "foreign-decoy")));
			return { items };
		},
		async listSessions(signal) {
			calls.listSessions += 1;
			signal?.throwIfAborted();
			return corpus.records;
		},
		async filterEvents(id, filters) {
			assert.notEqual(id, "bench-foreign", "scope escaped into foreign synthetic session");
			calls.filterEvents += 1;
			calls.active += 1;
			calls.maxActive = Math.max(calls.maxActive, calls.active);
			try {
				// One microtask yield exposes scheduling concurrency without fake I/O latency.
				await Promise.resolve();
				const begin = performance.now();
				const docs = corpus.documents.get(id) ?? [];
				calls.documentsExamined += docs.length;
				const clause = filters[0];
				const selected = clause.kind === "seq"
					? docs.filter((d) => d.seq >= clause.from && d.seq <= clause.to)
					: clause.kind === "text" ? docs.filter((d) => d.text.includes(clause.text)) : docs;
				calls.fakeFilterMs += performance.now() - begin;
				return selected;
			} finally { calls.active -= 1; }
		}
	};
}

const measurements = [];
async function measure(name, dimensions, action) {
	guardDuration();
	await action(); // One untimed warmup; its assertions still run.
	const samples = [];
	for (let i = 0; i < options.samples; i += 1) {
		guardDuration();
		if (typeof globalThis.gc === "function") globalThis.gc();
		const before = memorySample();
		const cpuStart = process.cpuUsage();
		const t0 = performance.now();
		const detail = await action();
		const elapsedMs = performance.now() - t0;
		const cpu = process.cpuUsage(cpuStart);
		const after = memorySample();
		samples.push({ elapsedMs: rounded(elapsedMs), cpuMs: rounded((cpu.user + cpu.system) / 1000),
			heapDeltaBytes: after.heapUsed - before.heapUsed, before, after, ...detail });
	}
	const times = samples.map((s) => s.elapsedMs).sort((a, b) => a - b);
	const row = { name, dimensions, samples, medianMs: quantile(times, 0.5), p95Ms: quantile(times, 0.95),
		rssSampleMaxBytes: Math.max(...samples.map((s) => s.after.rss)),
		heapSampleMaxBytes: Math.max(...samples.map((s) => s.after.heapUsed)) };
	measurements.push(row);
	console.log(`${name}: median=${row.medianMs}ms p95=${row.p95Ms}ms calls=${JSON.stringify(samples.at(-1).calls ?? {})}`);
}
async function runSearch(corpus, indexed, limit) {
	const calls = emptyCalls();
	const redaction = createRedactionContext();
	const result = await searchCorpus(fakeService(corpus, indexed, calls), { query: QUERY, limit },
		{ config, ...scope, redaction });
	const output = publish(renderHistoryBody({ ...result, query: QUERY, scope, redaction }), { maxChars: 3000, redaction });
	assert(calls.maxActive <= SCAN_CONCURRENCY);
	assert(!output.text.includes(SECRET));
	assert(!output.text.includes("UNTRUSTED_INDEX_FRAGMENT"));
	assert(!output.text.includes("bench-foreign"));
	assert(output.chars <= 3000);
	return { calls: { ...calls, fakeFilterMs: rounded(calls.fakeFilterMs) }, hits: result.hits.length,
		inspected: result.inspected, candidates: result.candidates, mode: result.mode,
		stoppedAtLimit: result.stoppedAtLimit, truncatedReason: result.truncatedReason ?? null,
		outputChars: output.chars, redacted: output.redacted };
}

for (const count of [1000, 10000]) {
	const corpus = makeCorpus(1, count, false);
	const docs = corpus.documents.get(scope.sessionId);
	for (let i = 0; i < docs.length; i += 1) {
		const type = ["user/message", "tool/call", "tool/result", "assistant/message"][i % 4];
		docs[i].type = type;
		docs[i].text = type === "tool/call"
			? `read\n{"file_path":"/synthetic-benchmark/source-${i}.txt"}`
			: `synthetic event ${i}; password=${SECRET}; ` + "ordinary context ".repeat(12);
	}
	await measure(`skeleton-${count}`, { events: count, perEventApproxChars: 250, pipeline: "fake surface -> render skeleton -> publish" }, async () => {
		const calls = emptyCalls();
		const redaction = createRedactionContext();
		const surface = await sessionSurfaceDocuments(fakeService(corpus, false, calls), scope.sessionId);
		assert.equal(surface.docs.length, count);
		const body = renderCompactedBody({ ...surface, sessionId: scope.sessionId, scope, budget: 3000, redaction });
		const output = publish(body, { maxChars: 3000, redaction });
		assert(!output.text.includes(SECRET));
		assert(output.chars <= 3000);
		return { calls: { ...calls, fakeFilterMs: rounded(calls.fakeFilterMs) }, outputChars: output.chars, redacted: output.redacted };
	});
}
for (const perSession of [1000, 10000]) {
	const corpus = makeCorpus(20, perSession, true);
	for (const indexed of [true, false]) {
		await measure(`${indexed ? "index-hydrate" : "scan"}-20x${perSession}-limit5`,
			{ sessions: 20, eventsPerSession: perSession, totalEvents: corpus.totalEvents, limit: 5,
				index: "precomputed hits; fake filter traverses in-memory docs; no real FTS or replay" },
			() => runSearch(corpus, indexed, 5));
	}
}
{
	const corpus = makeCorpus(150, 1000, true);
	await measure("scan-150x1000-limit20", { sessions: 150, eventsPerSession: 1000, limit: 20 }, () => runSearch(corpus, false, 20));
}
{
	const corpus = makeCorpus(150, 1000, false);
	await measure("scan-150x1000-no-hit-window120", { sessions: 150, eventsPerSession: 1000, limit: 20, expectedWindow: INSPECT_MAX }, async () => {
		const result = await runSearch(corpus, false, 20);
		assert.equal(result.calls.filterEvents, INSPECT_MAX);
		assert.equal(result.hits, 0);
		assert.equal(result.truncatedReason, "window");
		return result;
	});
}
for (const size of [100_000, 900_000]) {
	const text = `${ENTROPY} `.repeat(Math.floor(size / (ENTROPY.length + 1)));
	await measure(`redact-dense-${size}`, { inputChars: text.length, kind: "invented bare high-entropy strings" }, () => {
		const output = redact(text);
		assert(output.count > 50);
		assert(!output.text.includes(ENTROPY));
		return { outputChars: output.text.length, redacted: output.count };
	});
}
{
	const text = "ordinary ".repeat(Math.ceil((MAX_REDACT_CHARS + 1) / 9));
	await measure("redact-oversize-field", { inputChars: text.length, maxFieldChars: MAX_REDACT_CHARS }, () => {
		const output = redact(text);
		assert(output.text.length < 100);
		assert.equal(output.count, 1);
		return { outputChars: output.text.length, redacted: output.count };
	});
}
// Boundary-heavy scenarios are timed, not asserted as protected: this permits
// an honest baseline-before-fix comparison. Only booleans/counts leave the run.
for (const [name, text, needle] of [
	["redact-long-url-userinfo", `https://${"u".repeat(160)}:${"q".repeat(20_000)}@example.invalid/path`, "q".repeat(128)],
	["redact-unclosed-pem-100k", "-----BEGIN " + "PRIVATE KEY-----\n" + "a".repeat(100_000), "a".repeat(128)]
]) {
	await measure(name, { inputChars: text.length, syntheticBoundaryCase: true }, () => {
		const output = redact(text);
		return { outputChars: output.text.length, redacted: output.count, syntheticTailRemains: output.text.includes(needle) };
	});
}

// Deterministic deferred reads verify cancellation/budget semantics without sleeps.
function deferred() {
	let resolvePromise;
	const promise = new Promise((resolveIt) => { resolvePromise = resolveIt; });
	return { promise, resolve: resolvePromise };
}
async function microtasksUntil(predicate, label) {
	for (let i = 0; i < 1000 && !predicate(); i += 1) await Promise.resolve();
	assert(predicate(), `deterministic phase failed: ${label}`);
}
function controlledService(indexed, control) {
	const corpus = makeCorpus(12, 1, true);
	const calls = emptyCalls();
	const service = fakeService(corpus, indexed, calls);
	service.filterEvents = async (id, filters) => {
		assert(corpus.documents.has(id));
		calls.filterEvents += 1;
		calls.active += 1;
		calls.maxActive = Math.max(calls.maxActive, calls.active);
		const gate = deferred();
		control.push({ id, filters, gate });
		try { await gate.promise; return corpus.documents.get(id); }
		finally { calls.active -= 1; }
	};
	return { service, calls };
}
const semantics = [];
for (const indexed of [true, false]) {
	const gates = [];
	const { service, calls } = controlledService(indexed, gates);
	const controller = new AbortController();
	const redaction = createRedactionContext();
	let returned = false;
	const begin = performance.now();
	const pending = searchCorpus(service, { query: QUERY, limit: 10 }, { config, ...scope, redaction, signal: controller.signal })
		.then((value) => { returned = true; return value; });
	if (!indexed) {
		await microtasksUntil(() => gates.length === 1, "scan current-session read");
		gates[0].gate.resolve();
	}
	const expectedStarted = indexed ? 4 : 5;
	await microtasksUntil(() => gates.length === expectedStarted, "four concurrent deferred reads");
	assert.equal(calls.maxActive, 4);
	controller.abort();
	const releaseStart = indexed ? 0 : 1;
	gates[releaseStart].gate.resolve();
	for (let i = 0; i < 20; i += 1) await Promise.resolve();
	assert.equal(returned, false, "must settle remaining in-flight reads before returning");
	assert.equal(gates.length, expectedStarted, "abort must not start more reads");
	for (const entry of gates.slice(releaseStart + 1)) entry.gate.resolve();
	const result = await pending;
	assert.equal(result.mode, "aborted");
	assert.equal(calls.active, 0);
	const snapshot = JSON.stringify({ result, stats: redaction.snapshot(), calls });
	for (let i = 0; i < 50; i += 1) await Promise.resolve();
	assert.equal(JSON.stringify({ result, stats: redaction.snapshot(), calls }), snapshot, "result/statistics changed after return");
	semantics.push({ name: indexed ? "index-cancel-after-four-started" : "scan-cancel-after-current-plus-four",
		elapsedMs: rounded(performance.now() - begin), startedReads: gates.length, maxConcurrency: calls.maxActive,
		mode: result.mode, stableAfterReturn: true, waitsForInflight: true, redacted: redaction.snapshot().count });
}
for (const indexed of [true, false]) {
	const calls = emptyCalls();
	const corpus = makeCorpus(12, 1, true);
	const result = await searchCorpus(fakeService(corpus, indexed, calls), { query: QUERY, limit: 10 },
		{ config, ...scope, scanBudgetMs: 0 });
	assert.equal(calls.filterEvents, 0);
	if (!indexed) assert.equal(result.truncatedReason, "budget");
	else assert(result.hits.every((hit) => hit.snippet.includes("摘要已省略")));
	semantics.push({ name: `${indexed ? "index" : "scan"}-zero-start-budget`, startedReads: 0, mode: result.mode,
		truncatedReason: result.truncatedReason ?? null, omittedSnippets: indexed ? result.hits.length : 0 });
}
// Controlled clock advances only after the first batch is in flight, proving
// start-time budget behavior without waiting eight real seconds.
{
	const realDateNow = Date.now;
	let clock = 1000;
	const gates = [];
	try {
		Date.now = () => clock;
		const { service, calls } = controlledService(true, gates);
		const pending = searchCorpus(service, { query: QUERY, limit: 10 }, { config, ...scope, scanBudgetMs: 5 });
		await microtasksUntil(() => gates.length === 4, "budget first batch");
		clock = 1006;
		for (const entry of gates) entry.gate.resolve();
		const result = await pending;
		assert.equal(gates.length, 4);
		assert.equal(calls.active, 0);
		const omitted = result.hits.filter((hit) => hit.snippet.includes("摘要已省略")).length;
		assert.equal(omitted, 6);
		semantics.push({ name: "index-budget-between-batches", startedReads: 4, maxConcurrency: calls.maxActive,
			omittedSnippets: omitted, controlledClock: true });
	} finally { Date.now = realDateNow; }
}
memorySample();
guardDuration();
const hashesAfter = await sourceHashes();
const report = {
	benchmark: "synthetic-plugin-cpu-and-scheduling", label: options.label, generatedAt: new Date().toISOString(),
	node: process.version, platform: process.platform, arch: process.arch, exposeGc: typeof globalThis.gc === "function",
	durationMs: rounded(performance.now() - started), samplesPerScenario: options.samples, warmupsPerScenario: 1,
	percentileMethod: "nearest rank; with five samples p95 is the observed maximum, not a population latency guarantee",
	scope: "invented sessions within synthetic workspace; foreign decoy must not be read; no real history, network, host service, installed profile, disk log decode or FTS",
	costModel: "index hits precomputed; fake filterEvents linearly traverses in-memory documents. Timings include fake filtering and plugin CPU. No simulated replay/I/O latency. Setup and explicit GC excluded per sample.",
	memory: { sampledRssMaxBytes: sampledRssMax, sampledHeapMaxBytes: sampledHeapMax,
		note: "memoryUsage before/after samples only, NOT an exact peak; resourceUsageMaxRssKiB is process-lifetime OS high-water mark",
		resourceUsageMaxRssKiB: process.resourceUsage().maxRSS },
	sourceHashesBefore: hashesBefore, sourceHashesAfter: hashesAfter,
	sourceStableDuringRun: JSON.stringify(hashesBefore) === JSON.stringify(hashesAfter),
	measurements, semantics
};
if (!report.sourceStableDuringRun) process.exitCode = 2;
if (options.out) {
	await mkdir(dirname(options.out), { recursive: true });
	await writeFile(options.out, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
	console.log(`JSON report: ${options.out}`);
} else console.log(JSON.stringify(report, null, 2));
console.log(`Synthetic only: ${measurements.length} scenarios, ${semantics.length} deterministic checks, elapsed=${report.durationMs}ms, sampledRSS=${rounded(sampledRssMax / 1048576)}MiB, sourceStable=${report.sourceStableDuringRun}`);
