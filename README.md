# DormHub · 寝室运营一本通

大学寝室 + 舍友一起用的**实用协作小站**：值日轮班 / 账单 AA / 寝室公约 / 共享清单，外加游戏小屋（P2P 联机牌局 + 四人麻将）。纯静态零依赖，视觉为「奢侈极简」风格：大留白、发丝线分隔、单一古铜强调色。

## 功能

- **首页仪表盘**：成员头像、本周值日、今天吃什么（随机 + 投票）、账单速览
- **值日轮班**：成员/任务管理，周轮换自动排班，完成打卡，两人互换（每周自动恢复）
- **账单 AA**：记一笔（描述/金额/垫付人/参与人），自动计算每人净额 + 最少转账方案，可结清
- **寝室公约**：公约列表，每人点成员名字表态「同意」
- **共享清单**：公共物资（常备/需补/已买）+ 物品借用登记（借出人/借用人/归还）
- **游戏小屋**（`game/`）：
  - **狼人杀**（完整规则联机，9/12 人预女猎守，文字发言计时，MQTT 房主权威）
  - **三国杀**（开源无名杀静态版：全武将包身份局/国战，单机 AI 随时玩；联机由房主跑 `noname-kit` 开服器，wss 地址进联机大厅）
  - **骗子博弈**（P2P 实时联机，3–9 人，PeerJS + WebRTC，房间号/二维码加入，断线自动迁移房主）
  - **中国古典四人麻将**（1 人 + 3 AI，摸牌吃碰杠胡牌算番，纯前端）

## 快速开始

```bash
cd dorm-hub
python -m http.server 8000
# 打开 http://127.0.0.1:8000
```

或直接双击 `index.html`（现代浏览器均支持）。
联机牌局建议走 http 访问（同 WiFi 下手机扫码即可加入）。

## 数据怎么存

纯静态站，**没有服务器、没有账号**。数据存在每个浏览器自己的 localStorage 里：

- 点「导出」下载 `dormhub-backup-日期.json`
- 舍友点「导入」选文件 → 数据一致（这就是当前的「同步」方式）
- 小数据（如只有值日表）用「分享」直接生成链接，点开即导入
- 「重置」清空本机数据（双重确认）

**注意**：页面是公开链接，任何拿到链接的人都能看到数据（但改动只影响他自己的浏览器）。不要放身份证号、成绩单等隐私信息。真正的多人实时同步需要后端服务，属于未来版本。

## 目录结构

```
dorm-hub/
├── index.html / styles.css / app.js    主站（设计系统在 styles.css 顶部 :root）
├── game/
│   ├── index.html                       游戏小屋
│   ├── werewolf/                        狼人杀（完整规则联机）
│   │   ├── index.html                   夜色 UI
│   │   └── scripts/                     config / mqtt-relay / engine / net / app
│   ├── sanguosha/                       三国杀（开源无名杀静态版，含裁剪说明见 _verify）
│   │   ├── index.html                   无名杀入口（注入 webfs-adapter.js：OPFS 文件适配）
│   │   └── game|image|audio|...         官方树，重压后 ~186MB
│   ├── liars-gambit/                    骗子博弈（开源集成，联机详见其 NETWORK.md）
│   │   ├── index.html                   单文件主体
│   │   └── scripts/                     运行时配置 / 网络 / 引擎（v=2026.02.23.4）
│   └── mahjong/                         中国麻将（开源集成，单人 + AI）
└── _verify/                             验证脚本与截图（基线 / 优化后 / 联机对局）
```

## 修改指南（改哪里）

- **换主题色 / 字体 / 圆角阴影**：`styles.css` 顶部 `:root` 里的 CSS 变量（`--accent` 是唯一强调色）
- **改首页卡片内容与文案**：`app.js` 里 `renderHome()` / `renderDuty()` / `renderBill()` / `renderRules()` / `renderShared()`
- **改顶栏按钮 / 弹窗 / 页脚**：`index.html`
- **改游戏小屋介绍与排查指引**：`game/index.html`
- **改联机行为（TURN/STUN/人数上限）**：`game/liars-gambit/scripts/runtime-config.js`（也可运行时在页面控制台注入 `window.__LG_NET_CONFIG__`，详见 `game/liars-gambit/NETWORK.md`）
- **三国杀更新/重裁**：`D:\issue\noname-kit\trim_noname.mjs`（重裁 → 覆盖 `game/sanguosha/`）；联机开服器在 `D:\issue\noname-kit\`（node + cloudflared 双击即用）
- **麻将规则/番种**：`game/mahjong/src/js/core/scoring/`

## 技术栈

原生 HTML5 + CSS + JavaScript（ES2020），零构建、零外部依赖（无 CDN 字体/库），国内网络直接可用。联机游戏运行时按需从 CDN 加载 PeerJS/QRCode（带 4 路 CDN 备援）。

## 已知限制

- 多设备不同步：不同浏览器数据各自独立，靠导出/导入手动同步
- localStorage 被清除/换设备即丢：**建议定期导出备份**
- 无鉴权：公开链接可见
- 联机牌局：对局中避免熄屏/切后台（WebRTC 连接会断）；严格对称 NAT 下若直连失败，已默认启用 TURN 中继兜底

## 验证

`_verify/` 内含基线截图（`baseline-*.png`）、优化后桌面/移动截图（`optimize-*.png`）、双标签页 P2P 联机大厅截图（`online-host-lobby.png` / `online-guest-lobby.png`）与冒烟测试结果（`optimize-smoke-result.json`）。复跑验证：

```bash
# 起服务后，用任意 CDP 客户端（Edge/Chrome --remote-debugging-port=9222）运行
# workspace 里的 .openclaw/tmp/smoke.js 与 verify-p2p4.js 为本次所用脚本
```
