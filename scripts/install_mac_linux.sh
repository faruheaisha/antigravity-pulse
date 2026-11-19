#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${HOME:-}" || "${HOME:0:1}" != "/" ]]; then
  echo "[错误] 无效的 HOME 环境变量，已中止安装。"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_PLUGIN="$ROOT_DIR/antigravity-token-meter"

for req in plugin.json LICENSE assets/logo.svg sidecars/meter/sidecar.json sidecars/meter/main.mjs; do
  if [[ ! -f "$SRC_PLUGIN/$req" ]]; then
    echo "[错误] 安装包不完整，缺少: $SRC_PLUGIN/$req"
    exit 1
  fi
done

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 node 命令。请先安装 Node.js >= 20。"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "[错误] 需要 Node.js >= 20（当前为 v$(node -v)）。"
  exit 1
fi

ENABLE_INLINE="false"
for arg in "$@"; do
  if [[ "$arg" == "--enable-inline" ]]; then
    ENABLE_INLINE="true"
  fi
done

OS_NAME="$(uname -s)"
if [[ "$OS_NAME" == "Darwin" ]]; then
  CFG_DIR="$HOME/Library/Application Support/AntigravityTokenMeter"
else
  CFG_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/AntigravityTokenMeter"
fi

# 1. 先 staging 部署插件本体（保留旧版本以便任何失败完整回滚）
DST_ROOT="$HOME/.gemini/config/plugins"
DST_PLUGIN="$DST_ROOT/antigravity-token-meter"
mkdir -p "$DST_ROOT" "$CFG_DIR/config-backups"
STAGE_DIR="$DST_ROOT/.antigravity-token-meter-stage-$$"
PREV_DIR="$DST_ROOT/.antigravity-token-meter-prev-$$"
rm -rf "$STAGE_DIR" "$PREV_DIR"

rollback() {
  rm -rf "$STAGE_DIR"
  if [[ -d "$PREV_DIR" ]]; then
    rm -rf "$DST_PLUGIN"
    mv "$PREV_DIR" "$DST_PLUGIN"
  fi
}
trap rollback ERR

mkdir -p "$STAGE_DIR"
for item in assets sidecars plugin.json LICENSE; do
  cp -R "$SRC_PLUGIN/$item" "$STAGE_DIR/"
done

if [[ -d "$DST_PLUGIN" ]]; then
  mv "$DST_PLUGIN" "$PREV_DIR"
fi
mv "$STAGE_DIR" "$DST_PLUGIN"

# 2. 安全合并宿主 config.json 与本地 settings.json（保留既有 profile 等字段，排他备份）
CFG_JSON="$HOME/.gemini/config/config.json"
mkdir -p "$(dirname "$CFG_JSON")"

node -e '
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const [cfgPath, bakDir, settingsPath, enableInlineStr] = process.argv.slice(1);
const enableInline = enableInlineStr === "true";

function isPlainObj(v) { return Boolean(v) && typeof v === "object" && !Array.isArray(v); }

let cfg = {};
if (fs.existsSync(cfgPath)) {
  const raw = fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, "");
  if (!raw.trim()) { console.error("[错误] 现有 config.json 为空，已中止安装。"); process.exit(4); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { console.error("[错误] config.json 不是合法 JSON:", e.message); process.exit(4); }
  if (!isPlainObj(parsed)) { console.error("[错误] config.json 根节点必须为 JSON 对象。"); process.exit(4); }
  cfg = parsed;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-") + "-" + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(path.join(bakDir, `config-${stamp}.json`), raw, { flag: "wx", mode: 0o600 });
}

if (cfg.plugins !== undefined && !isPlainObj(cfg.plugins)) { console.error("[错误] plugins 字段类型异常"); process.exit(4); }
if (cfg.sidecars !== undefined && !isPlainObj(cfg.sidecars)) { console.error("[错误] sidecars 字段类型异常"); process.exit(4); }
cfg.plugins = cfg.plugins || {};
cfg.sidecars = cfg.sidecars || {};

if (cfg.plugins["antigravity-token-meter"] !== undefined && !isPlainObj(cfg.plugins["antigravity-token-meter"])) {
  console.error("[错误] plugins.antigravity-token-meter 字段类型异常"); process.exit(4);
}
if (cfg.sidecars["antigravity-token-meter/meter"] !== undefined && !isPlainObj(cfg.sidecars["antigravity-token-meter/meter"])) {
  console.error("[错误] sidecars[\"antigravity-token-meter/meter\"] 字段类型异常"); process.exit(4);
}

cfg.plugins["antigravity-token-meter"] = Object.assign({}, cfg.plugins["antigravity-token-meter"], { enabled: true });
cfg.sidecars["antigravity-token-meter/meter"] = Object.assign({}, cfg.sidecars["antigravity-token-meter/meter"], { enabled: true });

// 无损合并本地 settings.json（保留已有 profile 等字段）
let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""));
    if (isPlainObj(s)) settings = s;
  } catch {}
}
settings.enabled = true;
settings.inline = enableInline;
const tmpSet = path.join(path.dirname(settingsPath), `.tm-set-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`);
fs.writeFileSync(tmpSet, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
fs.renameSync(tmpSet, settingsPath);

const tmpCfg = path.join(path.dirname(cfgPath), `.tm-cfg-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`);
fs.writeFileSync(tmpCfg, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
fs.renameSync(tmpCfg, cfgPath);
' "$CFG_JSON" "$CFG_DIR/config-backups" "$CFG_DIR/settings.json" "$ENABLE_INLINE"

trap - ERR
rm -rf "$PREV_DIR"

if [[ ! -f "$CFG_DIR/preferences.json" ]]; then
  cat > "$CFG_DIR/preferences.json" <<'EOF'
{
  "language": "zh-CN",
  "theme": "swiss",
  "showSpeed": true,
  "showCache": true,
  "showContext": true,
  "showQuota": true,
  "showToday": false,
  "showMonth": true,
  "version": 1
}
EOF
fi

if [[ "$ENABLE_INLINE" == "true" ]]; then
  if [[ "$OS_NAME" == "Darwin" ]]; then
    LAUNCHER="$CFG_DIR/launch-antigravity-token-meter.command"
    cat > "$LAUNCHER" <<'EOF'
#!/usr/bin/env bash
open -a "Antigravity" --args --remote-debugging-port=0
EOF
    chmod +x "$LAUNCHER"
    echo "[成功] 已生成独立的 macOS 实验内嵌启动器: $LAUNCHER"
  else
    APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    mkdir -p "$APP_DIR"
    cat > "$APP_DIR/antigravity-token-meter.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Antigravity (TokenMeter Inline)
Comment=Launch Antigravity with local loopback debug port for TokenMeter inline bar
Exec=antigravity --remote-debugging-port=0
Terminal=false
Categories=Development;
EOF
    echo "[成功] 已创建独立的 Linux 桌面启动器: $APP_DIR/antigravity-token-meter.desktop（未修改原入口）"
  fi
fi

echo ""
echo "[完成] Antigravity TokenMeter v1.2.4 已安装至: $DST_PLUGIN"
echo "已在 config.json 中同时启用插件与 sidecar。"
