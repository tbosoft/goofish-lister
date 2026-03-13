# Goofish Lister (闲鱼上架助手)

这是一个为您提供“全自动跟卖/搬运”体验的 Skill。它能自动解析闲鱼商品，提取精准图文及详情，并协助您快速在自己的账号下完成发布。

## 核心功能
- **精准采集**：自动锁定商品主图，过滤无关推荐位图片。
- **深度处理**：自动处理描述文案，支持图片白底美化。
- **自动化发布**：自动填充表单（标题、描述、分类、价格、预览图），并自动点击发布按钮。
- **分类适配**：默认适配“笔记资料”等常用类目。

## 安装指南

1. **环境准备**：
   确保您的系统中已安装 Node.js。
   
2. **安装依赖**：
   在 `goofish-lister` 目录下运行：
   ```bash
   npm install
   npx playwright install chrome
   ```

3. **初始化登录**：
   首次使用请先运行登录脚本并完成闲鱼网页版扫码登录：
   ```bash
   npm run login
   ```
   注：登录状态将加密保存在本地 `~/.openclaw/goofish-profile` 目录中。

## 使用方法（对 AI 说）

您可以直接对支持 Skill 的 AI 助手说：
- “帮我采集这个闲鱼链接：`https://...`，重新整理图片和文案，全自动帮我发上架。”
- “帮我找一个 Switch OLED 的闲鱼链接，采集信息并自动发布。”

## 开发者说明

- **采集脚本**：`scripts/extract_listing_assets.js`
- **草稿生成**：`scripts/generate_draft.js`
- **发布脚本**：`scripts/fill_publish_form.js`

> [!IMPORTANT]
> 本工具仅供学习与个人效率提升使用，请确保您在操作过程中拥有相关内容的版权或授权。
