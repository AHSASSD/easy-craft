# 落幕曲、新蒸程兼容性回归（2026-10-30）

后续构建已接入 Forge/NeoForge 的官方处理器安装，见 [最新安装验收](PACK_LOCATION_AND_LOADERS_2026-10-30.md)。本文保留此前真实本地版本的测试结果；落幕曲、新蒸程原始安装包的从零安装仍未补测。

## 测试范围

使用 Easy Craft 桌面程序、系统目录选择器和隔离游戏库，实测本机已有的两个完整整合包。验证扫描、直接添加、重复识别、版本隔离、Mod 声明检查以及启动参数准备。本轮没有启动游戏，也没有改动原整合包、账号或存档。

**这不是原始压缩包的从零下载与安装通过记录。** 目前未取得两包的原始安装压缩包，不能用“已有版本可添加”代替完整安装测试。

| 本机版本                               | 加载器            | 已启用 JAR | 直接添加 | 启动准备                         |
| -------------------------------------- | ----------------- | ---------: | -------: | -------------------------------- |
| 落幕曲 / Minecraft 1.20.1              | Forge 47.3.22     |        261 |   115 ms | 94 个 classpath 文件、60 个参数  |
| 你好，新蒸程 V1.5.9 / Minecraft 1.21.1 | NeoForge 21.1.233 |        277 |   120 ms | 107 个 classpath 文件、58 个参数 |

添加时间包含提交命令和任务状态轮询，不含系统选目录、扫描及首次 Mod 检查。扫描含选择器约 2.10 / 2.35 秒，不可直接作为纯扫描耗时。

强制重新读取 Mod 元数据约 5.96 / 7.46 秒；紧接着的缓存检查为 315 / 98 ms，分别复用 261 / 277 项。样本来自单次本机运行，不保证固定性能。

## 测试发现并修复

1. **较大的签名清单让正常 Mod 被跳过。** Modern UI、家具重制的 MANIFEST.MF 分别为 775,378 / 910,854 字节，真正的 mods.toml 仅 1,470 / 1,587 字节。旧逻辑不论是否需要版本替换，都读取整个 MANIFEST.MF，并用 512 KiB 声明上限拒绝整个 Mod。
   - 现在只有版本使用 `${file.jarVersion}` 时才读取 JAR 主属性。
   - 主属性读取到首个空行为止，保留 512 KiB 前缀上限；不展开后续大量签名摘要。
   - mods.toml、内嵌 JAR 和路径边界的限制保持有效。两个 Mod 现已进入声明检查。
2. **NeoForge 1.21.1 的官方兼容矩阵缺失，造成 9 项误报。** 实际加载器在标准版本匹配失败后，还接受 Minecraft `1.21`、NeoForge `21.0.166` 作为对应依赖的兼容身份。旧检查只比较当前版本，因此把 `[1.21,1.21.1)` 报为错误。
   - 仅在 NeoForge + Minecraft 1.21.1 的明确范围内应用此规则。
   - 真正不兼容的范围、其他加载器和其他游戏版本不放宽。
   - 来源：[FancyModLoader 1.21.1 VersionSupportMatrix](https://github.com/neoforged/FancyModLoader/blob/1.21.1/loader/src/main/java/net/neoforged/fml/loading/VersionSupportMatrix.java)、[ModSorter 调用位置](https://github.com/neoforged/FancyModLoader/blob/1.21.1/loader/src/main/java/net/neoforged/fml/loading/ModSorter.java)。亦核对本机 loader-4.0.42.jar 中这些兼容身份存在。
3. 本机全套回归还暴露了下载测试服务器的 Windows 非阻塞继承问题，已把已接受的测试连接明确设为阻塞；生产下载行为未因此更改。

修复后，两包的 `issues` 均为空。`complete` **仍为 false**：分别有 58 / 108 项未验证说明，涉及带限定词的 Maven 版本、运行时服务、语言加载器和桥接等。没有把这些内容冒充“全部检查通过”。

## 数据保护与证据

- 落幕曲源目录：`C:/Users/小萌新一只/AppData/Roaming/.minecraft/versions/落幕曲`。
- 新蒸程源目录：`E:/minecraft/versions/你好，新蒸程V1.5.9`。
- 前后 SHA-256 核对 267 / 284 个版本 JSON、JAR、Mod 与 options.txt 文件，全部一致；测试代码不写入源目录，也不启动游戏。
- 引用目录仍指向各自隔离的版本文件夹；再次扫描能识别已添加，游戏库没有重复登记。
- 桌面实测报告与截图：`output/playwright/chinese-packs/111800f9-62d0-4658-bceb-02fdc29c5b69/`。
- 修复前报告：`output/playwright/chinese-packs/cc28c68f-5133-4844-96b7-ca314da0c956/`。
- 启动准备结果：`.native/chinese-packs-preparation/d4e5aba7-a99f-4c43-9906-472b62602ac3/results.json`。
- 所有测试实例只登记在 `.native/` 隔离游戏库，没有添加到用户正式游戏库。

## 原始下载仍待补测

- 落幕曲：[作者发布页](https://bbsmc.net/modpack/luomuqu) 指向[作者夸克分享](https://pan.quark.cn/s/4e69ec77f734)。公开分享列表确实包含 `落幕曲1.6.7.1安装包（拖入启动器安装）.zip`，502,712,264 字节，及另一个约 2 GiB 的完整客户端。匿名尝试未取得下载文件：文件下载接口返回 401，所尝试的分享下载接口返回 404。未读取用户网盘登录信息。
- 新蒸程：[作者网站](https://newsteaming.naidc.cn/) 提供百度、夸克下载二维码和群文件入口；目前尚未取得与本机 V1.5.9 对应的原始包。
- 已询问用户原始安装包路径。取得文件后，需继续用 Easy Craft 原生导入流程验证格式识别、加载器安装、资源下载与最终发布；不应把手动解压或其他启动器安装记为 Easy Craft 安装成功。
- 当前归档安装能力仍有限：MRPACK 新装支持原版/Fabric；CurseForge ZIP 的 Forge 新装目前限 1.12.2。已有 Forge/NeoForge 的直接添加和启动准备，与新装加载器是不同能力。不能仅凭这里的成功报告宣称任意 Forge/NeoForge 安装包都可新装。

## 可复现检查

```powershell
node scripts/verify-chinese-local-packs.mjs
$env:EASYCRAFT_REAL_PACK_DIRECTORIES='["C:/Users/小萌新一只/AppData/Roaming/.minecraft/versions/落幕曲","E:/minecraft/versions/你好，新蒸程V1.5.9"]'
powershell -NoProfile -File scripts/native.ps1 -Action test -Integration real-packs
```

Rust 全套 119 通过、15 个显式集成测试默认忽略；本轮另运行真实包启动准备集成测试通过。Clippy、ESLint 和桌面构建通过。失败复现、修复后测试及构建日志分别保存在 `output/chinese-packs-*.log`。
