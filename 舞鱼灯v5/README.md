# 舞鱼灯 · 完整可运行包（缝合 / 重构版）

**访问地址（需先启动本地服务）：http://localhost:8081/**

「舞鱼灯」互动网页：水面涟漪 → 钓鱼 → 制灯（含非遗工艺视频）→ 鱼灯领取（粒子鱼影溶解互动）→ 鱼灯游群。

本版本在原「修正版」基础上完成了三项缝合 / 重构，并修复了若干启动阻塞 Bug。

---

## 快速开始

### Windows（推荐）

1. 安装 [Python 3](https://www.python.org/downloads/)（勾选 “Add to PATH”）。
2. 在本文件夹按住 Shift + 右键 →「在终端中打开」。
3. 运行：

```bat
python serve.py
```

4. 浏览器（建议 Chrome）打开：**http://localhost:8081/**

> 旧入口 `python run_server.py` 也可用（已修复，会转交 `serve.py`）。
> `启动网页.command` 仅适用于 macOS。

### macOS

```bash
cd 本文件夹路径
python3 serve.py
```

### 手机 / 局域网访问

`serve.py` 已绑定 `0.0.0.0`，启动时会打印局域网地址（形如 `http://192.168.x.x:8081/`），
手机连同一 Wi-Fi 即可访问。**注意**：摄像头（手势识别）只在 `localhost` 或 HTTPS 下可用，
手机端如需手势请走 HTTPS；纯触摸交互不受影响。

---

## 这次改了什么

| 项 | 说明 |
|----|------|
| **serve.py（新）** | 替换被存成 UTF-16、无法运行的旧 `run_server.py`；UTF-8、关闭缓存、绑定 0.0.0.0、端口占用提示、修正中文文件名 MIME。 |
| **统一手势总线** `src/hand-input.js` | 全应用只开一路摄像头 + 一个 tasks-vision `HandLandmarker`，取代旧 `@mediapipe/hands`；消除主程序与粒子场景各开一路摄像头的冲突。 |
| **可嵌入粒子场景** `src/particle-scene.js` | 由 `pointcloud-demo` 抽取重构：实体鱼灯 ⇄ 粒子鱼影、5 种解体 FX、手掌跟随。宿主驱动、可释放显存（dispose）。 |
| **统一模型清单** `src/fish-manifest.js` | 统一「之影/鱼影」命名，并入虾灯、蟹灯。 |
| **单服务器收敛** | 制灯视频固定走同源 `./outputs-video/`，不再依赖独立的 4174 端口服务器（原 `start.ps1` 写死他人机器路径，已修复）。 |
| **版本统一** | 全部 Three.js 0.164、tasks-vision 0.10.18、CDN 统一 jsDelivr。 |

---

## 体验流程（全程手势，无需鼠标点击）

水面 → 钓鱼 → **鱼影显形（粒子）** → 制灯（非遗视频）→ 鱼灯领取 → 鱼灯游群 → 循环

| 环节 | 怎么进行 | 自动兜底 |
|------|----------|----------|
| 水面 | 张开手掌左右挥动唤醒鱼影 | 静置 25s 自动开始 |
| 钓鱼 | 拇指食指捏合放线、再捏合提鱼 | —（核心手势）|
| **鱼影显形** | 张手让鱼影化光、握拳凝形；双手向两侧推开进入制灯 | 22s 自动进入制灯 |
| 制灯 | 看完工艺视频，挥手或点右上「领取鱼灯」返回 | 加载失败/超时自动跳过 |
| 鱼灯领取 | 左右挥掌召唤鱼灯 | 5s 自动推进 |
| 鱼灯游群 | 握拳后张开放飞鱼灯 | 16s 自动放飞、汇群后自动回水面 |

### 常驻 HUD（右上角，观众可用）
↺ 重来 · 🐟 换鱼 · 🔊 静音 · ⚙ 开发面板

### 键盘（工作人员）
| 键 | 作用 |
|----|------|
| `D` 或 HUD ⚙ | 开/关开发面板（粒子参数、超时、阶段跳转）|
| `1`~`5` | 调试跳阶段 |
| `G` | 手动开/关鱼影粒子场景 |
| `Space` | 推进当前阶段 |
| `particle-test.html` | 粒子场景独立测试页（无需摄像头）|

> 底部圆点仅为阶段指示，不可点击（避免任意跳阶段导致状态错乱）。

---

## 目录结构

```
舞鱼灯v2/
├── serve.py                  ← 启动入口（推荐）
├── run_server.py             ← 兼容旧入口，转交 serve.py
├── index.html  app.js  style.css
├── particle-test.html        ← 粒子场景独立测试页
├── src/                      ← 新增模块
│   ├── hand-input.js         ← 统一手势总线 (tasks-vision)
│   ├── particle-scene.js     ← 可嵌入粒子场景 (ParticleScene)
│   └── fish-manifest.js      ← 统一鱼类清单
├── glb-pointcloud.js  fish-swim.js  mesh-stipple.js
├── water-effects.js  water-ripple.js  serial.js  phone.html
├── assets/
│   ├── models/               ← 鱼影 + 鱼灯 GLB（主程序 craft 流程）
│   ├── particle-models/      ← 粒子场景稠密 GLB（含虾灯/蟹灯）
│   ├── craft-lanterns/  *.png
└── outputs-video/            ← 非遗工艺全屏体验（同源 iframe）
```

---

## 常见问题

**一直停在加载页 / 黑屏**：F12 → Network 看是否有 `.js` / `.glb` 报 404；本包应全部 200。务必用 `serve.py` 启动，不要直接双击 `index.html`（`file://` 下 ES module 与摄像头都会被浏览器拦截）。

**工艺 iframe 空白**：确认存在 `outputs-video/index.html`，并用 `http://localhost:8081` 打开。

**摄像头无法开启**：需 `localhost` 或 HTTPS；检查是否被其它程序占用、是否已授权。

**手机控制（phone.html）连不上**：PeerJS 依赖公网信令服务器，纯内网 / 离线环境不可用。

**伙伴电脑打不开**：必须发整个文件夹，并让对方运行 `python serve.py`。
