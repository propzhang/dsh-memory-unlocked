# Security Policy / 安全政策

## Report privately / 私密报告

**Please do not open a public issue for a suspected security problem. / 疑似安全问题请勿在公开 issue 中披露细节。**

Use [GitHub private vulnerability reporting](<https://github.com/propzhang/dsh-memory-unlocked/security/advisories/new>)
(or the repository's **Security → Report a vulnerability** action). Private advisories are visible to
people authorized to participate in them, not the public issue tracker. If the action is unavailable,
ask the maintainer for a private reporting channel without posting reproduction data publicly.

请使用上面的 GitHub 私密漏洞报告入口。若入口不可用，请仅向维护者询问私密联系渠道，不要先把漏洞复现、会话内容或凭据贴到公开区。

Even in a private report, use **synthetic credentials and invented session content** whenever possible.
Do not attach complete session logs, model conversations, profile exports, `.env` contents or real keys.
Do not rely on this plugin's redaction to sanitize a report automatically. If a real credential has
already been exposed, revoke or rotate it with its issuer; redacting a later recap does not erase the
original log or any earlier disclosure.

即使是私密报告，也优先使用**合成凭据和虚构会话**，不要发送完整会话日志、模型对话、profile 导出、环境变量文件或真实密钥。已泄露的真实凭据应先撤销或轮换；插件不会删除历史原文，也无法撤回先前已经发送的数据。

### Minimal private-report template / 最小私密报告模板

- **Versions / 版本**: DSH Desktop, `@deepseek-ai/*` runtime, Node, plugin version and commit; include the OS.
- **Entry point / 入口**: `recall_history`, `recall_expand`, `/recall`, or automatic recall.
- **Expected boundary / 预期边界**: same-workspace vs other-workspace behavior, or the field expected to be masked.
- **Synthetic reproduction / 合成复现**: the smallest invented events and tool arguments that reproduce the issue.
  Preserve relevant format, length and cut position, not a real secret or private conversation.
- **Observed result / 实际结果**: state whether the issue appears in rendered text, structured return values,
  or both. Supply only the minimum manually reviewed excerpt; remove personal paths, emails, hostnames,
  project names and unrelated business data.
- **Budget and mode / 预算与模式**: index or scan mode, omission/truncation notices, and `redacted` /
  `redactLabels` if relevant. These counters can include processed text later omitted from the output.
- **Impact / 影响**: what an unauthorized caller could learn or cause; distinguish observation from inference.

## What counts as a security issue / 安全问题范围

This plugin retrieves old conversation data into the current model context. Relevant findings include:

1. **Scope escape.** Reading or disclosing a session outside the current workspace, accepting a
   mismatched session/event identity, or claiming a narrower scope than was actually used.
   Scope comes from the host caller context, not recalled text or user-supplied scope parameters.
2. **Unredacted secrets.** A concrete credential shape that survives the source-field and publication
   protections. Include boundary cases where shortening removes the key name or URL structure needed
   for detection. A finite heuristic rule set can miss formats; a reproducible gap is worth reporting.
3. **Unsafe auxiliary outputs.** Raw credentials in headings, notices or structured error values.
   Structured errors must use safe, length-bounded text too, so programmatic callers do not obtain the
   original exception value. A structured-return finding does not by itself establish a session-log
   or model-context disclosure: identify which output actually contains the value.
4. **Boundary or preamble bypass.** Recalled text impersonating the plugin's data boundary or being
   elevated to a genuine instruction. History is labeled as untrusted data and boundary-shaped markers
   are neutralized, but those are defence-in-depth measures, not a proof that every model resists injection.
5. **Self-triggering.** Injected recap text firing automatic recall again, or a recap being treated as
   a fresh human request.

重点包括：跨工作区读取、会话/事件身份不一致、截片前后造成凭据漏出、结构化错误或标题泄露、历史数据越过指令边界，以及自触发。请说明泄露实际出现在哪种输出，不要把所有结构化返回值都等同于模型上下文或会话日志。

## Protection and limitations / 防护与局限

- **Budgets skip whole units; they never weaken redaction.** Time and deterministic limits
  (candidate/event counts and source characters) decide *which* fields get processed; skipped fields
  are dropped entirely, so a call never prints an unredacted prefix of a field it decided not to
  process. Cancelling or sealing a budget can only stop later work — it cannot skip redaction, and a
  sealed budget also rejects publication, so a late task cannot append text after the result exists.
  These bounds count admitted rendering work only: planning still scans, sorts and pairs the whole
  event array synchronously (metadata and lengths), and the synchronous exports have no deadline,
  cancellation or yielding.
- **Sanitize first.** Complete event fields are redacted before whitespace normalization, first-line
  selection, folding and snippets. The final publication pass remains in place. If a field's input or
  replacement text exceeds `1,000,000` UTF-16 code units, the whole field is masked rather than leaking
  an unscanned tail or letting replacement expansion change the outcome on a second pass. The final
  assembled body has the same limit, so multiple large events can cause whole-body masking, including
  location lines. `truncated` tracks output-budget truncation, not this security masking.
- **Long userinfo and private keys.** URL userinfo passwords are matched in full, without a
  fixed-length username or password window. Recognized uppercase PEM markers are scanned forwards;
  unclosed, nested, mismatched or orphan-ended private keys mask the whole field. This intentionally
  loses unrelated text when a boundary is ambiguous. Damaged markers and unknown encodings may escape.
- **Result scope is not storage isolation.** Plugin selection, hydration and returned results are
  workspace-scoped. The official full-text backend may reconcile its entire host corpus before
  applying scope filters; the plugin cannot promise that the underlying host never reads elsewhere.
  Synthetic integration tests must therefore use an independent Context and in-memory sessions,
  not just a synthetic cwd filter on the live global service.
- **No unsafe snippet fallback.** An index hit is hydrated with semantic text matching both its
  `sessionId` and `seq`. If that text cannot be safely obtained, the snippet is explicitly omitted;
  the location remains available for a protected expansion attempt.
- **Statistics are not visible-mask counts.** `redacted` / `redactLabels` count matches in fields
  processed during the call and at the final exit. Later folding, sampling or result limits may hide
  those fields. The counters neither prove complete history coverage nor identify unique secrets.
- **Redaction is not anonymization.** In URL userinfo, the password is masked while the username and
  host may remain. Normal paths, emails, project names and ordinary business content are not guaranteed
  to be removed. Rules can have both false negatives and false positives. URL path/query entropy
  candidates are limited to 160 characters after the scheme delimiter; an unknown bare secret under
  32 characters beyond that window can survive. This is distinct from complete userinfo-password masking.
- **Recall still enters the model context.** The plugin adds no network service or runtime dependency
  and reads only through official `ctx.sessionQuery`. DSH can still send the rendered recalled text to
  its configured model provider and persist rendered content/metadata in session logs. The plugin does
  not change the provider's retention policy, erase source history or make output safe for public release.
- **Budgets are not hard cancellation.** Automatic recall combines the host cancellation signal with
  an eight-second wait timer, skips injection on cancellation/timeout, and cleans up timers/listeners
  while stopping subsequent reads. Index hydration and scanning stop starting reads when their
  respective budgets expire. The host's `filterEvents` API has no cancellation signal; an in-flight
  read may finish before the plugin can observe cancellation. A timer cannot preempt synchronous
  computation either. Slow or partial results alone are not a scope escape, but unsafe fallback or
  falsely claiming complete coverage is a reportable problem.

完整字段先脱敏，再缩短；取不到完整索引正文就明确略去摘要，不以不可信片段兜底。脱敏计数可能含后续省略内容，不是可见掩码数。**URL 密码保护不等于用户名、域名、路径或业务内容匿名化。** 插件不新增外部服务，但召回后的可读文本仍可能经 DSH 发给配置的模型提供方并记入会话日志。8 秒等待/启动预算不代表已有读取可以被硬取消。

长 URL userinfo 的密码完整遮挡；约定格式的私钥标记不完整或不匹配时整字段遮挡，但损坏标记仍可能漏过。URL 路径/查询的高熵检测另有协议头后 160 字符窗口，不能当作全 URL 匿名化。插件限制的是选择、补读和输出范围；宿主全文索引可能先协调整个语料，所以合成验收必须使用独立内存 Context，不能只在真实全局服务上换一个虚构 cwd。

## Expected behavior / 预期行为

- History can contain suspicious instructions. Returning such text as clearly marked untrusted data
  is expected; executing it or allowing it to override higher-priority instructions is not.
- A budget can produce partial search results or omit an oversized field. The output must disclose
  that limitation rather than imply the history was exhaustively checked.
- Redaction cannot cover every unknown credential format. That general limitation is documented;
  a concrete bypass should still be reported privately with a synthetic reproduction.

## Supported versions / 支持版本

This project is at `0.x`. Fixes target the latest release; there are no maintained older branches.
An unreleased source fix is not evidence that an installed profile has been updated. Installation or
reload is a separate action.

目前为 `0.x`，修复面向最新版本，不维护旧分支。未发布源码修复不代表已安装 profile 已更新；安装或重载是另一个需要明确执行的动作。

## License / 许可

The project remains [CC BY-NC-SA 4.0](<LICENSE>): noncommercial and share-alike. Security reports and
fixes are welcome from anyone; the license does not restrict reporting a vulnerability.

本项目许可不变；欢迎安全报告，报告漏洞不受非商业条款限制。
