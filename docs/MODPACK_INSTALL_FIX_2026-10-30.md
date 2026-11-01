# 整合包安装流程修复与真实回归

测试对象固定为用户安装缓存中的真实发布版本，在线接口重新核对项目、版本和文件归属：

- Fabulously Optimized 6.5.0 / Minecraft 1.21.1：项目 `1KVo5zza`、版本 `N276l2ON`。
- Cobblemon Official Modpack [Fabric] 1.8.4 / Minecraft 1.21.1：项目 `5FFgwNNP`、版本 `YQpPe5Iu`。

## 故障证据

1. FO 原版 EXE 真实在线安装至文件准备结束后失败：`模组描述不是有效 JSON`。已校验缓存中的 Debugify、BetterGrassify 在 fabric.mod.json 的 description 中包含字面换行。Fabric Loader 的 JsonReader 允许这种字符串，serde_json 的严格读取不允许，因此这是启动器的兼容性错误。
2. 修复描述解析后继续复现 `暂不能自动解析 Fabric 版本条件：~1.21- <1.21.2-`。原先误用 npm/semver 的范围规则，现按 Fabric 的 `~`、`^` 和空预发行后缀处理。
3. Cobblemon 的在线归档预览原先不可安装，原因是 `config/yosbr/saves/Tutorial World v4 (1.8)/session.lock`。这是包内教程世界的旧运行锁，不应拒绝整个包，也不应复制为运行锁。
4. 修复锁文件后真实安装继续复现 `压缩包条目超过 10000 项上限`。Cobblemon 主 JAR 有 42,888 个条目，解压量约 245 MiB；Mod 校验错误地套用整合包目录条目上限，并另有 20,000 条元数据上限。
5. 包含大量覆盖文件时，每个文件重新构建 ZIP 中央目录索引，造成平方级重复读取。暂存阶段现在复用一个只读快照索引，保留各文件 CRC、SHA-512、事务清单和取消检查。

## 安装阶段与边界

流程为：确定具体版本 → 校验在线归档归属与哈希 → 读取并固定客户端安装计划 → 准备 Minecraft 与加载器 → 暂存下载文件和覆盖文件 → 文件/归档校验 → 依赖建议 → 原子发布到游戏库。

- Fabric 元数据只在内存中规范化字符串控制字符与 UTF-8 BOM，保留严格结构检查；不改动 Mod JAR，不放宽整合包清单 JSON。
- 仅忽略覆盖文件中位于 saves/<世界>/ 下的 session.lock，保留教程世界其他文件并在预览中说明。其他保留路径、路径穿越、符号链接、重复目标仍拒绝。
- Mod/资源归档使用现有 100,000 条资源检查边界；整合包仍是 10,000 条，解压总量与单项大小、嵌套层级/大小和下载哈希边界保持。
- 文件完整性和归档检查失败仍中止并回滚。版本声明冲突或静态分析能力不足记录为依赖建议，后续仍可通过实例启动检查查看，不能伪装成全面通过，也不自动替换现有 Mod。
- 文件准备完成和模组检查显示为不同任务阶段，避免在最后一个资源包的 99% 位置显示其他阶段的错误。元数据解析错误包含具体 Mod 文件和位置。

## 验证方式

`node scripts/verify-public-packs.mjs --baseline` 记录旧 EXE 故障；更新构建后 `node scripts/verify-public-packs.mjs` 通过真实 EXE 的 `native_pack_online` / `native_pack_install` 执行完整在线安装。使用 `.native/public-packs` 隔离目录，仅复用已校验不可变缓存，不复制正式账号、存档或实例清单。默认可选文件不安装。

结果、固定预览、任务阶段、建议日志与桌面截图保存于 `output/playwright/public-packs/`。整合包实例应有真实来源清单、对应加载器和内容；Cobblemon 教程世界保留 level.dat，旧 session.lock 不安装。

最终两项在线安装均成功：FO 安装 113 个内容文件，Cobblemon 安装 2,512 个内容文件。核对最终来源清单的归档 SHA-512、选中文件数量，并复核 Debugify、BetterGrassify、Cobblemon 主 JAR 的最终 SHA-512，证明兼容解析未改写这些文件。教程世界 level.dat 存在，session.lock 缺席。隔离测试复用了已验证的基础资源与下载缓存；24 秒／141 秒的最后一轮耗时不代表首次网络下载速度。见 `after/verified-files.json`。

验证结果：Rust 112 项通过、14 项显式集成测试忽略；前端 93 项通过；TypeScript、ESLint、Clippy、格式与差异空白检查通过。已生成更新后的 `src-tauri/target/debug/easy-craft.exe`。

回归覆盖字面换行/转义字符与损坏 JSON、教程锁与路径边界、Fabric 范围表达式、20,001 条资源 Mod 与整合包上限分离；既有事务取消、损坏、发布和回滚测试继续执行。安装成功不等同于完整游戏游玩验证；本轮没有自动启动这两个整合包。

依据：[Fabric 元数据读取器](https://github.com/FabricMC/fabric-loader/blob/master/src/main/java/net/fabricmc/loader/impl/lib/gson/JsonReader.java)、[Fabric 版本比较规则](https://github.com/FabricMC/fabric-loader/blob/master/src/main/java/net/fabricmc/loader/api/metadata/version/VersionComparisonOperator.java)。
