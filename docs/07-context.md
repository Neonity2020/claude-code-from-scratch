# 7. 上下文管理

## 本章目标

防止对话历史超出 LLM 的上下文窗口：4 层分级压缩管道，从轻量级截断到全量摘要逐级递进。

```mermaid
graph TD
    Tool[工具执行结果] --> Persist{"&gt; 30KB?"}
    Persist -->|是| Disk["持久化到磁盘<br/>保留预览+路径"]
    Persist -->|否| Trunc{"&gt; 50K 字符?"}
    Disk --> T1
    Trunc -->|是| Cut["截断：保留头尾"]
    Trunc -->|否| Pass[直接返回]
    Cut --> T1
    Pass --> T1

    T1["Tier 1: Budget<br/>预算截断"] -->|"50-70%: 30K<br/>70-85%: 15K"| T2["Tier 2: Snip<br/>裁剪重复"]
    T2 -->|"同文件重复读取<br/>旧搜索结果"| T3["Tier 3: Microcompact<br/>微压缩"]
    T3 -->|"空闲 &gt;5min<br/>cache 已冷"| T4["Tier 4: Auto-compact<br/>全量摘要"]
    T4 -->|"&gt;85% 窗口"| Summary[LLM 摘要替换]

    style Persist fill:#d4edda
    style Disk fill:#d4edda
    style Trunc fill:#e8e0ff
    style T1 fill:#e8e0ff
    style T2 fill:#e8e0ff
    style T3 fill:#e8e0ff
    style T4 fill:#7c5cfc,color:#fff
    style Summary fill:#7c5cfc,color:#fff
```

## Claude Code 怎么做的

### 上下文构建

每次 API 调用前，Claude Code 把三类信息组装进请求：

**系统提示词**是最稳定的部分，由归属头、工具 schema、安全规则等拼接而成。其中有一个 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 哨兵将其分为静态半区和动态半区——静态半区对所有用户完全相同，标记 `scope: 'global'` 全球共享缓存；动态半区（MCP 工具、语言偏好等）因用户而异，不共享。这让全球数百万用户共享同一份核心系统提示词的缓存，是主要的成本优化手段之一。

**系统/用户上下文**每会话计算一次并 memoize：git 状态（5 个命令并行执行）、CLAUDE.md 文件（从 CWD 向上遍历目录树）、当前日期等。注入顺序是刻意安排的——系统上下文后置于系统提示词，用户上下文前置于消息数组，确保最稳定的内容在最前面，最大化缓存命中。

**消息历史**记录对话中的一切，是压缩管道的主要操作对象。发送给 API 前会经过 `normalizeMessagesForAPI()` 修复格式问题：附件重排序、处理 thinking 块、合并分裂消息、验证 `tool_use`/`tool_result` 配对等。

### 5 级压缩流水线

设计哲学是**渐进式压缩**：先用成本最低的手段，只在必要时才动更重的武器。

**Level 1: Tool Result 预算裁剪** — 工具声明 `maxResultSizeChars`（默认 50K 字符），超限时**持久化到磁盘**，上下文中只保留紧凑引用和 2KB 预览。选择持久化而非截断的原因：数据没有丢失，模型可以随时用 Read 工具读取完整文件。

**Level 2: History Snip** — Feature-gated 功能，裁剪历史中的冗余部分。释放的量会传递给后续 autocompact 的阈值计算，因为 snip 移除消息后最后一条 assistant 消息的 `usage` 仍反映 snip 前的大小，不修正会导致 autocompact 过早触发。

**Level 3: Microcompact** — 清理不再需要的旧工具结果，有两条路径：
- **缓存已冷**（空闲超过 N 分钟）：直接修改消息内容，将旧工具结果替换为占位符。缓存过期了，修改不会造成额外失效。
- **缓存仍热**：使用 API 级的 `cache_edits` 机制在服务端就地删除，完全不修改本地消息，避免缓存前缀失效。

