---
name: goofish-lister
description: Accept exactly one Goofish (闲鱼) item URL, run a fixed extract-to-publish pipeline, and publish the listing on Goofish automatically. Use when the user gives a 闲鱼链接 and wants direct automated listing.
---

# Goofish Lister

这个 skill 只支持一种输入：`1 个闲鱼商品链接`。

不要让模型理解复杂参数，不要提供关键词搜索、候选筛选、类目讨论或多分支工作流。默认流程固定，目标是把用户给出的闲鱼链接直接处理并发布。

## Fixed behavior

收到用户消息后，只做这件事：

1. 从消息里提取第一个闲鱼商品链接或短链。
2. 运行固定流水线命令：

```bash
npm run publish:url -- "<用户提供的链接>"
```

3. 固定流程如下，不需要再问用户：
   - 提取商品图文
   - 下载图片并做默认处理
   - 生成新的上架文案
   - 固定类目为 `笔记资料`
   - 自动打开闲鱼发布页并直接点击发布

## Constraints

- 只接受单个链接；如果用户给了多个链接，只取第一个并明确说明。
- 不支持关键词搜索，不支持“帮我找商品”。
- 不需要 AI 理解 `url`、`keywords`、`category`、`price-strategy` 之类的参数。
- 如果消息里没有可用链接，只要求用户补一个明确的闲鱼商品地址。
- 登录态依赖 Playwright 的持久化浏览器 profile / cookie 缓存，不要假设有单独的 API token。
- 如果本地还没有缓存好的闲鱼登录账号，先明确提示用户先登录，不要继续执行发布流水线。
- 登录时让用户按下面方式完成：

```bash
npm run login
```

- 这条命令会用 Playwright 打开一个可见浏览器，并把登录态缓存到本地 profile；用户需要在浏览器里手动登录闲鱼，登录完成后关闭浏览器窗口。
- 只有在 Playwright 缓存的登录态已经准备好的情况下，才执行：

```bash
npm run publish:url -- "<用户提供的链接>"
```

## What to tell the user

- 成功时：说明已经按固定流程执行，并给出发布结果或阻塞点。
- 如果缺少登录缓存：直接提示“请先执行 `npm run login` 登录闲鱼”，并说明这是通过 Playwright 打开的浏览器手动登录，登录态会缓存到本地。
- 失败时：只说明失败在哪一步，以及是否需要用户重新提供链接或重新登录。
