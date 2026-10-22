# dsh-composer-predict

DeepSeek Harness 插件：**根据当前对话预测你的下一条指令**，直接显示成输入框里的灰色占位文字，按 **Tab** 采纳为可编辑的草稿。

A DeepSeek Harness plugin that **predicts your next instruction** from the current conversation and shows it as the composer placeholder. Press **Tab** to turn it into an editable draft.

```
输入框为空、会话空闲时：

  跑一下测试              ← 灰色的预测建议，位置与原生占位文字完全一致
```

## 中文

### 它做什么

会话空闲且输入框为空时，插件取会话日志尾部（最近几条用户/助手消息 + 当前工作目录），用**该会话正在使用的模型**生成一条"用户此刻最可能发送的指令"，并把它重绘进输入框的占位元素。原文案只在你开始输入时才让位，建议随之消失，清空后回来。

- **Tab**：把建议填进输入框（光标在末尾），可继续编辑，不会自动发送。
- 建议是一次很小的独立模型调用（默认最多 200 tokens），**不写入会话日志**，不会在对话里留下痕迹。
- 会话运行中、草稿非空、有附件、或斜杠命令已认领时，不请求也不显示。

### 安装

**从市场索引（推荐）**

1. 在 DSH 中启用市场：设置 → 插件 → 启用实验性的 market bundle（当前版本默认关闭）。
2. Discover → 添加索引地址：
   `https://raw.githubusercontent.com/Dogtiti/dsh-composer-predict/master/market-index.json`
3. 安装 `dsh-composer-predict`。

**本地目录 / git 安装**

在 Plugins 页用"添加"，填入本地目录路径，或
`git+https://github.com/Dogtiti/dsh-composer-predict.git#<commit>`。

### 配置

在 `cordis.patch.yml` 的 `config` 里改（未声明的键会被忽略）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `maxContextMessages` | `8` | 送给模型的消息条数（取尾部） |
| `maxMessageChars` | `600` | 单条消息保留的字符数（保留头尾） |
| `maxSuggestionChars` | `32` | 提示模型的目标长度 |
| `maxTokens` | `200` | 预测请求的输出上限 |
| `timeoutMs` | `20000` | 单次预测超时 |
| `cacheTtlMs` | `60000` | 同一会话事件序号下的结果复用时间 |
| `provider` / `model` | `''` | 强制指定模型；留空跟随当前会话 |
| `diagnostics` | `false` | 把客户端的判定写成 `.diagnostics.jsonl`（排障用） |

```yaml
- insert:
    - id: composer-predict
      name: 'dsh-composer-predict'
      config:
        model: deepseek-chat
        maxSuggestionChars: 24
```

### 隐私与代价

- 预测会读取会话日志尾部（用户与助手的文本、工具名、工作目录），并发送到**你自己配置的模型服务**——和会话本身用的是同一个模型与凭据。
- 每轮对话结束会多一次很小的模型调用（约几百 tokens），可用 `enabled: false` 关闭。
- 预测结果不落盘、不进会话日志。

### 兼容性与实现说明

- 要求 DSH `^0.2.1-0`（`engines.dsh`）。
- 重绘依赖宿主的占位元素标记 `[data-composer-placeholder]`。插件在挂载后**自检**：内容是否含建议、计算字号是否 ≥ 8px；不满足就自动退回输入框下方的一行建议，并在控制台打印 `[composer-predict]` 警告——不会静默失效，也不影响输入框本身。
- 两半结构：Host 半注册 `POST /api/composer.predict`（读会话日志、选模型、带缓存），Client 半注册到 `conversation.composer.dock`，通过 `inputActions.setDraft()` 写入草稿（与手打同一条链路，可撤销、可持久化）。

### 开发

```bash
node --test "test/*.test.mjs"     # 14 项：宿主提示词/路由/缓存 + 客户端门禁/CSS 转义/兜底
```

`test/render-proof/` 里有把插件真实产出的 CSS 套到宿主占位结构上渲染的截图脚本，用来验证重绘形状。

## English

### What it does

When the composer is empty and the session is idle, the plugin reads the tail of the session log (recent user/assistant messages plus the working directory), asks **the model that session already uses** for the user's most likely next instruction, and repaints the composer's own placeholder element with it. The original hint returns as soon as you start typing.

- **Tab** fills the suggestion in as an ordinary editable draft; nothing is sent for you.
- The prediction is one small standalone request (200 tokens by default). It is **never written to the session log**.
- No request and no suggestion while a turn is running, while the draft is non-empty, while attachments are staged, or while a slash command chip is claimed.

### Install

Market index (recommended): enable the experimental market bundle, add
`https://raw.githubusercontent.com/Dogtiti/dsh-composer-predict/master/market-index.json`
in Discover, then install `dsh-composer-predict`.

Or install the bundle from this directory, or from a commit-pinned git spec.

### Privacy and cost

The conversation tail is sent to the model service you configured (the same model and credentials the session itself uses). One extra small request per completed turn; set `enabled: false` to disable. Predictions are not persisted.

### Compatibility

DSH `^0.2.1-0`. The repaint targets the host's `[data-composer-placeholder]` marker; the plugin verifies it after mounting and falls back to a compact row under the composer when the check fails, so a host change degrades visibly instead of silently.

## License

MIT