**Level 4: Context Collapse** — 投影式折叠，关键特性是**不修改原始消息**，只创建一个折叠视图。类比数据库 View：底层表不变，查询时看到过滤后的结果。启用时会抑制 Autocompact，避免两者竞争。

**Level 5: Autocompact** — 最后手段，fork 子 Agent 调用 API 生成摘要。触发阈值约 85.5% 上下文利用率。压缩提示词用"分析-摘要"两阶段：先让模型在 `<analysis>` 块推理，再生成标准化的 `<summary>`（9 个部分），最后剥离推理过程只保留摘要——典型的链式思考草稿技术。

### Token 预算与缓存

**Token 估算**从不调用额外 API：用最近一次 API 返回的 `usage` 作为锚点，新增消息用字符数 / 4 粗估。误差从纯估算的 30%+ 降到 <5%。

**Prompt 缓存**脆弱性在于前缀中任何字节变化都会导致失效。Claude Code 在多个层面维护稳定性：静态/动态边界标记、beta header 粘性锁存（一旦发送就持续出现，不随 feature flag 变化）、工具数组末尾打缓存断点、以及断裂检测（`cache_read_input_tokens` 下降 >5% 时自动归因）。

**熔断器**：曾有会话连续 autocompact 失败 3,272 次，浪费大量 API 调用。现在连续 3 次失败后直接停止重试。

## 我们的实现

4 层管道：执行时截断 + Budget + Snip + Microcompact + Auto-compact。

### 第 0 层：执行时截断（truncateResult）

<!-- tabs:start -->
#### **TypeScript**
```typescript
// tools.ts
const MAX_RESULT_CHARS = 50000;

function truncateResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) return result;
  const keepEach = Math.floor((MAX_RESULT_CHARS - 60) / 2);
  return (
    result.slice(0, keepEach) +
    "\n\n[... truncated " + (result.length - keepEach * 2) + " chars ...]\n\n" +
    result.slice(-keepEach)
  );
}
```
#### **Python**
```python
# tools.py
MAX_RESULT_CHARS = 50000

def _truncate_result(result: str) -> str:
    if len(result) <= MAX_RESULT_CHARS:
        return result
    keep_each = (MAX_RESULT_CHARS - 60) // 2
    return (
        result[:keep_each]
        + f"\n\n[... truncated {len(result) - keep_each * 2} chars ...]\n\n"
        + result[-keep_each:]
    )
```
<!-- tabs:end -->

保留头尾而非只保留头部：文件开头有 imports、类定义等结构信息，命令输出的错误摘要通常在最后。

与 Claude Code 的区别：Claude Code 持久化到磁盘，模型后续可用 Read 工具取回完整内容。我们现在也实现了持久化——见下方 persistLargeResult。两层配合、顺序关键：工具层返回**完整**结果，agent 层先用 persistLargeResult 把 >30KB 的结果全量落盘（上下文只留预览），truncateResult 移到 persist **之后**作兜底——只对极端情况（如单行超长的预览消息）生效。注意 truncateResult 不能在工具层先执行：那样落盘的就已经是截断品，信息在持久化前就丢了（这正是 issue #6 修复的 bug）。

### 第 0.5 层：大结果持久化（persistLargeResult）

当工具返回结果超过 30KB 时，将完整内容写入磁盘，上下文中只保留预览和文件路径。模型后续可以用 `read_file` 按需取回完整输出。

