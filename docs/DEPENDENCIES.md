# 依赖和许可证

所有 npm 直接依赖使用精确版本，完整传递依赖见 package-lock.json。通过 npm ci 复现。Rust 直接依赖精确锁定，因缺少 Cargo 尚未解析传递依赖和生成 Cargo.lock。

## 运行时

| 包              | 版本   | 许可证            |
| --------------- | ------ | ----------------- |
| @tauri-apps/api | 2.12.4 | Apache-2.0 OR MIT |
| lucide-react    | 1.61.0 | ISC               |
| react           | 19.3.1 | MIT               |
| react-dom       | 19.3.1 | MIT               |

## 开发与测试

| 包                        | 版本    | 许可证            |
| ------------------------- | ------- | ----------------- |
| @eslint/js                | 10.0.1  | MIT               |
| @playwright/test          | 1.64.1  | Apache-2.0        |
| @tauri-apps/cli           | 2.12.4  | Apache-2.0 OR MIT |
| @testing-library/react    | 16.3.3  | MIT               |
| @types/node               | 26.6.5  | MIT               |
| @types/react              | 19.3.0  | MIT               |
| @types/react-dom          | 19.3.0  | MIT               |
| @vitejs/plugin-react      | 6.1.2   | MIT               |
| eslint                    | 10.13.0 | MIT               |
| eslint-plugin-react-hooks | 7.1.1   | MIT               |
| globals                   | 17.13.0 | MIT               |
| jsdom                     | 30.1.3  | MIT               |
| prettier                  | 3.9.10  | MIT               |
| typescript                | 5.9.3   | Apache-2.0        |
| typescript-eslint         | 8.72.0  | MIT               |
| vite                      | 8.3.5   | MIT               |
| vitest                    | 5.0.5   | MIT               |

## 原生端

- tauri 2.12.5：MIT OR Apache-2.0
- tauri-build 2.7.4：MIT OR Apache-2.0
- 版本通过 crates.io 元数据核对；原生编译仍待 Windows 工具链。

## 本地素材

几何地形由 CSS 绘制；立方体 SVG 为本项目新建。没有引用 PCL/HMCL 源码或 Minecraft 版权图片。Lucide 图标来自统一的 lucide-react 包。

运行时第三方声明与许可原文见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。工具链依赖许可随 node_modules 和上游发布包提供；发布产品前应基于最终锁文件复核原生端传递依赖。
