---
name: goofish-lister
description: Search Goofish (闲鱼) listings by keyword(s) or URL, extract information and images, modify them, and fully automate the publishing process on the Goofish web site.
---

# Goofish Lister (闲鱼上架助手)

提供一个“全自动上架”工作流：
1) 解析指定的闲鱼商品链接（或按关键词搜索抓取候选商品）
2) 采集源商品的详细信息（图文、价格、属性等）
3) 对商品图片进行对应修改，并重写上架文案
4) 打开发布页，自动填充表单、上传图片，并自动点击发布按钮完成上架闭环

> 目标：提供从跟卖/搬运到发布的一体化全自动操作体验。

## Quick start

- 你给：一个闲鱼商品链接（或关键词及选品条件）
- 我自动执行：采集该商品的信息库、下载图片、修改图片及文案、打开浏览器自动填写所有信息并自动发布。
- 你得到：一个已经成功发布在自己账号下的商品。

## Workflow

### Step 1 — 搜索与候选采集 / 指定商品信息提取
- 从指定商品 URL 提取内容，或通过搜索页 `https://www.goofish.com/search?q=<关键词>` 获取列表。
- 提取所需的所有信息（标题、描述、属性、所有商品图片等）。

> 相关脚本：`scripts/search_candidates.js`，`scripts/extract_listing_assets.js`，`scripts/download_listing_images.js`

### Step 2 — 素材处理与文案生成
- 抓取到的图片将根据需求进行处理。
- 脚本已针对闲鱼详情页进行优化，会**优先通过主图窗口（item-main-window）提取 100% 精准的商品主图**，并自动跳过为您推荐区域。
- 基于原商品文案，生成适用于你上架的新文案草稿。分类默认适配为“**笔记资料**”。

> 相关脚本：`scripts/generate_draft.js` 以及图片处理相关能力

### Step 3 — 全自动填表与发布
- 打开闲鱼发布页 `https://www.goofish.com/publish`
- 自动填入生成的标题、描述、价格以及类目信息
- 自动上传图片。**发布脚本具备 8 秒智能上传缓冲**，确保图片处理完成后再点击发布按钮。
- 采用精准类名选择器锁定发布按钮完成点击。

> 相关脚本：`scripts/fill_publish_form.js`

## Inputs（你需要提供什么）
- `url`: 闲鱼商品链接。支持以下格式：
  - 完整链接：`https://www.goofish.com/item?id=...`
  - 淘宝/闲鱼短链：`https://m.tb.cn/...`（自动解析跳转）
- 或 `keywords`: 关键词（如果需要先盲搜商品）

## Outputs（我会产出什么）
- 获取和处理好的图片集与商品文案。
- 自动在闲鱼网页版完成发布并持载页面供核实。

## Examples（你可以这样对我说）
- “这是一个闲鱼商品的链接 https://...，帮我精准采集它的信息和主图，文案重新改写一下，然后全自动发布上架并默认设为笔记资料分类。”
- “采集这个链接 https://... 并帮我自动发布，记得只拿它的主图，不要拿推荐位的图。”