```typescript
// agent.ts — persistLargeResult

private persistLargeResult(toolName: string, result: string): string {
  const THRESHOLD = 30 * 1024; // 30 KB
  if (Buffer.byteLength(result) <= THRESHOLD) return result;

  const dir = join(homedir(), ".mini-claude", "tool-results");
  mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${toolName}.txt`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, result);

  const lines = result.split("\n");
  const preview = lines.slice(0, 200).join("\n");
  const sizeKB = (Buffer.byteLength(result) / 1024).toFixed(1);

  return `[Result too large (${sizeKB} KB, ${lines.length} lines). Full output saved to ${filepath}. You can use read_file to see the full result.]\n\nPreview (first 200 lines):\n${preview}`;
}
```

这一层的设计要点：

- **30KB 阈值低于 truncateResult 的 50K 限制**：在截断发生之前先拦截大结果，避免不可逆的信息丢失。如果一个结果有 80KB，persistLargeResult 会先将完整内容保存到磁盘，返回预览；而不是等 truncateResult 把中间部分永久丢弃。
- **200 行预览**：给模型足够的上下文来判断是否需要读取完整输出。大多数情况下，前 200 行已经包含了关键信息（文件列表的开头、搜索结果的前几个匹配、命令输出的主要内容）。
- **可恢复 vs 不可恢复**：这是与 truncateResult 的根本区别。truncateResult 是不可逆的——被截掉的内容永远消失了。persistLargeResult 把数据保存到 `~/.mini-claude/tool-results/{timestamp}-{toolName}.txt`，模型随时可以用 `read_file` 取回。
- **调用时机**：在主循环中每次工具执行完成后、结果添加到消息之前调用。这意味着它在 truncateResult 之前生效——先尝试保存，保存后返回的预览文本通常远小于 50K，不会再触发截断。
- **与 Claude Code 的对齐**：这一设计直接对应 Claude Code 的 Level 1 策略（持久化到磁盘，上下文中只保留引用）。区别在于 Claude Code 用 2KB 预览，我们用 200 行——思路相同，实现简化。

### 第 1 层：Budget — 动态缩减工具结果

随上下文压力动态收紧历史中工具结果的大小：

<!-- tabs:start -->
#### **TypeScript**
```typescript
// agent.ts
private budgetToolResultsAnthropic(): void {
  const utilization = this.lastInputTokenCount / this.effectiveWindow;
  if (utilization < 0.5) return;

  const budget = utilization > 0.7 ? 15000 : 30000;

  for (const msg of this.anthropicMessages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i] as any;
      if (block.type === "tool_result" && typeof block.content === "string"
          && block.content.length > budget) {
        const keepEach = Math.floor((budget - 80) / 2);
        block.content = block.content.slice(0, keepEach) +
          `\n\n[... budgeted: ${block.content.length - keepEach * 2} chars truncated ...]\n\n` +
          block.content.slice(-keepEach);
      }
    }
  }
}
```
#### **Python**
```python
# agent.py
def _budget_tool_results_anthropic(self) -> None:
    utilization = self.last_input_token_count / self.effective_window if self.effective_window else 0
    if utilization < 0.5:
        return
    budget = 15000 if utilization > 0.70 else 30000
    for msg in self._anthropic_messages:
        if msg.get("role") != "user" or not isinstance(msg.get("content"), list):
            continue
        for block in msg["content"]:
            if (isinstance(block, dict) and block.get("type") == "tool_result"
                    and isinstance(block.get("content"), str) and len(block["content"]) > budget):
                keep = (budget - 80) // 2
                block["content"] = (
                    block["content"][:keep]
                    + f"\n\n[... budgeted: {len(block['content']) - keep * 2} chars truncated ...]\n\n"
                    + block["content"][-keep:]
                )
```
<!-- tabs:end -->

第 0 层是一次性的 50K 硬限制；Budget 是每次 API 调用前重算，预算随利用率自动收紧。用双阈值（50%/70%）而非单阈值，是为了在上下文还宽裕时多保留细节。

### 第 2 层：Snip — 替换过时的工具结果

<!-- tabs:start -->
#### **TypeScript**
```typescript
// agent.ts
const SNIPPABLE_TOOLS = new Set(["read_file", "grep_search", "list_files", "run_shell"]);
const SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]";
const KEEP_RECENT_RESULTS = 3;
```
#### **Python**
```python
# agent.py
SNIPPABLE_TOOLS = {"read_file", "grep_search", "list_files", "run_shell"}
SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]"
KEEP_RECENT_RESULTS = 3
```
<!-- tabs:end -->

Snip 策略（利用率 > 60% 时触发）：
- 同一文件被 `read_file` 多次读取 → 只保留最新一次，旧的 snip
- 同类搜索结果超过 3 个 → snip 最旧的
- 最近 3 个 `tool_result` 永远保留

关键点：**只清 `tool_result` 的 content，保留 `tool_use` block 不变**。模型仍能看到"我之前读了 /src/main.ts"，只是看不到内容了——如果需要，可以重新调用 `read_file`。保留元数据比保留数据更重要。

### 第 3 层：Microcompact — 缓存冷启动时激进清理

<!-- tabs:start -->
#### **TypeScript**
```typescript
// agent.ts
const MICROCOMPACT_IDLE_MS = 5 * 60 * 1000;

