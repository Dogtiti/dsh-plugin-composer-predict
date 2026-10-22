# dsh-plugin-composer-predict

[![npm](https://img.shields.io/npm/v/dsh-plugin-composer-predict?label=npm&color=2f6fed)](https://www.npmjs.com/package/dsh-plugin-composer-predict)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh](https://img.shields.io/badge/DSH-%5E0.2.1--0-2f6fed)](https://github.com/deepseek-ai/deepseek-harness)

基于当前对话预测下一条用户指令，直接呈现在输入框的占位文字中；按 `Tab` 采纳为可编辑草稿。

---

## 效果

会话空闲且输入框为空时，原生提示文字被替换为一条建议：

```diff
- 发消息或创建任务, / 调用指令, @ 文件或对话
+ 跑一下测试
```

`Tab` 或点击可填入输入框（光标位于末尾），不会自动发送。

建议由当前会话正在使用的模型生成：

| 上下文 | 建议 |
| --- | --- |
| 刚完成一次代码修改 | `跑一下看看效果` |
| 测试报告显示 3 个失败用例 | `先修掉这三个失败用例` |

---

## 安装

**市场索引**

```
https://raw.githubusercontent.com/Dogtiti/dsh-plugin-composer-predict/main/market-index.json
```

设置 → 插件 → 启用实验性市场 bundle → Discover → 添加上面的地址 → 安装 `dsh-plugin-composer-predict`。

**npm**

```bash
npm i dsh-plugin-composer-predict
```

在 Plugins 页用「添加」填写包名。

**本地目录**

```bash
git clone https://github.com/Dogtiti/dsh-plugin-composer-predict
```

Plugins → 添加 → 选择该目录。

---

## 行为

建议仅在以下条件全部满足时请求并显示：

- 该会话已完成至少一轮对话
- 会话不在运行中
- 输入框为空、无待发送附件、无已认领的斜杠命令
- 非一次性子会话（只读输入框）

不接管的情况：

| 条件 | 行为 |
| --- | --- |
| 输入框非空 | 不请求、不显示 |
| 会话运行中 | 不显示 |
| `/` 或 `@` 菜单弹出 | 不显示 |

---

## 配置

```yaml
- insert:
    - id: composer-predict
      name: 'dsh-plugin-composer-predict'
      config:
        model: deepseek-chat
        maxSuggestionChars: 24
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭后路由返回 503，客户端不再请求 |
| `provider` / `model` | `''` | 指定模型；留空跟随当前会话 |
| `maxContextMessages` | `8` | 送入模型的消息条数（取尾部） |
| `maxMessageChars` | `600` | 单条消息最大字符数（保留头尾） |
| `maxSuggestionChars` | `32` | 建议的目标长度 |
| `maxTokens` | `200` | 输出上限 |
| `timeoutMs` | `20000` | 单次请求超时 |
| `cacheTtlMs` | `60000` | 相同会话事件序号下的缓存时间 |
| `diagnostics` | `false` | 将客户端判定写入 `.diagnostics.jsonl`，用于排障 |

---

## 实现

插件为标准的 DSH bundle，包含 Host 与 Client 两部分：

```
┌──────────────── 浏览器 ────────────────┐        ┌───────────── Host ─────────────┐
│ conversation.composer.dock             │        │ POST /api/composer.predict     │
│  · 回合结束时请求（running: true→false） │  HTTP  │  · sessions.get(id)            │
│  · 重绘 [data-composer-placeholder]     │ ─────► │  · session.deriveMessages()    │
│  · 自检：内容包含建议且字号 ≥ 8px        │ ◄───── │  · 当前会话 provider/model      │
│  · Tab → inputActions.setDraft()        │  JSON  │  · 按 seq 缓存 60s             │
└────────────────────────────────────────┘        └────────────────────────────────┘
```

宿主占位元素已提供定位（`inset:4px 8px auto 14px`）、字号、行高、省略号与 IME 组合期隐藏，插件只改写其内容：

```css
[data-composer-placeholder] { color: transparent }
[data-composer-placeholder]::after {
  content: "跑一下测试";
  position: absolute; inset: 0;
  font: inherit;
}
```

不使用 `font-size: 0` 配合变量恢复字号：变量解析失败时字号会退化为 0，文字存在但不可见。`font: inherit` 不依赖变量。

挂载后读取 `getComputedStyle(target, '::after')` 自检，若内容不含建议或字号小于 8px，回退为输入框下方一行并在控制台输出 `[composer-predict]` 警告。

---

## 数据与开销

- 读取本会话日志尾部（用户与助手文本、工具名、工作目录），发送至会话自身配置的模型服务与凭据。
- 每轮一次独立小请求，默认上限 200 tokens；`enabled: false` 可关闭。
- 结果不落盘，不写入会话日志。

---

## 开发

```bash
node --test "test/*.test.mjs"
```

14 项：提示词拼装、模型路由回退、输出清洗、缓存失效、开关、CSS 转义、门禁条件、兜底渲染。

`test/render-proof/` 将插件实际生成的 CSS 应用于宿主占位结构，用无头 Chrome 渲染并截图，用于核对重绘结果，包含字号变量非法的边界环境。

---

## 兼容性

- DSH `^0.2.1-0`（`engines.dsh`）。
- 依赖宿主占位元素的 `[data-composer-placeholder]` 标记；缺失时走回退路径，不影响输入框本身。

---

## 相关插件

| 插件 | 说明 |
| --- | --- |
| [dsh-plugin-composer-history](https://github.com/Dogtiti/dsh-plugin-composer-history) | 输入框中按 `↑` / `↓` 回填历史消息 |

## 许可

MIT © [Dogtiti](https://github.com/Dogtiti)
