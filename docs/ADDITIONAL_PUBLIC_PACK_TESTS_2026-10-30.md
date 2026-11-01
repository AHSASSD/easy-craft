# 额外公开整合包下载与安装测试

后续已接入 Forge/NeoForge 官方处理器，见 [最新验收](PACK_LOCATION_AND_LOADERS_2026-10-30.md)。下文 Keo 的“不可安装”对应此前构建；当前测试夹具已改为要求按真实 NeoForge 声明安装，该包尚未重新跑完整安装，不能沿用旧结果代表新版本能力。

使用现有 Easy Craft 调试 EXE，经真实 `native_pack_online`、`native_pack_install` 执行；不是其他启动器代装。所有数据位于 `.native/public-packs/additional-20261030`，不写正式账号、存档和实例清单。复用经过校验的基础资源缓存；未启动 Minecraft。

| 整合包版本                     | 游戏版本          | 安装结果                   | 内容文件数 |
| ------------------------------ | ----------------- | -------------------------- | ---------- |
| Adrenaline 26.5.1              | 1.21.1 / Fabric   | 成功                       | 35         |
| Simply Optimized 1.20.1-12.3   | 1.20.1 / Fabric   | 成功                       | 31         |
| Additive 26.5.1                | 1.21.11 / Fabric  | 成功                       | 73         |
| Fabric Create Mod + More 0.1.1 | 1.20.1 / Fabric   | 成功                       | 54         |
| Keo Create Optimized 2.0.0     | 1.21.1 / NeoForge | 归档下载成功，新装暂不支持 | 未创建实例 |

四项成功安装均核对了最终游戏库实例、原始整合包归档 SHA-512、选中文件数量，以及全部 193 个内容文件的最终 SHA-512。默认可选文件未选择；文件数包含配置等内容，并非模组数量。测试过程没有改动启动器产品代码。

Keo 的发布版本元数据标注 Fabric，但实际下载并校验的 MRPACK 清单是 `{"minecraft":"1.21.1","neoforge":"21.1.231"}`。当前安装计划拒绝未接通的加载器，因此没有错误地创建 Fabric 实例。导入已有 NeoForge 版本、启动时补齐已支持的必要文件，与从 MRPACK 新建 NeoForge 整合包是不同路径；后者仍是支持缺口。这个样本的回归预期是明确拒绝，不能计入安装成功数量。

Adrenaline 没有安装阶段依赖建议；其他样本保留了声明或未完整分析的提示：Simply Optimized 的 mixinextras 重复提供者和 nvidium/sodium 版本范围；Additive 的 YACL 多级内嵌候选；Create 的 porting_lib_accessors 多级内嵌候选。本轮不判定这些提示是否必然阻止实际启动，没有把安装成功写成可正常游玩。

固定项目、版本 ID、文件名及预期状态在 `tests/fixtures/additional-public-packs.json`。来源为对应 [Modrinth 版本接口](https://docs.modrinth.com/api/operations/getversion/)；实际下载文件还由启动器检查归属、哈希与归档内声明。

复现命令（已有构建）：

```powershell
$env:EASYCRAFT_PACK_TEST_LABEL='additional-20261030'
$env:EASYCRAFT_PACK_TEST_CASES='tests/fixtures/additional-public-packs.json'
node scripts/verify-public-packs.mjs
```

测试驱动新增可选矩阵与目录标签，固定未支持样本的预期拒绝，并逐文件复核已安装内容。ESLint、Prettier 与差异空白检查通过。本轮未改产品代码，未重新编译或再次执行无关单元测试。

报告、任务日志和截图：`output/playwright/public-packs/additional-20261030/`。`results.json` 保留全部五项结果；`first-four-results.json` 保留初轮暴露新装限制的原始结果；`hash-audit.json` 是独立的完整内容哈希复核。两轮原始执行日志为 `output/additional-public-packs.log` 和 `output/additional-create-pack.log`。
