# Antigravity TokenMeter (`v1.0.0`)

> **开源协议：MIT License** · **零外部依赖（Node.js 标准库 + 原生前端）** · **不修改 `app.asar`**  
> 为 Google Antigravity 桌面版打造的实时 Token 输出速率、思考 Token 统计、缓存命中率、上下文窗口与账号额度监控插件。

---

## 功能概览

- **侧边栏面板（默认安全模式）**：通过 Antigravity 官方 `sidecar_sdk` 运行，无需额外启动参数，直接展示实时速率、近期请求速度曲线、账号模型额度与历史统计。
- **可选实验性底部内嵌状态条**：通过 CDP Isolated World（隔离世界）将 Shadow DOM 胶囊条挂载到聊天输入框下方，支持自由勾选显示项、悬停详情浮卡、近 16 次请求 SVG 速度曲线、16 周热力图与模型消耗/均速排行。
- **应用层代理绕过直连**：本地 `language_server` 与 CDP 连接均使用原生回环 TCP（`agent: false` / 自定义 RFC 6455 客户端），不受 `HTTP_PROXY` / `HTTPS_PROXY` / `NODE_USE_ENV_PROXY` 环境变量干扰。
- **精准速率与去重账本**：将正文输出与 Thinking 思考输出一并纳入流式速率（`tok/s`）计算，过滤 `<50ms` 缓冲突发毛刺，支持按差值更新的原子化本地账本，重启不丢不重。
- **6 项健康诊断工具（Doctor）**：分别检验插件文件、插件注册、sidecar 启用、主进程调试开关、本地调试端口连通性与运行实例挂载状态。

---

## 快速安装

### Windows

1. 在 **Releases** 下载 `Antigravity-TokenMeter_v1.0.0.zip` 并**完整解压**。
2. **先右键系统托盘中的 Antigravity 图标点击「退出」**（确保完全关闭，避免旧实例覆盖配置或吞掉启动参数）。
3. 双击运行 **`一键安装插件(Windows双击运行).bat`**：
   - 自动部署插件与 `MIT LICENSE`；
   - 自动在 `config.json` 中**同时启用插件与 `sidecars["antigravity-token-meter/meter"]`**（保留原有配置并生成带时间戳备份）；
   - **不会擅自改写您原有的桌面/开始菜单/任务栏快捷方式**；
   - 引导您选择“仅侧边栏面板”或“同时启用实验性底部内嵌状态条”。
4. 启动 Antigravity：
   - **纯侧边栏模式**：正常打开 Antigravity 即可；
   - **实验性底部内嵌模式**：双击本包自带的 **`启动Antigravity(带Token监控).bat`**（或在您自己的启动脚本末尾加上 `--remote-debugging-port=0`）。

### macOS / Linux

```bash
# 默认安装（仅启用侧边栏面板）
bash scripts/install_mac_linux.sh

# 安装并启用实验性底部内嵌状态条（会生成独立启动器，不修改原 .desktop）
bash scripts/install_mac_linux.sh --enable-inline
```

---

## 常见问题排查（为什么别人的机器装完没看到底部状态条？）

直接双击 **`一键诊断内嵌状态(Windows).bat`**（支持 `-Json` 输出），它会逐项报告问题所在：

1. **旧版安装未启用 `sidecars` 注册项**：Antigravity 区分插件与 sidecar，须在 `config.json` 中同时启用 `plugins["antigravity-token-meter"]` 与 `sidecars["antigravity-token-meter/meter"]`。请彻底退出客户端后重跑本版安装器。
2. **系统托盘残留进程**：点击窗口右上角 `X` 默认不会退出 Antigravity。若托盘仍有旧进程，再次打开启动器时 Electron 单实例锁会忽略新的 `--remote-debugging-port=0` 参数。请务必从系统托盘完全退出后再用专用启动器启动。
3. **仅修改了其中一个快捷方式，但实际点了其他入口**：如使用自定义代理脚本或汉化恢复脚本，请确保实际执行的命令中带有 `--remote-debugging-port=0`。

---

## 安全与隐私边界说明

- **实验性内嵌模式的安全边界**：`--remote-debugging-port=0` 仅监听本机回环随机端口，但不具备独立访问认证；任何同机本地进程若具备访问权限理论上均可连接该端口。因此本工具**不会批量修改您的既有系统快捷方式**，仅通过您显式双击独立启动器启用，且可在 `settings.json` 中随时关闭 `inline: false`。
- **数据分类边界**：
  1. **内存读取**：调用本机 `language_server` 接口获取请求元数据与模型配置后，立即投影为脱敏数值与模型标签，不长期保留原始完整响应；
  2. **本地持久化**：账本仅存储按日期与模型聚合的 Token 计数、流式耗时与经过单向 SHA-256 哈希处理的去重键，不保存对话正文、Prompt、邮箱或凭据；
  3. **向页面输出**：通过 CDP Isolated World 隔离世界仅向本地主文档投递脱敏统计 JSON，不在宿主默认全局世界暴露桥接 API。

---

## 开发者测试与只读预览

```bash
# 运行全部单元测试
node --test antigravity-token-meter/sidecars/meter/tests/*.test.mjs

# 显式启动本地只读预览（自动生成一次性随机 Token）
node antigravity-token-meter/sidecars/meter/main.mjs --preview
```

## 开源许可

本项目采用 [MIT License](./LICENSE) 开源。