private microcompactAnthropic(): void {
  if (!this.lastApiCallTime ||
      (Date.now() - this.lastApiCallTime) < MICROCOMPACT_IDLE_MS) return;
  // 除最近 3 个外，所有旧 tool_result → "[Old result cleared]"
}
```
#### **Python**
```python
# agent.py
MICROCOMPACT_IDLE_S = 5 * 60

def _microcompact_anthropic(self) -> None:
    if not self.last_api_call_time or (time.time() - self.last_api_call_time) < MICROCOMPACT_IDLE_S:
        return
    # 除最近 3 个外，所有旧 tool_result → "[Old result cleared]"
```
<!-- tabs:end -->

用时间触发的原因：prompt cache 有 TTL，空闲超过 5 分钟后缓存大概率已过期，继续保留旧消息内容没有成本优势，不如激进清理。

Snip 是选择性的（只替换"过时"结果），Microcompact 是无差别的（除最新 3 个外全清）——更激进，但触发条件更严格。

我们只实现了基于时间的路径。Claude Code 的缓存编辑路径依赖 `cache_edits` API 机制，对教学实现过于复杂。

### 第 4 层：Auto-compact — 全量摘要压缩

#### 触发条件

<!-- tabs:start -->
#### **TypeScript**
```typescript
// agent.ts
private async checkAndCompact(): Promise<void> {
  if (this.lastInputTokenCount > this.effectiveWindow * 0.85) {
    printInfo("Context window filling up, compacting conversation...");
    await this.compactConversation();
  }
}
```
#### **Python**
```python
# agent.py
async def _check_and_compact(self) -> None:
    if self.last_input_token_count > self.effective_window * 0.85:
        print_info("Context window filling up, compacting conversation...")
        await self._compact_conversation()
