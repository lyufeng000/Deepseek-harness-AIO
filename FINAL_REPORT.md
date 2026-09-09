# DSHEAC AIO v1.2.0 — 最终交付报告

完成时间：2026-09-09

版型：AIO（All-in-One）

用户版本：v1.2.0

机器 SemVer：1.2.0

上游内核：@deepseek-ai/dsh `0.1.3-alpha.2`（对齐官方桌面端 deepseek-ai/deepseek-harness @ c389f96b）

## 最终产物

| 文件 | 大小 | SHA-256 |
| --- | ---: | --- |
| `DSHEAC-AIO-v1.2.0-Setup-x64.exe` | 327,752,754 bytes | `0ac0bf8f30d16e70e2fec981eac93904ff4056e17bb3f55c69ef7b6e3b95455e` |
| `DSHEAC-AIO-v1.2.0-Portable-x64.zip` | 154,395,642 bytes | `d01998f93cb833dbbd2bea528caa6746166486f217939ab2ace962dbe8fc57dc` |

## 测试结果

- Node 全量：715 项，714 通过、0 失败、1 条件跳过
- Rust：16/16 通过；sidecar 类型检查通过；依赖闭包校验通过
- 构建产物本机路径审计：通过（Rust 路径重映射 + staging 过滤）
- 安装器 E2E：**PASS**（`verification/verification-20260909-203021-781-48204-c2b094fa.json`）
  - 静默安装（中文+空格路径）：58.6s，退出码 0
  - payload：32,372 文件，443.4 MB
  - 隔离首启：49.6s 至 HTTP 200，监听 PID 属于应用进程树
  - 隐私扫描：私密设置标记 0、机器路径残留 0
  - 静默卸载：56.1s，退出码 0，文件/进程/端口/注册表零残留，外部用户数据保留

## 本版要点

- 内核对齐官方 `0.1.3-alpha.2`，插件接口迁移至 AIO 兼容层（详见 `docs/aio-kernel-1.2.0.md` 的 R6/R7 记录）
- 用户确认的停用插件与九个皮肤从源码删除
- 应用图标统一更换为 WhaleGirl（六处产物同源生成）
- 旧 AIO 会话与供应商配置经 additive 迁移 seed 继承；插件不继承

## 仍未闭合的公开发布风险

1. 安装包未 Authenticode 签名；
2. 第三方依赖尚无完整 SBOM/notice bundle；
3. 部分本地插件或素材的许可证/权利人证据不足；
4. WhaleGirl 图标的权利人授权证据需在公开发布前确认；
5. 插件更新依赖 npm/GitHub HTTPS，尚无应用级签名 manifest；
6. `csp: null` 与全局 Tauri API 仍待兼容性验证后收紧。

结论：**本机技术验收 PASS**；无条件公开再分发授权**未证明**，仅适合明确标注风险的预发布。
