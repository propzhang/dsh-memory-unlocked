/** Compare two local synthetic benchmark reports, never real session data. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "reports");
const [beforeArg, afterArg, outputArg] = process.argv.slice(2);
assert(beforeArg && afterArg, "Usage: node bench/compare.mjs before.json after.json [new-report.md]");
function allowed(path) {
	const value = resolve(path);
	const rel = relative(root, value);
	assert(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), "use files inside bench/reports only");
	return value;
}
const [before, after] = await Promise.all([beforeArg, afterArg].map(async (path) => JSON.parse(await readFile(allowed(path), "utf8"))));
for (const report of [before, after]) {
	assert.equal(report.benchmark, "synthetic-plugin-cpu-and-scheduling");
	assert.equal(report.sourceStableDuringRun, true, "source changed during run; do not compare");
}
assert.equal(before.node, after.node, "different Node runtimes");
assert.equal(before.samplesPerScenario, after.samplesPerScenario, "different sample counts");
const old = new Map(before.measurements.map((row) => [row.name, row]));
const rows = after.measurements.map((row) => {
	const prev = old.get(row.name);
	assert(prev, `missing baseline scenario ${row.name}`);
	assert.deepEqual(prev.dimensions, row.dimensions);
	const sample = row.samples.at(-1);
	return { name: row.name, before: prev.medianMs, after: row.medianMs,
		p95: row.p95Ms, deltaMs: row.medianMs - prev.medianMs,
		deltaPct: prev.medianMs ? (row.medianMs / prev.medianMs - 1) * 100 : null,
		filterCalls: sample.calls?.filterEvents ?? "—", maxActive: sample.calls?.maxActive ?? "—",
		documentsExamined: sample.calls?.documentsExamined ?? "—",
		redacted: sample.redacted,
		tailBefore: prev.samples.at(-1).syntheticTailRemains,
		tailAfter: sample.syntheticTailRemains };
});
const f = (n) => Number(n).toFixed(3);
const mib = (n) => (n / 1048576).toFixed(1);
const lines = [
	"# Synthetic plugin performance comparison", "",
	"**Not a DSH log-I/O benchmark.** All sessions/events are invented. The fake index is precomputed; fake filtering traverses in-memory arrays. No real history, FTS, replay, persisted session, provider, network or installed-profile call is involved.", "",
	`- Baseline label: \`${before.label}\`; timestamp: ${before.generatedAt}`,
	`- Final label: \`${after.label}\`; timestamp: ${after.generatedAt}`,
	`- Node ${after.node}, ${after.platform}/${after.arch}; ${after.samplesPerScenario} measured samples + one warmup per scenario. Explicit GC: ${after.exposeGc}.`,
	"- p95 uses nearest rank; with five samples it is the observed maximum. Small sub-millisecond differences are noisy, not performance guarantees.",
	`- Reported run time (excluding module import/startup): baseline ${f(before.durationMs)} ms; final ${f(after.durationMs)} ms.`,
	`- Sampled RSS maximum: baseline ${mib(before.memory.sampledRssMaxBytes)} MiB; final ${mib(after.memory.sampledRssMaxBytes)} MiB.`,
	`- Sampled heap maximum: baseline ${mib(before.memory.sampledHeapMaxBytes)} MiB; final ${mib(after.memory.sampledHeapMaxBytes)} MiB.`,
	`- Process-lifetime OS RSS high-water: baseline ${(before.memory.resourceUsageMaxRssKiB / 1024).toFixed(1)} MiB; final ${(after.memory.resourceUsageMaxRssKiB / 1024).toFixed(1)} MiB.`,
	"- Before/after memory samples are not exact per-scenario peaks. Fixture generation and explicit GC are excluded from each timed sample, not from reported total time.", "",
	"| Scenario | Baseline median ms | Final median ms | Final p95 ms | Median delta | filterEvents calls | Max concurrent | Fake docs examined |",
	"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
];
for (const row of rows) lines.push(`| ${row.name} | ${f(row.before)} | ${f(row.after)} | ${f(row.p95)} | ${row.deltaPct?.toFixed(1) ?? "n/a"}% (${f(row.deltaMs)} ms) | ${row.filterCalls} | ${row.maxActive} | ${row.documentsExamined} |`);
lines.push("", "## Boundary-shaped synthetic inputs", "", "No source body is stored in the report. These boolean probes are not a substitute for security tests.", "");
for (const row of rows.filter((r) => r.tailAfter !== undefined)) {
	lines.push(`- ${row.name}: synthetic tail remains, baseline **${row.tailBefore}** → final **${row.tailAfter}**; final redaction count ${row.redacted}.`);
}
lines.push("", "## Deterministic scheduling checks", "");
for (const check of after.semantics) lines.push(`- \`${check.name}\`: ${Object.entries(check).filter(([key]) => key !== "name").map(([key, value]) => `${key}=${value}`).join(", ")}.`);
lines.push("", "Deferred reads are released by the harness, not real I/O. Cancellation checks prove no new reads start after cancellation and that already-started reads settle before result/counter stability is checked; they do not establish an 8-second hard limit or force cancellation of host reads.", "", "## Source identity", "", "Hashes were unchanged before/after each run; the baseline is a local frozen module snapshot, not a rollback of production files.", "", "| Module | Baseline SHA-256 | Final SHA-256 |", "| --- | --- | --- |");
for (const [name, hash] of Object.entries(before.sourceHashesBefore)) lines.push(`| ${name} | \`${hash}\` | \`${after.sourceHashesBefore[name]}\` |`);
lines.push("", "## Interpretation", "", "- Index and scan comparisons include different fake filtering work and cannot be extrapolated to real DSH session-query latency. The call counts are more portable than these wall-clock numbers.", "- Scans can start a whole concurrency batch before the hit limit is met; a limit of 20 may therefore read more than 20 sessions. The candidate-window no-hit case should stop at 120.", "- Full-field sanitization/skeleton construction is linear in processed source size and can dominate even when only a small published recap is retained. Existing safe field/output limits remain important.", "- Rerun any apparent regression before acting. This small benchmark does not justify a dependency, cache, scope expansion or bypassing complete-field sanitization.", "");
const text = lines.join("\n");
if (outputArg) await writeFile(allowed(outputArg), text, { flag: "wx" });
console.log(text);
