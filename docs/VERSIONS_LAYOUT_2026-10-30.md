# 版本目录与游戏库分组

新安装的原版、Fabric、Forge、整合包及复制导入的实例采用：

```text
所选安装目录（未指定时为启动器数据目录）/
  .minecraft/
    versions/
      ec-实例名-短ID/
        mods/
        saves/
        config/
        options.txt
```

若所选目录已经是 `.minecraft`，不会重复套一层。目录名过滤 Windows 非法字符，短 ID 避免重名覆盖；重命名游戏库显示名称不会搬动目录。取消版本隔离后，新布局使用 `.minecraft` 共享游戏目录；不会自动合并、覆盖或迁移原存档与模组。

现有 `instances/<UUID>/game` 实例及旧事务保持兼容，通过可选 `versionFolder` 区分布局。引用导入的原安装保持原路径和隔离设置，不搬迁个人文件。共享资源与经过校验的下载缓存仍在启动器数据目录；这是本次游戏数据目录布局调整，没有承诺完全导出为其他启动器可自动识别的安装。

安装事务、回滚、恢复、删除回收、启动游戏目录及设置页路径统一读取实例布局。新目录直接存游戏文件，不再额外嵌套 `game`。本地复制导入的重复识别也读取实际游戏目录中的来源记录。

左侧游戏库按实际游戏根目录分组，上级显示 `.minecraft` 所在目录名称、路径和匹配数量；下级为具体游戏版本。原生 details 支持鼠标与键盘折叠。搜索时匹配组自动展开；长路径截断并保留悬停完整路径，不增加横向滚动。

## 验证

- Rust 131 项通过，17 项按需集成测试默认忽略；前端 96 项通过；现有 E2E 14 项通过。类型检查、ESLint、Clippy、格式和桌面构建通过。
- 新回归覆盖旧布局、新布局、自选安装目录、已选择 `.minecraft`、共享目录、名称过滤、重命名保持路径、越界拒绝、安装提交及回滚。
- 使用真实 Tauri 启动器安装 Adrenaline 26.5.1（Modrinth BYN9yKrV / 5SA4P3Eo），落盘到隔离测试位置 `.native/fixtures/custom-pack-location/versions-layout-20261030/.minecraft/versions/ec-Regression Adrenaline 26.5.1-4fa639c9`，逐文件 SHA-512 核对通过。没有改动用户既有版本。
- 桌面验证目录折叠、搜索后展开、1120×720 和 900×600 逻辑窗口，侧栏无横向溢出。截图及结果：`output/playwright/public-packs/versions-layout-20261030/`。
- 显式运行 `versions_layout_real_pack_prepares_cached_launch_without_starting_game` 通过：实际安装的 Fabric 资源成功准备，79 个类路径文件均存在，启动参数无未替换占位符，`--gameDir` 指向新版本目录。本次没有启动 Minecraft。记录：`.native/public-packs/versions-layout-20261030/layout-launch-preparation.json`。

运行产物：`src-tauri/target/debug/easy-craft.exe`。