```
<!-- tabs:end -->

`effectiveWindow = 模型上下文窗口 - 20000`，预留给新一轮输入/输出。对 Claude（200K 窗口），触发点约在 76.5% 总利用率。

> ⚠️ **调用方契约**：`checkAndCompact` 只能在 turn boundary 调用（用户输入 push 进消息数组之后、API 调用之前）。下面的 `compactAnthropic` / `compactOpenAI` 会把消息数组的最后一条当成"已被处理的纯文本 user 消息"——它会先 `slice(0, -1)` 去生成摘要，再在最后把这条消息 append 回来。一旦在 tool 循环中段调用，最后一条会是 `tool_result`（Anthropic）或 `tool` role（OpenAI），slice 后前面 `assistant` 的 `tool_use` / `tool_calls` 失去配对，API 会直接报错。

#### Anthropic 后端压缩

<!-- tabs:start -->
#### **TypeScript**
```typescript
// agent.ts
private async compactAnthropic(): Promise<void> {
  if (this.anthropicMessages.length < 4) return;

  const lastUserMsg = this.anthropicMessages[this.anthropicMessages.length - 1];

  const summaryResp = await this.anthropicClient!.messages.create({
    model: this.model,
    max_tokens: 2048,
    system: "You are a conversation summarizer. Be concise but preserve important details.",
    messages: [
      ...this.anthropicMessages.slice(0, -1),
      {
        role: "user",
        content: "Summarize the conversation so far in a concise paragraph, "
               + "preserving key decisions, file paths, and context needed to continue the work.",
      },
    ],
  });

  const summaryText = summaryResp.content[0]?.type === "text"
    ? summaryResp.content[0].text
    : "No summary available.";

  this.anthropicMessages = [
    {
      role: "user",
      content: `[Previous conversation summary]\n${summaryText}`,
    },
    {
      role: "assistant",
      content: "Understood. I have the context from our previous conversation. "
             + "How can I continue helping?",
    },
  ];

  if (lastUserMsg.role === "user") {
    this.anthropicMessages.push(lastUserMsg);
  }

  this.lastInputTokenCount = 0;
}
```
#### **Python**
```python
# agent.py
async def _compact_anthropic(self) -> None:
    if len(self._anthropic_messages) < 4:
        return

    last_user_msg = self._anthropic_messages[-1]

    summary_resp = await self._anthropic_client.messages.create(
        model=self.model,
        max_tokens=2048,
        system="You are a conversation summarizer. Be concise but preserve important details.",
        messages=[
            *self._anthropic_messages[:-1],
            {"role": "user", "content": "Summarize the conversation so far in a concise paragraph, "
             "preserving key decisions, file paths, and context needed to continue the work."},
        ],
    )
    summary_text = (summary_resp.content[0].text
                    if summary_resp.content and summary_resp.content[0].type == "text"
                    else "No summary available.")

    self._anthropic_messages = [
        {"role": "user", "content": f"[Previous conversation summary]\n{summary_text}"},
        {"role": "assistant", "content": "Understood. I have the context from our previous conversation. How can I continue helping?"},
    ]

    if last_user_msg.get("role") == "user":
        self._anthropic_messages.append(last_user_msg)
    self.last_input_token_count = 0
```
<!-- tabs:end -->

与 Claude Code 的主要差异：Claude Code 用"分析-摘要"两阶段提示词生成更高质量的摘要，压缩后恢复最近 5 个文件和活跃技能，有熔断器防无限循环。我们是简化版——单段摘要、无恢复机制、无熔断。

#### OpenAI 后端压缩

OpenAI 的 system prompt 在消息数组中（`role: "system"`），压缩时需要额外保留：

<!-- tabs:start -->
#### **TypeScript**
```typescript
// agent.ts
private async compactOpenAI(): Promise<void> {
  if (this.openaiMessages.length < 5) return;

  const systemMsg = this.openaiMessages[0];
  const lastUserMsg = this.openaiMessages[this.openaiMessages.length - 1];

  const summaryResp = await this.openaiClient!.chat.completions.create({
    model: this.model,
    max_tokens: 2048,
    messages: [
      { role: "system", content: "You are a conversation summarizer. Be concise but preserve important details." },
      ...this.openaiMessages.slice(1, -1),
      { role: "user", content: "Summarize the conversation so far..." },
    ],
  });

  const summaryText = summaryResp.choices[0]?.message?.content || "No summary available.";

  this.openaiMessages = [
    systemMsg,
    { role: "user", content: `[Previous conversation summary]\n${summaryText}` },
    { role: "assistant", content: "Understood. I have the context..." },
  ];

  if ((lastUserMsg as any).role === "user") {
    this.openaiMessages.push(lastUserMsg);
  }

  this.lastInputTokenCount = 0;
}
```
#### **Python**
```python
# agent.py
async def _compact_openai(self) -> None:
    if len(self._openai_messages) < 5:
        return

    system_msg = self._openai_messages[0]
    last_user_msg = self._openai_messages[-1]

    summary_resp = await self._openai_client.chat.completions.create(
        model=self.model,
        max_tokens=2048,
        messages=[
            {"role": "system", "content": "You are a conversation summarizer. Be concise but preserve important details."},
            *self._openai_messages[1:-1],
            {"role": "user", "content": "Summarize the conversation so far..."},
        ],
    )
    summary_text = summary_resp.choices[0].message.content or "No summary available."

    self._openai_messages = [
        system_msg,
        {"role": "user", "content": f"[Previous conversation summary]\n{summary_text}"},
        {"role": "assistant", "content": "Understood. I have the context..."},
    ]

    if last_user_msg.get("role") == "user":
        self._openai_messages.append(last_user_msg)
    self.last_input_token_count = 0
