# Memory Unlocked

![发送「大记忆恢复术」来让 AI 回想起忘记的对话](assets/banner.png)

**简体中文** · [English](#english)

## 一句话说明 / In one sentence

> [!IMPORTANT]
> **中文**：在消息里说 `大记忆恢复术` —— 让 DSH 的 agent 回想起这个工作区之前聊过的内容。
>
> **English**: Say `Memory unlocked` in a message — let a DSH agent recall earlier conversations in this workspace.

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-lightgrey.svg)](<LICENSE>)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](<package.json>)
[测试说明 / Test instructions](#开发)

---

## 简体中文

### 这是什么

DSH 会自动压缩长会话，被压缩掉的内容就从模型上下文里消失了。这个插件通过官方的 `ctx.sessionQuery` 服务，把**当前工作区**里更早的对话找回来。它不读磁盘上的会话文件，也不关心日志格式，所以 DSH 换存储方式不影响它。

零依赖，装上就用。包名 `dsh-memory-unlocked`，插件名 `memory-unlocked`。

### 快速开始

要求：一个带 `ctx.sessionQuery` 的 DSH profile（自带的 `dsh-base` 就够），Node.js 18+。

本包未发布到 npm。可以从 DSH 插件市场安装（收录后），或用 DSH 官方插件管理从本仓库安装：

1. 在插件市场里找到 `dsh-memory-unlocked` 安装；或在插件管理中使用本仓库地址安装到当前 profile。无需手工修改 profile 配置文件或安装依赖。
2. 包里的 [`cordis.patch.yml`](<cordis.patch.yml>) 负责把 `memory-unlocked` 插进组合。
3. 按插件管理返回的应用状态与后续提示操作；只有提示需要时才重载 profile。变更会影响该 profile 的所有会话。

装好后直接说一句：

```text
Memory unlocked 上次那个部署脚本放哪了？
```

或者让模型自己调 `recall_history`。

> 具体安装命令看你的 DSH 版本，用 DSH 自带的插件管理就行——README 里不猜命令。

### 怎么用

#### `recall_history`：先搜一遍

在当前工作区里找。每条命中都带 `seq`，拿去给 `recall_expand` 展开。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `query` | string | 否 | — | 搜什么，最长 500 字符；不给就返回本会话被压缩掉的部分 |
| `limit` | integer | 否 | `5` | 最多几条命中，最大 20 |

排序取决于检索路径，输出会说明模式：

- **索引路径**：使用宿主全文索引的相关性顺序（当前实现为「命中查询词项更多 → 文档更短 → 时间更新」），不是全局按时间倒序；每个会话返回最佳命中。
- **扫描兜底**：先检查当前会话，其余会话按创建时间从新到旧扩张，每个会话取最近一条命中；已检查会话中的命中按时间倒序输出，凑够 `limit` 即停。未检查的候选不参与排序，因此不是全工作区的相关性排名或全量时间排名。

摘要先对完整事件文本脱敏，再优先围绕关键词截取最多 240 个 UTF-16 码元，并避免切断代理对；清洗后找不到关键词时取开头。索引给出的短片段可能已失去密钥周围的判定信息，因此插件会按命中 `seq` 补取完整语义文本，只接受 `sessionId` 与 `seq` 都严格匹配的事件；补取失败或未能在预算内启动时，保留定位并明确「摘要省略」，不直接输出原始索引片段。可用 `recall_expand` 继续尝试展开，展开仍受脱敏与预算约束。

#### `recall_expand`：把原文拿回来

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `seq` | integer | 否 | — | `recall_history` 给的位置；不给就返回被压缩掉的部分 |
| `sessionId` | string | 否 | 当前会话 | 一般不用给；给了必须落在当前工作区内 |
| `before` / `after` | integer | 否 | `3` / `3` | 前后各取几条，最多 50 |

#### `/recall`：给人用的

```text
/recall 部署脚本
```

效果和 `recall_history` 一样。不给关键词会报用法错误，不会假装成功。

#### 自动触发

消息里出现下面任意一个词，这一轮会自动回顾：

| 触发词 | 匹配 |
| --- | --- |
| `Memory unlocked` | 不区分大小写 |
| `大记忆恢复术` | 精确匹配 |
| `DJYHFS` | 精确匹配 |

触发词后面的文字当关键词，只取**第一行 / 第一句**——所以不小心粘一大段文档，也不会把整段都当成查询。没有关键词就给被压缩掉的部分。

同一轮最多注入一次。自动回顾把宿主取消信号与 8 秒等待计时器关联：取消或超时时跳过注入，并停止后续读取；结束时清理计时器和监听器。计时器不能抢占同步计算，也不能硬取消已在飞的 `filterEvents` 读取，因此这不是严格的 8 秒总耗时上限，也不是工具调用的统一超时承诺。

### 它解决什么问题

对话一长，DSH 会压缩会话。压缩之后，模型记得最近发生的事，但更早的细节——尤其是你明确让它记住的东西——就不在上下文里了。

所以这里最值得拿回来的不是「最近几条」（那几条本来就在上下文里，喂回去纯属浪费），而是**被压缩掉的那部分**。带关键词时，在当前工作区的历史中做有界检索；不带关键词时，返回本会话被压缩掉的部分。

### 配置

配置写在 profile 里插入插件的那一行：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 设成 `false` 只关自动触发，工具和 `/recall` 照常可用 |
| `triggers` | 三个内置触发词 | 最多 8 个；也接受单数 `trigger: "…"` |
| `maxInjectChars` | `3000` | 单次注入的字符预算（400–20000） |
| `limit` | `5` | 每次返回几条命中（1–20） |
| `before` / `after` | `3` / `3` | 展开时前后各取几条（0–50） |

**没有范围类配置。** `scope`、`includeSubagents` 写进来也不生效——范围是安全边界，不是开关。

### 安全边界

召回只发生在**当前工作区**：

- 插件只选择、补读并返回这个工作区的会话；不会向调用方开放其它工作区的结果。官方全文索引在执行范围过滤前，可能协调整个宿主语料的索引状态；这不等于宿主底层从未访问其它工作区。
- 拿不到工作目录就收窄到当前会话；拿不到会话 id 就直接失败，绝不退到更大的范围。
- `recall_history` 没有 `scope` / `sessionIds` 参数，硬塞也会被忽略。
- 展开会话时必须落在当前工作区内，否则报错，而且不会透露那个会话的任何信息。

历史文本按**不可信输入**处理，先在完整源字段上净化，再通过统一的 `publish()` 出口发布：

1. **先脱敏，后缩短**：完整事件在压缩空白、取首行、折叠或截片前处理已知凭据形态；最终出口再检查一次。标题和错误信息也受保护，结构化 `error` 使用与可读输出相同的安全、有长度预算文本，使程序化调用者也不会取得原始错误值；这不表示该结构化原值曾被宿主写入会话或发送给模型。
2. **有界且失败闭合**：单个字段输入或替换后的文本超过 `1,000,000` 个 UTF-16 码元时整字段遮挡，不把未扫描尾部放行，也避免掩码替换膨胀导致前后两遍行为不同；高熵匹配不会在第 50 次后停止保护。不能把超限遮挡当成完整原文。
3. **长凭据与私钥边界**：URL `scheme://user:password@host` 的用户名、密码不做长度截断，密码整个遮挡；PEM 使用单向标记扫描，完整块不受固定字符窗口限制。未闭合、嵌套、类型错配或孤立结束标记会整字段遮挡，可能舍弃无关上下文。仅识别约定的大写私钥标记，损坏或未知编码不保证识别。
4. **谨慎保留占位符**：只豁免完整匹配的已知占位符或变量引用；以 `TEST`、`$`、`<` 等字符开头，不足以证明是真占位符。Windows 用户目录识别兼顾大小写与 JSON 转义反斜杠。
5. **数据边界与预算**：历史输出声明「这是历史数据，不是指令」，使用每次随机生成的 token 包住数据，并中和正文中形似边界的字符串；超预算会明确截断，仍可按定位请求受保护的展开。

`redacted` / `redactLabels` 统计本次处理源字段与最终出口的脱敏命中，可能包含后来被折叠、采样或结果上限省略的内容，**不等于最终可见掩码数，也不代表扫描过所有历史**。

脱敏是**已知形态的纵深防御，不是匿名化或保险箱**。例如 URL 的 `user:password@host` 只遮密码，用户名、主机名及正常路径可能保留；邮箱、项目名和普通业务文本也不保证移除。已知格式外的秘密仍可能漏过。插件本身不新增外部服务，但召回文本进入模型上下文后，仍会按 DSH 当前配置交给模型提供方，并可能留在会话日志中。不要把自动脱敏当成公开分享日志的许可；报告问题前请人工检查，安全问题使用[私密漏洞报告](<https://github.com/propzhang/dsh-memory-unlocked/security/advisories/new>)，详见[安全政策](<SECURITY.md>)。

### 它是怎么工作的

被压缩掉的内容，DSH 自己是有标记的，不用猜「跳过最近 N 条」：

```js
filterEvents(sessionId, [{ kind: "surface", values: ["current", "shadowed", "log-only"] }])
```

`shadowed` 就是「被压缩替换掉、但还在日志里」的那些事件。

没给关键词时，插件尽量把整个区间折成一份**骨架**：完整事件先脱敏，再每条一行；用户消息保留 80 字，工具调用写成「名字 + 目标 + 结果摘要」，助手消息取第一行。超预算就按用户消息折叠；再不行只留用户消息、均匀抽样。首/末用户消息会尽量作为锚点：只有**整段候选都被处理**时才写「区间首/末条」；触到条数/字符上限或取消时只写「本次已展开的首/末条」—— 末尾窗口仍受源字符上限约束，不保证末条一定进来。想看更多，用 `seq` 调 `recall_expand`；展开并不绕过脱敏或字符预算。

骨架里会过滤掉宿主自己注入的消息（`role: "user"` 不等于人说的），比如压缩提示、后台任务通知、goal 轮次、团队消息等。

关键词检索仍然是「索引优先、扫描兜底」。索引命中补读最多 4 路并发，8 秒后不再启动新补读；扫描也有候选数与启动时间预算。按 `seq` 过滤虽然只返回选中事件的语义文本，宿主仍可能读取并重放整条会话，所以这是隐私保护换来的额外读取成本，不是恒定时间查询。`filterEvents` 不接收取消信号：插件可在等待返回后检查取消、停止后续工作，但无法硬中断已经开始的读取。

一次调用有一份**共享预算**，检索、骨架渲染、展开、发布都受它约束：工具 20 秒，自动回顾 8 秒。时间之外还有**确定性上界**——骨架最多处理 5000 条候选事件的**前缀**、150 万源字符（触界后**尽力**补读区间末尾 64 条，总处理量可到 5064 条；这个尾窗仍受源字符上限约束，前缀把额度用尽时一条也补不进来），展开最多 40 万源字符。为什么不能只靠时间：一次脱敏、一次宿主日志重放都不可中断，只限时间的话单篇超大文档就能吃掉整份预算。触界时正文会写明「只展开了 N/M 条」及原因；超界的条目整条跳过，不会留下未扫描的半截文本。结果产出后预算即封存，遗留任务不能再补发布或改动脱敏统计。这里的上界按**被准入渲染的条数/字符**计；骨架规划阶段仍会同步 `filter` / `sort` / 工具配对调用方传入的事件数组（只读元数据与长度，成本随事件数增长），同步导出（`renderCompactedBody` / `renderExpandBody`）也只执行这些确定性上限、没有 deadline/取消/让出 —— 因此不宣称「所有代码路径的硬上限」；生产路径走异步入口并共享预算。

### 已知限制

- **全文索引可能没开**：这时退回扫描当前工作区的日志，大历史是秒级；未检查全部候选或预算用尽时会明确说明，不能把部分结果解释成「历史里没有」。
- **索引摘要需要额外读取**：完整文本补取失败时只显示定位和省略提示，不回退到可能泄露半截凭据的索引片段。
- **预算不是硬抢占**：预算只让插件**少启动**后续工作（会话、补读、骨架条目、展开条目），不中断已经在飞的宿主读取；一次 `filterEvents` / `readEvent` 仍可能比预算长，单个超大字段的脱敏也按整段处理（超 100 万字符整段遮挡）。因此不承诺「所有调用都在 N 秒内结束」，也刻意不把墙钟阈值写成 CI 断言。
- **确定性上界 ≠ 全路径硬上限**：异步骨架/展开渲染分别每 16/8 条让出并检查预算，但 `filter` / `sort` / 工具配对等**全量元数据遍历仍同步执行**，成本随宿主已返回的事件数增长，不计入 150 万源字符额度；同步导出只保留确定性条数/字符上限，不接 deadline、取消或让出。这里没有「所有路径的 CPU/内存硬上限」承诺。
- **只管当前工作区**：查不了别的目录，这是设计取舍。
- **离开 DSH 用不了**：没有独立模式，也不直接读会话文件。
- 展开窗口最多前后 50 条，超了会被夹住并说明；展开仍可能因输出预算或超大字段保护而省略内容。
- 脱敏按形态匹配，可能漏报或误报；输出不是匿名化后的可公开数据。URL 路径/查询的高熵候选只检查协议头之后最多 160 字符，窗口外不足 32 字符的未知裸串可能漏过；此限制不适用于上面的完整 `user:password@host` 密码规则。
- 超长保护也适用于拼接后的正文：多条较大事件合并超限时，可能整段遮挡，连定位行也不保留。`truncated` 仅表示输出预算截断；安全遮挡以文本提示和脱敏计数说明。

### 开发

```bash
# 在包根目录
node --test
```

Node 18+、ESM、无依赖、无构建。测试用 `node:test`；别写成 `node --test test/`，Node 24 上会报 `Cannot find module`。

代码都在 [`lib/`](<lib/>)：

| 文件 | 干什么 |
| --- | --- |
| [`index.js`](<lib/index.js>) | 接宿主：两个工具、一个命令、pre-step 钩子，以及范围解析 |
| [`recall.js`](<lib/recall.js>) | 纯函数：配置、校验、请求构造、触发词、渲染 |
| [`search.js`](<lib/search.js>) | 按工作区搜索（索引优先、扫描兜底）与原文展开 |
| [`redact.js`](<lib/redact.js>) | 凭据脱敏 |
| [`publish.js`](<lib/publish.js>) | 唯一的发布出口 |
| [`normalize.js`](<lib/normalize.js>) | 宿主返回值形状归一化 |
| [`budget.js`](<lib/budget.js>) | 单次调用的共享时限与确定性渲染上限 |

### 兼容性与验证

- 在 DSH Desktop（`@deepseek-ai/*` 0.2.x 系列）与 Node 24 上开发并验证；插件零运行时依赖，Node 18+ 可运行。
- `node --test` 覆盖参数校验、范围隔离、脱敏、预算与取消、工具接线；[合成基准](<bench/README.md>)只测插件在假内存服务上的 CPU 与调度，不代表宿主日志 I/O 或 FTS 性能。
- 未在真实会话历史上验收吞吐或检索质量；更换 DSH 版本或索引配置后请重新验证。

```sh
node --test
```

### 设计参考

这里只读研究了以下固定版本的实际源码，借鉴的是渐进检索、输出预算、失败闭合和范围隔离等**抽象实践**；没有复制第三方源码，也没有引入它们的依赖或服务：

- **claude-mem**，提交 `9e4f313a89236f7fb593a639a77ee02e21e94469`：[渐进检索与安全错误输出](<https://github.com/thedotmack/claude-mem/blob/9e4f313a89236f7fb593a639a77ee02e21e94469/src/shared/progressive-search.ts>)、[完整字段脱敏及超限遮挡](<https://github.com/thedotmack/claude-mem/blob/9e4f313a89236f7fb593a639a77ee02e21e94469/src/utils/redaction.ts>)；该版本[许可证为 Apache-2.0](<https://github.com/thedotmack/claude-mem/blob/9e4f313a89236f7fb593a639a77ee02e21e94469/LICENSE>)。
- **mem0**，提交 `0724291bd864cf807e88ee8981c8226644e8fb42`：[身份范围构造](<https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/mem0/memory/main.py>)（`_strip_identity_keys` / `_build_filters_and_metadata` / `_build_session_scope`）及[范围键碰撞测试](<https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/tests/memory/test_session_scope.py>)；该版本[许可证为 Apache-2.0](<https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/LICENSE>)。

- **Gitleaks**：[`Finding.Redact`](<https://github.com/gitleaks/gitleaks/blob/b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b/report/finding.go>) 同时净化结构化字段，提交 `b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b`（[MIT](<https://github.com/gitleaks/gitleaks/blob/b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b/LICENSE>)）。
- **Secretlint**：[消息与结构化数据同步净化](<https://github.com/secretlint/secretlint/blob/97eb5fb97ec47a64d49e8843b7727b280221d53f/packages/%40secretlint/core/src/messages/filter-mask-secrets.ts>)，提交 `97eb5fb97ec47a64d49e8843b7727b280221d53f`（[MIT](<https://github.com/secretlint/secretlint/blob/97eb5fb97ec47a64d49e8843b7727b280221d53f/LICENSE>)）。

不采用向量库、外部服务、模型生成记忆、多租户游标或跨工作区搜索。本插件仍为纯 JavaScript、零运行时依赖，许可不变。源码核验不等于运行过第三方项目或认可其所有安全路径。

### 许可

[CC BY-NC-SA 4.0](<LICENSE>)：可以自由阅读、使用、修改、非商业分享，但要署名、修改版保持同一协议，**不能商用**。商业用途需要单独授权。

署名见 [NOTICE](<NOTICE>)；官方简体中文译本见 [LICENSE.zh](<LICENSE.zh>)，仅供参考，以 [LICENSE](<LICENSE>) 的英文原文为准。

---

## English

[简体中文](#简体中文) · **English**

### What it is

DSH compacts long conversations, and whatever compaction folds away disappears from the model's context. This plugin brings earlier conversations back — scoped to **the current workspace** — through the official `ctx.sessionQuery` service. It never reads session files from disk and doesn't care how they are stored, so a change in DSH's storage format doesn't break it.

Zero dependencies. Package `dsh-memory-unlocked`, plugin id `memory-unlocked`.

### Quick start

Requirements: a DSH profile with `ctx.sessionQuery` (the shipped `dsh-base` is enough), Node.js 18+.

The package is not published on npm. Install it from the DSH plugin market (once listed), or from this repository with DSH's official plugin manager:

1. Install it from the plugin market, or use the plugin manager with this repository URL to install it into the current profile. Do not edit profile files or install dependencies by hand.
2. The bundled [`cordis.patch.yml`](<cordis.patch.yml>) inserts the `memory-unlocked` row.
3. Follow the application status and next steps returned by the plugin manager; reload only if requested. Changes affect all sessions in that profile.

Then just say:

```text
Memory unlocked where did we put that deploy script?
```

or let the model call `recall_history`.

> The exact install command depends on your DSH version. Use DSH's own plugin manager; this README doesn't guess it.

### Usage

#### `recall_history` — search first

Finds matches in the current workspace. Every hit carries a `seq` you can hand to `recall_expand`.

| Parameter | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `query` | string | no | — | What to search for, up to 500 characters; omit it to get what compaction removed from the current session |
| `limit` | integer | no | `5` | Maximum number of hits, up to 20 |

Ordering depends on the retrieval path, which is reported in the output:

- **Index path:** follows the host's full-text relevance order (currently more matched query terms, then shorter documents, then newer time), not a global newest-first order. Each session contributes its best match.
- **Scan fallback:** checks the current session first, then other sessions from newest to oldest by creation time, taking the latest matching event in each. Hits from inspected sessions are returned newest-first, and scanning stops when `limit` is met. Uninspected candidates never enter the ranking, so this is neither a workspace-wide relevance ranking nor an exhaustive time ranking.

Snippets are drawn around the query only after the complete event text has been redacted, with a maximum of 240 UTF-16 code units and without splitting surrogate pairs. If the query cannot be located in the sanitized text, the snippet starts at the beginning. An index snippet may have already lost the surrounding context needed to recognize a secret, so the plugin retrieves the complete semantic text by the hit's `seq` and accepts only an exact `sessionId` and `seq` match. If that read fails or cannot start within budget, it keeps the location and explicitly omits the snippet instead of publishing the raw index fragment. You can still try `recall_expand`; expansion remains subject to redaction and output limits.

#### `recall_expand` — get the original text

| Parameter | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `seq` | integer | no | — | The position reported by `recall_history`; omit it to get the compaction-removed part |
| `sessionId` | string | no | current session | Usually unnecessary; if given it must fall inside the current workspace |
| `before` / `after` | integer | no | `3` / `3` | Events to take before / after, up to 50 each |

#### `/recall` — for humans

```text
/recall deploy script
```

Same as `recall_history`. With no keyword it returns a usage error instead of pretending to succeed.

#### Automatic recall

If a message contains any of the following, the plugin recalls automatically for that turn:

| Phrase | Matching |
| --- | --- |
| `Memory unlocked` | case-insensitive |
| `大记忆恢复术` | literal |
| `DJYHFS` | literal |

Text after the phrase becomes the keyword, and only the **first line / first sentence** is used — so pasting a long document by accident won't turn all of it into a query. With no keyword you get the compaction-removed content.

At most one injection per turn. Automatic recall combines the host's cancellation signal with an 8-second wait timer: cancellation or timeout skips injection and stops subsequent reads, with timer and listener cleanup on exit. The timer cannot preempt synchronous computation or forcibly cancel an in-flight `filterEvents` read. It is therefore not a strict 8-second total-runtime bound or a universal timeout for tool calls.

### Why it exists

Conversations get long, so DSH compacts them. After that the model remembers the recent parts, but older details — especially the things you explicitly asked it to remember — are gone from the context.

So the valuable thing to recover is not "the last N messages" (those are still in context, and feeding them back would be a waste) but **what compaction removed**. A keyword starts a bounded search within the current workspace's history; without one, it returns the compaction-removed part of the current session.

### Configuration

Configure the row that inserts the plugin in the profile:

| Key | Default | Notes |
| --- | --- | --- |
| `enabled` | `true` | Set to `false` to turn off automatic recall only; the tools and `/recall` keep working |
| `triggers` | the three built-ins | Up to 8; a single string `trigger: "…"` is also accepted |
| `maxInjectChars` | `3000` | Character budget per injection (400–20000) |
| `limit` | `5` | Hits returned per recall (1–20) |
| `before` / `after` | `3` / `3` | Events taken on each side when expanding (0–50) |

**There are no scope options.** `scope` and `includeSubagents` do nothing here — scope is a safety boundary, not a switch.

### Safety boundary

Recall only happens inside **the current workspace**:

- The plugin selects, hydrates and returns sessions only from this workspace; it does not expose other workspaces' results. The official full-text backend may reconcile its whole host corpus before applying scope filters. This is not a claim that the underlying host never accesses another workspace.
- If the working directory is unavailable it narrows to the current session; if the session id is unavailable it fails closed instead of widening the scope.
- `recall_history` has no `scope` / `sessionIds` parameters; even if one is sent, it is ignored.
- Expanding another session requires it to be inside the current workspace; otherwise the call fails and reveals nothing about that session.

History is treated as **untrusted input**. Complete source fields are sanitized before shortening, then published through one `publish()` exit:

1. **Redact before shortening:** process recognized credential shapes before collapsing whitespace, taking a first line, folding events or making snippets. The final exit checks again. Headings and errors are protected too: structured `error` uses the same safe, length-bounded text as the readable output, so programmatic callers do not receive the original error value either. This does not imply that the host logged or sent the raw structured value to the model.
2. **Bound work and fail closed:** a field whose input or replacement text exceeds `1,000,000` UTF-16 code units is masked as a whole rather than leaking an unscanned tail; this also prevents replacement expansion from changing the outcome on a second pass. High-entropy protection does not stop after the 50th match. An oversize marker is not a complete copy of the original.
3. **Long credentials and private-key boundaries:** URL `scheme://user:password@host` matching does not truncate usernames or passwords by length, and the complete password is masked. A forward PEM-marker scan covers complete blocks without a fixed character window. Unclosed, nested, mismatched or orphan end markers mask the entire field, sacrificing unrelated context when necessary. Only recognized uppercase private-key markers are covered; damaged markers or unknown encodings are not guaranteed.
4. **Keep only explicit placeholders:** exemptions require a complete recognized placeholder or variable reference; a `TEST`, `$` or `<` prefix alone is not enough. Windows user-directory matching handles case differences and JSON-escaped backslashes.
5. **Data boundaries and budgets:** historical output is labeled as data, not instructions, and enclosed by a random per-call token after neutralizing boundary-shaped strings inside it. Truncation is stated explicitly; locations remain available for a protected expansion request.

`redacted` / `redactLabels` count matches in source fields processed during this call and at the final exit. They can include content later omitted by folding, sampling or result limits. They **do not count just the visible masks, and do not imply that all history was scanned**.

Redaction is **known-pattern defence in depth, not anonymization or a vault**. In URL userinfo such as `user:password@host`, only the password is masked; usernames, hostnames and ordinary paths may remain. Emails, project names and ordinary business text are not guaranteed to be removed. Unknown secret formats can still leak. The plugin adds no external service, but recalled text becomes model context and can reach the configured model provider and session logs through DSH. Do not treat automatic redaction as permission to publish logs. Review reports manually, use [private vulnerability reporting](<https://github.com/propzhang/dsh-memory-unlocked/security/advisories/new>) for security issues, and read the [security policy](<SECURITY.md>).

### How it works

Compaction-removed events are already marked by DSH, so there is no need to guess "skip the last N":

```js
filterEvents(sessionId, [{ kind: "surface", values: ["current", "shadowed", "log-only"] }])
```

`shadowed` is exactly "replaced by compaction but still in the log".

Without a keyword, the plugin tries to fold the whole range into a **skeleton**: redact complete events first, then render one line per event; user messages quoted to 80 characters; each tool call as its name + target + a result excerpt; assistant messages shortened to their first line. Over budget it folds by user message; if that still doesn't fit it keeps user messages only, then samples evenly. The first and last user messages are used as anchors where available: the body says **range first/last** only when the whole candidate range was processed; on a count/character/cancellation bound it says **first/last expanded this round**, because the tail window is still subject to the source-character cap and cannot guarantee the closing anchor. Request more with `recall_expand` by `seq`; expansion does not bypass redaction or character budgets.

Host-injected messages are filtered out of the skeleton (`role: "user"` doesn't mean a human wrote it), such as compaction notices, background-job notices, goal rounds and team messages.

Keyword retrieval remains index-first with a scan fallback. Index snippet hydration runs at most 4 reads concurrently and stops starting new reads after 8 seconds; scanning also has candidate and start-time budgets. Filtering by `seq` returns only the selected semantic event, but the host may still read and replay the complete session. That extra work is a privacy trade-off, not a constant-time lookup. `filterEvents` does not accept a cancellation signal: the plugin checks cancellation after awaiting it and stops subsequent work, but cannot forcibly interrupt a read already in flight.

One call shares a single **budget** across retrieval, skeleton rendering, expansion and publication: 20 seconds for tools, 8 seconds for automatic recall. Besides time there are **deterministic bounds** — the skeleton processes at most a 5,000-candidate prefix and 1,500,000 source characters (after hitting a bound it *tries* the last 64 candidates, so up to 5,064 candidates total; that window is still subject to the source-character cap, so it may admit none), and expansion is capped at 400,000 source characters. Time alone is not enough: a single redaction pass or one host log replay cannot be interrupted, so one huge field could consume the whole budget. When a bound is reached the body states how many candidates it actually rendered and why; candidates beyond it are skipped whole, never partially printed before redaction. The budget is sealed once the result exists, so late tasks can neither publish nor change redaction statistics. These bounds count **admitted rendering work**: planning still scans, sorts and pairs the whole event array the host returned (metadata and lengths only) synchronously, so that cost grows with the event count and is not charged to the character cap. The synchronous exports (`renderCompactedBody` / `renderExpandBody`) enforce only these deterministic caps and have no deadline, cancellation or yielding; production uses the async entries. This is therefore not a hard bound on every code path.

### Known limitations

- **The full-text index may be disabled.** Recall then scans this workspace's logs, which takes seconds on a large history. Uninspected candidates or exhausted budgets are reported; partial results do not establish that something never appeared in history.
- **Index snippets require extra reads.** If the full text cannot be retrieved, the result keeps its location and an omission notice instead of falling back to a potentially unsafe credential fragment.
- **Budgets are not hard preemption.** A budget only stops the plugin from *starting* further work (sessions, hydration reads, skeleton entries, expansion entries); it cannot interrupt a host read already in flight. One `filterEvents` / `readEvent` may outlast the budget, and a single oversize field is redacted as a whole (anything above 1,000,000 characters is masked entirely). The plugin therefore does not promise "every call finishes within N seconds", and deliberately does not assert wall-clock thresholds in CI.
- **Deterministic bounds are not a whole-path hard limit.** Async skeleton/expansion rendering yields every 16/8 entries and checks the budget, but the full-array filter/sort/tool pairing still runs synchronously (metadata and lengths only), grows with the event count the host returned, and is not counted against the 1,500,000-character cap. Synchronous exports keep only the deterministic count/character caps, with no deadline, cancellation or yielding. No CPU/memory hard bound is claimed for every code path.
- **Current workspace only.** Other directories are out of reach — a deliberate trade-off.
- **It only works inside DSH.** There is no standalone mode or direct reading of session files.
- Expansion windows are capped at 50 events on each side; values above that are clamped and reported. Output budgets and oversize-field protection can still omit content.
- Redaction is shape-based and can have false negatives or positives; its output is not anonymized public data. URL path/query entropy candidates are checked only within 160 characters after the scheme delimiter; unknown bare values shorter than 32 characters beyond that window can survive. This is separate from the complete `user:password@host` password rule above.
- Oversize protection also applies to the assembled body: several large events may trigger whole-body masking, including location lines. `truncated` refers only to output-budget truncation; security masking is disclosed by its text marker and redaction statistics.

### Development

```bash
# from the package root
node --test
```

Node 18+, ESM, no dependencies, no build step. Tests use `node:test`; don't run `node --test test/` — Node 24 fails with `Cannot find module`.

All code lives in [`lib/`](<lib/>):

| File | Purpose |
| --- | --- |
| [`index.js`](<lib/index.js>) | Host wiring: two tools, one command, the pre-step hook, and scope resolution |
| [`recall.js`](<lib/recall.js>) | Pure functions: config, validation, request building, trigger detection, rendering |
| [`search.js`](<lib/search.js>) | Workspace-scoped search (index first, scan fallback) and drill-down |
| [`redact.js`](<lib/redact.js>) | Credential redaction |
| [`publish.js`](<lib/publish.js>) | The single publication exit |
| [`normalize.js`](<lib/normalize.js>) | Normalization of host service return shapes |
| [`budget.js`](<lib/budget.js>) | Shared per-call deadline and deterministic rendering bounds |

### Compatibility and validation

- Developed and verified on DSH Desktop (`@deepseek-ai/*` 0.2.x line) with Node 24; the plugin has no runtime dependencies and runs on Node 18+.
- `node --test` covers argument validation, scope isolation, redaction, budget/cancellation and tool wiring; the [synthetic benchmark](<bench/README.md>) measures plugin CPU and scheduling over a fake in-memory service, not host log I/O or FTS.
- Throughput and recall quality were not validated against real session histories. Re-validate after changing DSH versions or index configuration.

```sh
node --test
```

### Design references

The following pinned versions were reviewed at source level. Only **abstract practices** — progressive retrieval, bounded outputs, fail-closed handling and scope isolation — were adapted. No third-party source was copied, and none of their services or dependencies were added:

- **claude-mem**, commit `9e4f313a89236f7fb593a639a77ee02e21e94469`: [progressive retrieval and safe error output](<https://github.com/thedotmack/claude-mem/blob/9e4f313a89236f7fb593a639a77ee02e21e94469/src/shared/progressive-search.ts>), [complete-field redaction and oversize masking](<https://github.com/thedotmack/claude-mem/blob/9e4f313a89236f7fb593a639a77ee02e21e94469/src/utils/redaction.ts>); [Apache-2.0 at that commit](<https://github.com/thedotmack/claude-mem/blob/9e4f313a89236f7fb593a639a77ee02e21e94469/LICENSE>).
- **mem0**, commit `0724291bd864cf807e88ee8981c8226644e8fb42`: [identity-scope construction](<https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/mem0/memory/main.py>) (`_strip_identity_keys` / `_build_filters_and_metadata` / `_build_session_scope`) and [scope-key collision tests](<https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/tests/memory/test_session_scope.py>); [Apache-2.0 at that commit](<https://github.com/mem0ai/mem0/blob/0724291bd864cf807e88ee8981c8226644e8fb42/LICENSE>).

- **Gitleaks**: [`Finding.Redact`](<https://github.com/gitleaks/gitleaks/blob/b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b/report/finding.go>) sanitizes structured fields together, commit `b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b` ([MIT](<https://github.com/gitleaks/gitleaks/blob/b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b/LICENSE>)).
- **Secretlint**: [message and structured-data masking](<https://github.com/secretlint/secretlint/blob/97eb5fb97ec47a64d49e8843b7727b280221d53f/packages/%40secretlint/core/src/messages/filter-mask-secrets.ts>), commit `97eb5fb97ec47a64d49e8843b7727b280221d53f` ([MIT](<https://github.com/secretlint/secretlint/blob/97eb5fb97ec47a64d49e8843b7727b280221d53f/LICENSE>)).

Vector stores, external services, model-generated memories, multi-tenant cursors and cross-workspace retrieval were not adopted. This plugin remains plain JavaScript with zero runtime dependencies and the same license. Source inspection does not mean the third-party projects were executed or that all their security paths were endorsed.

### License

[CC BY-NC-SA 4.0](<LICENSE>): read it, use it, modify it, share it non-commercially — with attribution, adaptations under the same license, and **no commercial use**. Commercial use requires a separate license.

Attribution is in [NOTICE](<NOTICE>). An official Simplified Chinese translation is in [LICENSE.zh](<LICENSE.zh>) for readability; the English [LICENSE](<LICENSE>) governs.
