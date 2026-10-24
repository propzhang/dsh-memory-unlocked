# Synthetic history benchmark

[`synthetic-history.mjs`](<synthetic-history.mjs>) measures **plugin CPU and scheduling with a fake in-memory
`sessionQuery`**, not DSH disk-log retrieval, replay, FTS, network latency, or installed-profile behavior.
All events, credentials, paths and identifiers are invented. No real history or external service is read.

## Run

From the repository root, with an existing Node.js runtime:

```sh
node --expose-gc --max-old-space-size=384 bench/synthetic-history.mjs
```

Optional arguments:

- `--samples=5`: 3–9 samples per scenario, after one warmup; default 5.
- `--modules=<directory>`: use an existing local snapshot of the six plugin modules instead of `lib`.
  The snapshot must be ESM and preserve the modules' relative imports. No downloading is performed.
- `--label=<label>`: identify the measured revision.
- `--out=<new-path.json>`: write a new report under `bench/reports/`.
  Existing results are never overwritten; omitting this option prints JSON to standard output.

On Windows, invoke the bundled Node executable by its absolute path if it is not on `PATH`.
The script uses Node built-ins only; no dependency installation or build is needed.

## What it covers

- Skeleton rendering plus publication for 1,000 and 10,000 synthetic events.
- Index + exact-hit hydration versus scan fallback, with 20 sessions of 1,000 or 10,000 events.
- A 150-session scan with `limit=20`, and a no-hit scan reaching the 120-session candidate window.
- Dense synthetic high-entropy values, oversize fields, long URL userinfo and unclosed PEM-shaped input.
- Deterministic deferred promises: at most four concurrent reads, cancellation after reads start,
  draining in-flight reads before returning, and stable results/counters after return.
- Zero start budgets and a controlled clock advancing between batches, without waiting eight real seconds.
- A foreign-workspace decoy that must never be hydrated or scanned.

## Interpretation and limits

The fake index returns precomputed hits. The fake `filterEvents` performs a plain in-memory linear scan
and yields one microtask; its filtering time and document count are recorded. There is no simulated log
validation, JSON decoding, persistence access, FTS search, live observation, or artificial I/O delay.
Index/scan timing differences therefore describe this fixture and the plugin's work, **not host throughput**.

Each scenario reports individual elapsed/CPU samples, median, nearest-rank p95, service-call counts and
memory samples. With five samples, p95 is simply the largest observed sample; it is not a population
latency guarantee. Fixture creation and optional explicit GC are outside per-sample timing, although
fixture memory remains part of process memory. Timing includes assertions and fake service filtering.

Memory is sampled before/after each iteration. The sampled maximum is **not an exact peak**; the report
also includes Node's process-lifetime OS `maxRSS` value in KiB. The script checks a 512 MiB sampled-RSS
ceiling and a 55-second cooperative duration budget. These checks cannot preempt one synchronous call;
use the shown heap limit and an external timeout if running on a substantially slower machine.

Source SHA-256 hashes are captured before and after loading/running the modules. A change during a run
is flagged and produces exit code 2; rerun against stable modules before comparing revisions. The reported
total includes fake fixture creation and explicit GC, but starts after module import; process startup and
module loading are not measured. Keep before/after reports on the same machine and Node version, and
rerun noisy cases.

The two boundary-shaped redaction scenarios record `syntheticTailRemains` without treating it as a
baseline assertion, so two builds can be compared honestly. They are not replacements for the
security regression suite. No report contains the generated source bodies or credentials.

## Compare reports

[`compare.mjs`](<compare.mjs>) reads two reports within `bench/reports/`, checks source stability,
Node version, sample counts and fixture dimensions, and prints a Markdown comparison. An optional third
argument saves it to a **new** file in that same directory:

```sh
node bench/compare.mjs bench/reports/baseline.json bench/reports/final.json bench/reports/comparison.md
```

Both scripts are development-only artifacts; they do not change the package's runtime dependency set
or the running DSH profile. Snapshot modules and report files belong outside the distributable package.