```
<!-- tabs:end -->

守卫条件是 `< 5` 而非 `< 4`，因为 OpenAI 消息数组最少包含 system + 2 轮对话 + 最新用户消息 = 5 条。

### 手动压缩

```
> /compact
  ℹ Conversation compacted.
```

调用链：`cli.ts` → `agent.compact()` → `compactConversation()` → `compactAnthropic()` / `compactOpenAI()`

### Token 统计与管道编排

每次 API 调用后更新：

<!-- tabs:start -->
#### **TypeScript**
```typescript
this.totalInputTokens += response.usage.input_tokens;
this.totalOutputTokens += response.usage.output_tokens;
this.lastInputTokenCount = response.usage.input_tokens;
```
#### **Python**
```python
self.total_input_tokens += response.usage.input_tokens
self.total_output_tokens += response.usage.output_tokens
self.last_input_token_count = response.usage.input_tokens
```
<!-- tabs:end -->

`lastInputTokenCount` 用于判断是否接近窗口上限；`totalInputTokens` 累计所有调用用于费用估算。我们直接用 API 返回值，比 Claude Code 的锚点+估算方案简单，够用。

4 层在每次 API 调用前顺序执行：

<!-- tabs:start -->
#### **TypeScript**
```typescript
private runCompressionPipeline(): void {
  this.budgetToolResultsAnthropic();   // Tier 1
  this.snipStaleResultsAnthropic();    // Tier 2
  this.microcompactAnthropic();         // Tier 3
}
```
#### **Python**
```python
def _run_compression_pipeline(self) -> None:
    if self.use_openai:
        self._budget_tool_results_openai()
        self._snip_stale_results_openai()
        self._microcompact_openai()
    else:
        self._budget_tool_results_anthropic()
        self._snip_stale_results_anthropic()
        self._microcompact_anthropic()
```
<!-- tabs:end -->

Tier 1-3 在每次 API 调用**前**运行（零 API 成本），Tier 4 在 **turn boundary 触发**——即每次用户输入 push 进消息数组后、`while` 主循环开始前。**不要**把 Tier 4 放在 tool 循环末尾：那时最后一条消息是 `{role: "user", content: [tool_result, ...]}`，`compactAnthropic` 内部的 `slice(0, -1)` 会切断它与前一条 `assistant` 消息里 `tool_use` 的配对，Anthropic API 会以 *"tool_use ids were found without tool_result blocks immediately after"* 拒绝那次 summarize 请求。`lastInputTokenCount` 在新位置仍然有效——它反映上一轮最后一次 API call 的状态，足以判断是否触发。顺序也有意义：Budget 先压缩大结果，让 Snip 的去重判断更准确，Microcompact 最后在时间条件满足时无差别清理。

## 简化对比

| 维度 | Claude Code | mini-claude |
|------|------------|-------------|
| **压缩层级** | 5 级流水线 | 4 层（budget + snip + microcompact + 摘要） |
| **Token 计数** | 锚点+粗估，不额外调 API | 直接用 API 返回的 input_tokens |
| **Budget 触发** | 基于剩余预算 | 50%/70% 双阈值 |
| **Snip 策略** | 选择性裁剪 + cache 感知 | 同文件去重 + 保留最近 3 个 |
| **Microcompact** | 时间路径 + 缓存编辑路径 | 只有 5 分钟空闲触发 |
| **Auto-compact** | 两阶段摘要 + 压缩后恢复 + 熔断器 | 单段摘要，无恢复 |
| **溢出存储** | 磁盘持久化，可按需读取 | 磁盘持久化（>30KB），可按需读取 |

---

> **下一章**：让 Agent 跨会话记住信息——记忆系统。
