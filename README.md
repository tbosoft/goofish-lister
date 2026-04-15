# Goofish Lister

这个 skill 现在是单入口固定流程。

用户只需要提供一个闲鱼商品链接，系统就会按固定步骤执行：

1. 提取商品图文
2. 下载并处理图片
3. 生成上架文案
4. 固定类目为 `笔记资料`
5. 打开闲鱼发布页并自动发布

另外也支持先查看本地已登录账号列表。

## 唯一入口

```bash
npm run publish:url -- "https://www.goofish.com/item?id=..."
```

也支持短链：

```bash
npm run publish:url -- "https://m.tb.cn/..."
```

指定账号发布：

```bash
npm run publish:url -- --account seller-a "https://www.goofish.com/item?id=..."
```

自然语言层面也按这个约定使用，例如：

- `用 seller-a 发这个链接`
- `挂到 2 号账号`
- `用默认账号发布`

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

给指定账号登录：

```bash
npm run login -- --account seller-a
```

查看本地已缓存的账号：

```bash
npm run accounts
```

自然语言里，如果是在问：

- `有哪些账号已经登录`
- `列出可用闲鱼账号`
- `我现在能用哪个号发`

skill 应该先返回账号列表，而不是直接进入发布流程。

说明：

- 登录态不是单独保存的 token，而是 Playwright 持久化浏览器 profile 里的 cookie / session。
- `npm run login` 会打开一个真实浏览器窗口，需要你手动完成闲鱼登录。
- 每个 `--account` 都会使用独立的本地 profile 目录，互不影响。
- 不传 `--account` 时默认使用 `default`；如果本机已有旧版单账号目录，会继续复用旧目录保证兼容。
- 登录完成后关闭浏览器，后续发布流程会复用对应账号的本地缓存登录态。
- 如果还没有这份缓存，先对目标账号执行登录，再执行 `npm run publish:url -- --account <账号名> "<闲鱼链接>"`。

## 设计原则

- 不再支持关键词搜索入口
- 对外仍保持固定发布流程，只额外开放 `--account` 这个账号选择参数
- 默认走固定处理和固定发布流程
- 底层脚本仍保留，但对外推荐只使用 `publish:url`
