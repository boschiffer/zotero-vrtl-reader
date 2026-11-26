# ZotRead++ — Zotero 竖排全屏阅读 + Obsidian 直达

在 Zotero 内置 PDF 阅读器里读竖排古籍／汉籍：双页对开、页序从右往左，再配一个窗口内的沉浸式全屏，外加一键打开绑定了 ZotFlow 的 Obsidian 库。

批注、高亮、笔记、侧栏标注列表全部走 Zotero 原生实现，本插件不碰任何一处。

> 插件显示名是 ZotRead++，内部 ID 仍是 `vrtl-reader@boschiffer.github.io`，仓库名也沿用 `zotero-vrtl-reader`——改 ID 会让老安装变成两个并存的插件，自动更新也会断。

## 安装

1. 到 [Releases](../../releases) 下载 `zotread-plus-<版本>.xpi`。
2. Zotero 菜单 → 工具 → 插件 → 右上角齿轮 → **Install Plugin From File**，选中刚下载的 xpi。
3. 装完即生效，不需要重启。

要求 Zotero 9.0.3 以上（在 10.0.6 上测试）。

## 使用

阅读器工具栏右侧会多出三个文字按钮：**竖排**、**全屏**、**Obsidian**。

| 操作 | 触发 | 说明 |
| --- | --- | --- |
| 切换竖排 | `Ctrl+Shift+V`（macOS `Cmd+Shift+V`） | 开启后自动切到「奇数页对开」，页序变成右→左（第 1 页在右） |
| 切换全屏 | `F11` | 隐藏 Zotero 的标题栏、标签栏和右侧条目面板，只留阅读器和它自己的批注工具栏 |
| 打开 Obsidian | 点 **Obsidian** 按钮 | 用 `obsidian://` 打开装了 ZotFlow 的库；**Shift+点击**重新选库 |

竖排开关写进偏好 `extensions.vrtl-reader.rtl`，选定的库名写进 `extensions.vrtl-reader.obsidian-vault`，下次启动仍然记得。
关掉标签或退出全屏时，沉浸式状态会自动还原。

## 原理

竖排只做两件事：

- 给 pdf.js 的 `.spread` 容器加 `flex-direction: row-reverse`；
- 把对开模式设为 `SpreadMode.ODD`。

关键在于**只改 flex 方向、不改 CSS `direction`**。文字层、标注层、选区映射、命中测试全都建立在 pdf.js 自己的坐标体系上，`direction` 一动就会错位——所以这里刻意绕开了它，代价是翻页方向键的语义保持 Zotero 原样。

全屏是一小段注入到 chrome 窗口的 CSS，隐藏 `#titlebar`、`#zotero-title-bar`、`#zotero-context-pane`，让 `browser.reader` 自己撑满。

Obsidian 按钮不去猜库在哪，而是读 Obsidian 自己的登记文件（`%APPDATA%/obsidian/obsidian.json`，Linux 是 `~/.config`），筛出 `.obsidian/plugins/zotflow` 存在的 vault：只有一个就直接用，多个就弹一次选择框，选完记住。跳转走 Zotero 的 `Zotero.launchURL('obsidian://open?vault=<库名>')`，由系统按协议交给 Obsidian——**全程只读那张 JSON，不碰 vault 里的文件**。

## 从源码构建

```
python build.py     # 产出 dist/zotread-plus-<version>.xpi
```

版本号取自 `plugin/manifest.json` 的 `version` 字段。xpi 就是 zip，`manifest.json` 必须在包根，同级的 `bootstrap.js` 是唯一的运行时代码，没有构建步骤、没有依赖。

## 发版

推一个 `v<版本>` 标签，GitHub Actions 会自动打包并把 xpi 挂到该版本的 Release 上（Release 已存在则覆盖附件）。在网页上建 Release 时直接填新标签点 Publish 就行，不用手动拖文件。

标签版本号必须与 `plugin/manifest.json` 的 `version`、以及 `updates.json` 里的 `version` / `update_link` 三处一致，CI 的校验步骤会挡住对不上的情况——否则自动更新检查会指向一个不存在的包。

也可以在工作流页面手动触发一次，填上标签名，用于补发或重传附件。

## 已知边界

- 「竖排」改变的是**对开页序**，不会把横排文字重排成竖排，也不做文字回流。扫描版／影印本本来就是图片，效果最好。
- 单页显示时没有对开，页序自然也无从谈起——开关只影响双页对开。
- 全屏是窗口内全屏，不是操作系统的独占全屏；`F11` 若被系统或其他程序占用，改用工具栏按钮。
- Obsidian 按钮只负责把库打开，不做条目↔笔记的映射；装了多个带 ZotFlow 的库时，第一次点会弹选择框，之后想改就 Shift+点击，或直接在 `about:config` 里改 `extensions.vrtl-reader.obsidian-vault`。库名取的是 vault 目录名（Obsidian 的 `obsidian://` 就认这个），重名的库分不出来。

## 许可

MIT
