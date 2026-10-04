# FanOrbit

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform: Chrome Extension](https://img.shields.io/badge/Platform-Manifest%20V3-purple)

将你的头像置于中心，粉丝按互动频率由内向外环绕，生成一张同心环「粉丝纪念头像墙」（JPG）。内三环放大突出互动最高的核心粉丝，无互动记录的粉丝随机散布外环。

**数据来源全部公开**：粉丝列表来自你已登录浏览器的 followers 页；互动数据来自 fxtwitter / Yahoo! Japan 实时搜索 / Bing 三个免登录公开源，**不需要 X API 密钥**，互动扫描环节也无需登录。

---

**English**: FanOrbit places your own avatar at the center and orbits your fans around it as concentric rings, ordered by interaction frequency from the innermost ring outward; fans without any interaction data are placed randomly among the outer rings, with the three inner rings enlarged for the core fans. Fan collection approach referenced from [qiujiu-dev/XAvatarWall](https://github.com/qiujiu-dev/XAvatarWall); interaction scoring scheme inspired by [acnekot/NekoCircle](https://github.com/acnekot/NekoCircle) (reimplemented, no code copied: NekoCircle is AGPL-3.0).

## 安装 Installation

1. Chrome / Edge：打开 `chrome://extensions`（或 `edge://extensions`）。
2. 开启右上角「开发者模式 / Developer mode」。
3. 「加载已解压的扩展程序 / Load unpacked」，选择本目录 `FanOrbit/`。

## 使用 Usage

1. 点击工具栏 FanOrbit 图标打开控制面板。
2. 输入 X 用户名（不带 `@`），选择数量上限、头像大小、背景色、标题与扫描深度。
3. 「开始制作」：
   - 阶段 1 — 扩展自动打开 `https://x.com/<用户名>/followers`，自动滚动采集粉丝列表（含断点续采）。
   - 阶段 2 — 后台同时从 Yahoo! 实时搜索与 fxtwitter 抓取公开推文互动（回复 / 引用 / 提及 / 转发），按用户名合并去重并评分。
   - 阶段 3 — 打开生成页，绘制同心环头像墙并自动下载 `FanOrbit.jpg`。

## 布局规则 Layout rules

- 中心：你自己的头像（自动通过 fxtwitter 获取，获取失败时使用占位徽标）。
- 内环 → 外环：互动分从高到低。
- 没有任何互动记录的粉丝：随机散布在外侧各环。

## 评分方法 Scoring

- 事件来源：Yahoo 实时搜索（`@name -from:name` 入站，`ID:name` 出站）、fxtwitter `/search?q=@name` 与 `/profile/name/statuses?with_replies=true`。
- 类型权重：reply 1.0、quote 0.8、mention 0.6、repost 0.4。
- 方向权重：入站（粉丝 → 你）1.5，出站（你 → 粉丝）0.5。
- 时间衰减：2 天内 1.0，5 天内 0.95，之后指数衰减（特征时间 15 天）。
- 双向平衡：`final = (in×1.5 + out×0.5) × (0.7 + 0.3 × balance)`。

## 注意事项 Caveats

- 三个互动数据源的可用性视网络环境而定，扫描节点后会自动降级并在状态栏报告：
  1. **fxtwitter**（全球可用，最稳）：近期回复 / 引用 / 转发 / 提及。
  2. **Yahoo! 实时搜索**：仅限日本出口 IP，约 30 天完整提及历史；无法访问时自动跳过。
  3. **Bing 网页搜索**：全球可用，但依赖搜索引擎对 x.com 的索引（近 7 天）；部分地区的必应会对结果做过滤，效果视环境而定。
- 没有 NekoCircle 那样的服务器代抓能力，所有抓取都在本机进行，因此出口 IP 决定可用源；无日本节点时仅有 fxtwitter + Bing 两源，覆盖范围稍窄，机制上依然完整可用。

- Yahoo! 实时搜索接口仅对日本 IP 开放。所在地无日本节点时该源不可用，扩展会自动回退到 fxtwitter 单源（覆盖范围略小），并在状态栏提示。
- 两个公开源都只覆盖近期（通常数周内）的可检索推文，更早的互动不计入评分——这正与「最近有互动者靠内、长期无互动者靠外」的预期一致。
- 粉丝采集需要浏览器已登录 X，且粉丝页保持打开状态直到采集完成。
- 请自行遵守 X 的服务条款与目标网站的使用政策。

## 项目结构

```
FanOrbit/
├── manifest.json      扩展清单（Manifest V3）
├── popup.html/css/js  控制面板
├── background.js      调度：采集 → 互动扫描 → 评分 → 打开生成页
├── collector.js       粉丝列表采集内容脚本
├── db.js              IndexedDB 头像缓存
├── downloader.js      头像下载（重试 + 缓存）
├── generator.html/js  同心环头像墙绘制与 JPG 输出
├── lib/scoring.js     互动评分
├── lib/interaction.js fxtwitter / Yahoo / Bing 公开数据采集
├── lib/util.js        共享工具函数
└── assets/            图标
```

## 许可证 License

本项目以 [MIT License](LICENSE) 开源。欢迎自由使用、修改与分发（含商用）；请保留版权声明。
