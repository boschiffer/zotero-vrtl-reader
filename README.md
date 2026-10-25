# VRTL Reader — Zotero 竖排全屏阅读

在 Zotero 内置 PDF 阅读器里读竖排古籍／汉籍：双页对开、页序从右往左，再配一个窗口内的沉浸式全屏。

批注、高亮、笔记、侧栏标注列表全部走 Zotero 原生实现，本插件不碰任何一处。

## 安装

1. 到 [Releases](../../releases) 下载 `vrtl-reader-<版本>.xpi`。
2. Zotero 菜单 → 工具 → 插件 → 右上角齿轮 → **Install Plugin From File**，选中刚下载的 xpi。
3. 装完即生效，不需要重启。

要求 Zotero 9.0.3 以上（在 10.0.6 上测试）。

## 使用

阅读器工具栏右侧会多出两个文字按钮：**竖排** 和 **全屏**。

| 操作 | 快捷键 | 说明 |
| --- | --- | --- |
| 切换竖排 | `Ctrl+Shift+V`（macOS `Cmd+Shift+V`） | 开启后自动切到「奇数页对开」，页序变成右→左（第 1 页在右） |
| 切换全屏 | `F11` | 隐藏 Zotero 的标题栏、标签栏和右侧条目面板，只留阅读器和它自己的批注工具栏 |

竖排开关会写进 Zotero 偏好（`extensions.vrtl-reader.rtl`），下次打开阅读器仍然记得。
关掉标签或退出全屏时，沉浸式状态会自动还原。

## 原理

竖排只做两件事：

- 给 pdf.js 的 `.spread` 容器加 `flex-direction: row-reverse`；
- 把对开模式设为 `SpreadMode.ODD`。

关键在于**只改 flex 方向、不改 CSS `direction`**。文字层、标注层、选区映射、命中测试全都建立在 pdf.js 自己的坐标体系上，`direction` 一动就会错位——所以这里刻意绕开了它，代价是翻页方向键的语义保持 Zotero 原样。

全屏是一小段注入到 chrome 窗口的 CSS，隐藏 `#titlebar`、`#zotero-title-bar`、`#zotero-context-pane`，让 `browser.reader` 自己撑满。

## 从源码构建

```
python build.py     # 产出 dist/vrtl-reader-<version>.xpi
```

版本号取自 `plugin/manifest.json` 的 `version` 字段。xpi 就是 zip，`manifest.json` 必须在包根，同级的 `bootstrap.js` 是唯一的运行时代码，没有构建步骤、没有依赖。

发新版本时记得同步改 `updates.json`，否则自动更新检查拿不到新包。

## 已知边界

- 「竖排」改变的是**对开页序**，不会把横排文字重排成竖排，也不做文字回流。扫描版／影印本本来就是图片，效果最好。
- 单页显示时没有对开，页序自然也无从谈起——开关只影响双页对开。
- 全屏是窗口内全屏，不是操作系统的独占全屏；`F11` 若被系统或其他程序占用，改用工具栏按钮。

## 许可

MIT
