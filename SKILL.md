---
name: goofish-lister
description: Accept exactly one Goofish (闲鱼) item URL, run a fixed extract-to-publish pipeline, and publish the listing on Goofish automatically. Also supports listing cached login accounts and selecting one via natural language when the user specifies it.
---

# Goofish Lister

这个 skill 有两个固定入口：

- `发布 1 个闲鱼商品链接`
- `返回本地已登录的闲鱼账号列表`

不要让模型理解复杂参数，不要提供关键词搜索、候选筛选、类目讨论或多分支工作流。默认流程固定，目标是把用户给出的闲鱼链接直接处理并发布。

额外只允许一个可选维度：`发布账号`。如果用户明确指定“用哪个闲鱼账号发布”，就把它映射成 `--account <账号名>`；否则默认使用 `default`。

这里的“指定账号”允许从自然语言里提取，不要求用户显式说 `--account`。

## Fixed behavior

收到用户消息后，只允许做下面两种事之一：

### A. 用户是在问账号列表

如果用户表达的是这些意图，直接返回已登录账号列表，不要进入发布流程：

- `有哪些闲鱼账号已经登录了`
- `列出已登录账号`
- `看看可用账号`
- `返回账号列表`
- `我现在能用哪个号发`

执行命令：

```bash
npm run accounts
```

告诉用户：

- 返回命令输出里的账号名列表
- 如果列表为空，明确说当前没有检测到已缓存账号，并提示执行 `npm run login -- --account "<账号名>"` 先登录
- 如果用户下一步要发布，再让其直接说“用哪个账号发哪个链接”，或者不给账号则默认 `default`

### B. 用户是在要求发布一个链接

1. 从消息里提取第一个闲鱼商品链接或短链。
2. 如果用户明确指定账号名，提取该账号名；否则账号名固定为 `default`。
3. 运行固定流水线命令：

```bash
npm run publish:url -- --account "<账号名>" "<用户提供的链接>"
```

4. 固定流程如下，不需要再问用户：
   - 提取商品图文
   - 下载图片并做默认处理
   - 生成新的上架文案
   - 固定类目为 `笔记资料`
   - 自动打开闲鱼发布页并直接点击发布

## Account Parsing

把下面这些自然语言表达都视为“指定发布账号”：

- `用 A 号发布`
- `用账号 A 发布`
- `切到 A 这个闲鱼号发`
- `挂到 A 号上`
- `走 A 账号`
- `发布到 A`
- `用默认账号发`
- `用 default 发`

解析规则：

- 优先提取紧邻这些关键词后的账号名：`用`、`账号`、`闲鱼号`、`号`、`发布到`、`走`。
- 账号名按原话提取后，映射成命令里的 `--account <账号名>`。
- 如果用户明确说“默认账号”“默认号”“default”，统一映射成 `default`。
- 如果整条消息里没有明确账号表达，固定使用 `default`。
- 如果用户一次提到多个账号，只取最明确、最靠近“发布/上架/发/挂”动作词的那个；无法判断时不要猜，直接要求用户只指定一个账号。
- 不要把商品标题、店铺名、昵称、链接参数误识别成账号名。
- 不要因为用户提到“帮我发一下”“发布这个”就臆造账号；没有明确账号词就仍然使用 `default`。

示例映射：

- `用 3 号账号发这个 https://...` -> `--account 3`
- `这个链接挂到 sonia 的闲鱼号` -> `--account sonia`
- `帮我用默认账号发布 https://...` -> `--account default`
- `https://...` -> `--account default`

## Constraints

- 只接受单个链接；如果用户给了多个链接，只取第一个并明确说明。
- 如果用户是在问账号列表，不要要求他先给链接。
- 不支持关键词搜索，不支持“帮我找商品”。
- 不需要 AI 理解 `url`、`keywords`、`category`、`price-strategy` 之类的参数；只允许识别一个可选 `account`。
- 如果消息里没有可用链接，只要求用户补一个明确的闲鱼商品地址。
- 登录态依赖 Playwright 的持久化浏览器 profile / cookie 缓存，不要假设有单独的 API token。
- 如果本地还没有缓存好的目标闲鱼登录账号，先明确提示用户先登录，不要继续执行发布流水线。
- 登录时让用户按下面方式完成：

```bash
npm run login -- --account "<账号名>"
```

- 这条命令会用 Playwright 打开一个可见浏览器，并把登录态缓存到本地 profile；用户需要在浏览器里手动登录闲鱼，登录完成后关闭浏览器窗口。
- 只有在 Playwright 缓存的登录态已经准备好的情况下，才执行：

```bash
npm run publish:url -- --account "<账号名>" "<用户提供的链接>"
```

## What to tell the user

- 成功时：说明已经按固定流程执行，并给出发布结果或阻塞点。
- 如果缺少登录缓存：直接提示“请先执行 `npm run login -- --account <账号名>` 登录闲鱼”，并说明这是通过 Playwright 打开的浏览器手动登录，登录态会缓存到对应账号的本地 profile。
- 失败时：只说明失败在哪一步，以及是否需要用户重新提供链接或重新登录。
