# dsh-plugin-composer-predict

[![npm](https://img.shields.io/npm/v/dsh-plugin-composer-predict?label=npm&color=2f6fed)](https://www.npmjs.com/package/dsh-plugin-composer-predict)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh](https://img.shields.io/badge/DSH-%5E0.2.1--0-2f6fed)](https://github.com/deepseek-ai/deepseek-harness)

**在输入框里预测你的下一条指令。** 预测结果直接显示成输入框的占位文字，按 `Tab` 变成可编辑的草稿。

> 这是我给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 写的输入框插件之一，另一个是 [Composer History](https://github.com/Dogtiti/dsh-plugin-composer-history)（按 `↑`/`↓` 回溯历史消息）——见文末[更多插件](#更多插件)。

---

## 效果

会话空闲、输入框为空时，原本的提示文字会被替换成一条灰色建议：

```diff
- 发消息或创建任务, / 调用指令, @ 文件或对话
+ 跑一下测试
```

按 `Tab`（或点击）填入输入框，光标在末尾，**不会自动发送**；之后你可以继续编辑、删掉、或重新发送。

建议由**当前会话正在使用的模型**生成，不是模板拼接：

| 场景 | 生成的建议 |
| --- | --- |
| 刚让 AI 改完一个组件的样式 | `跑一下看看效果` |
| AI 汇报「测试失败：3 个用例」 | `先修掉这三个失败用例` |
| 刚建完仓库并发布 | `补一份 README` |

---

## 安装

**市场索引**（推荐）

```
https://raw.githubusercontent.com/Dogtiti/dsh-plugin-composer-predict/main/market-index.json
```

设置 → 插件 → 启用实验性市场 bundle → Discover → 添加上面的地址 → 安装 `dsh-plugin-composer-predict`。
这个索引同时列出了我的两个输入框插件。

**npm**

```bash
npm i dsh-plugin-composer-predict
```

在 DSH 的 Plugins 页用「添加」填包名即可。

**本地目录 / git**

```bash
git clone https://github.com/Dogtiti/dsh-plugin-composer-predict
# Plugins → 添加 → 选这个目录
```

---

## 使用

建议只在下面这些条件**同时成立**时请求并显示：

- 该会话已经完成过至少一轮对话
- 当前不在运行中
- 输入框为空、没有待发送附件、没有已认领的斜杠命令
- 当前不是一次性子会话（只读输入框）

以下情况**不接管**，避免和你的操作打架：

| 情况 | 行为 |
| --- | --- |
| 输入框非空 | 不请求、不显示 |
| 会话正在运行 | 不显示（不打断流式输出） |
| `/` 或 `@` 菜单弹出 | 不显示（不抢输入法和菜单的键） |

---

## 配置

在插件行的 `config` 里改（未声明的键会被忽略）：

```yaml
- insert:
    - id: composer-predict
      name: 'dsh-plugin-composer-predict'
      config:
        model: deepseek-chat
        maxSuggestionChars: 24
```

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉后路由直接返回 503，客户端静默 |
| `provider` / `model` | `''` | 强制指定模型；留空跟随当前会话 |
| `maxContextMessages` | `8` | 送给模型的消息条数（取尾部） |
| `maxMessageChars` | `600` | 单条消息保留的字符数（保留头尾） |
| `maxSuggestionChars` | `32` | 提示模型的目标长度 |
| `maxTokens` | `200` | 预测请求的输出上限 |
| `timeoutMs` | `20000` | 单次预测超时 |
| `cacheTtlMs` | `60000` | 同一会话事件序号下的结果复用时间 |
| `diagnostics` | `false` | 把客户端每次判定写成 `.diagnostics.jsonl`（排障用） |

---

## 工作原理

插件是标准的 DSH bundle，分成两半：

```
┌──────────────── 浏览器 ────────────────┐        ┌───────────── Host ─────────────┐
│ conversation.composer.dock             │        │ POST /api/composer.predict     │
│  · 回合结束（running: true→false）请求  │  HTTP  │  · sessions.get(id)            │
│  · 重绘 [data-composer-placeholder]     │ ─────► │  · session.deriveMessages()    │
│  · 自检：内容 + 计算字号 ≥ 8px           │ ◄───── │  · 当前会话的 provider/model    │
│  · Tab → inputActions.setDraft()        │  JSON  │  · 按 seq 缓存 60s             │
└────────────────────────────────────────┘        └────────────────────────────────┘
```

**为什么重绘占位元素，而不是新画一层？**

宿主的占位元素已经带好了位置（`inset:4px 8px auto 14px`）、字号、行高、省略号和 IME 组合期隐藏。插件只做两件事：

```css
[data-composer-placeholder] { color: transparent }   /* 原文透明 */
[data-composer-placeholder]::after {                 /* 建议叠在同一个盒子上 */
  content: "跑一下测试";
  position: absolute; inset: 0;
  font: inherit;                                     /* 字号永远跟宿主一致 */
}
```

这里**刻意不用 `font-size:0` + 变量恢复字号**——变量一旦解析不出合法长度，文字会变成 0 号字：内容在、看不见。`font: inherit` 没有这个失败模式。

**兜底**：挂载后读一次 `getComputedStyle(target, '::after')`，内容不含建议或字号 < 8px 就自动退回「输入框下方一行」的可见形态，并在控制台打印 `[composer-predict]` 警告。宿主改结构时你会看到降级，而不是以为插件没装。

---

## 隐私与代价

- 预测读取**本会话日志尾部**（用户与助手的文本、工具名、工作目录），发送到**你自己配置的模型服务**——和会话本身用的是同一个模型与凭据。
- 每轮多一次小请求（默认 200 tokens 上限）。不想付这个成本就 `enabled: false`。
- 预测结果**不落盘、不进会话日志**，不会出现在对话里，也不会进入你下一条消息的上下文。

---

## 开发

```bash
node --test "test/*.test.mjs"
# 14 项：提示词拼装、模型路由回退、引号/编号剥离、NONE 处理、缓存失效、
#        开关、CSS 转义、门禁条件、兜底渲染
```

`test/render-proof/` 里有一个脚本：把插件**真实产出**的 CSS 取出来，套到宿主的真实占位结构上，用无头 Chrome 渲染截图，用来核对重绘形状（含「把字号变量设成非法值」的敌意环境）。

---

## 兼容性

- 需要 DSH `^0.2.1-0`（`engines.dsh`）。
- 重绘依赖宿主的 `[data-composer-placeholder]` 标记；缺失时走上面的兜底路径，不影响输入框本身。

---

## 更多插件

我的 DSH 插件都围绕输入框，一个索引装下全部：

| 插件 | 一句话 |
| --- | --- |
| **Composer Prediction**（本仓库） | 预测下一条指令，`Tab` 采纳 |
| [**Composer History**](https://github.com/Dogtiti/dsh-plugin-composer-history) | 按 `↑`/`↓` 按顺序回填本会话发过的消息 |

共用索引（上面两个都能从这里装）：
`https://raw.githubusercontent.com/Dogtiti/dsh-plugin-composer-predict/main/market-index.json`

## 许可

MIT © [Dogtiti](https://github.com/Dogtiti)
