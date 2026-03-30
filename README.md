# Goofish Lister

这个 skill 现在是单入口固定流程。

用户只需要提供一个闲鱼商品链接，系统就会按固定步骤执行：

1. 提取商品图文
2. 下载并处理图片
3. 生成上架文案
4. 固定类目为 `笔记资料`
5. 打开闲鱼发布页并自动发布

## 唯一入口

```bash
npm run publish:url -- "https://www.goofish.com/item?id=..."
```

也支持短链：

```bash
npm run publish:url -- "https://m.tb.cn/..."
```

## 首次使用

先安装依赖：

```bash
npm install
npx playwright install chrome
```

首次登录闲鱼：

```bash
npm run login
```

## 设计原则

- 不再支持关键词搜索入口
- 不再要求 AI 理解多种参数
- 默认走固定处理和固定发布流程
- 底层脚本仍保留，但对外推荐只使用 `publish:url`
