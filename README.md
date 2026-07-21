# bili2bgm

把 **Bilibili** 的追番/追剧列表（观看状态、个人评分、短评）迁移到 **[bgm.tv](https://bgm.tv)**。

一次性工具，以 **Claude 技能**的形式交付：抓取阶段由 Claude 直接操作你已登录的 Chrome 完成，
确定性的部分（字段映射、进度解析、合并、校验、断点续传）由技能自带的脚本负责。

在你亲自打开生成的核对页面、逐条确认并导出决策文件之前，不会向 bgm.tv 写入任何东西。
设计理由见 [spec.md](spec.md)，本文是操作手册。

**仓库和技能里都不含任何账号信息**：B 站 uid 从你已登录的浏览器会话里读取，bgm 用户名运行时传入，
token 只走环境变量。

## 流程

```
Phase 1    Claude 操作你的 Chrome   ──▶ data/bili-export.json
Phase 1.5  与 bgm 搜索结果匹配      ──▶ data/plan.json + out/review-page.html
  你       打开页面，勾选确认        ──▶ data/decisions.json
Phase 2    写入 bgm.tv              ──▶ out/state.jsonl + out/report.md
```

每个联网阶段都先落盘再进入下一步，重跑读缓存，不会反复打两边的 API。核对页面完全离线、不持有 token。

## 准备

- Node 20+（**无需 `npm install`**，本项目零依赖）
- Google Chrome，装有 Claude 浏览器扩展并已连接，且已登录 B 站
- bgm.tv 账号；Phase 2 需要在 [next.bgm.tv/demo/access-token](https://next.bgm.tv/demo/access-token) 取 token

> 为什么必须是你自己的 Chrome：B 站有 WBI 签名、`buvid3` 指纹等反爬，全新的无头浏览器会被 `-412` 拒掉。
> 而 Chrome 136 起，用默认配置目录启动时 `--remote-debugging-port` 会被忽略（防 cookie 窃取），
> 所以旧的 CDP/Playwright 方案已经不可用——只能由 Claude 通过浏览器扩展在你已登录的页面里发请求。

## 步骤

### 1. 抓取 B 站数据

直接对 Claude 说：**“把我的 B 站追番列表迁移到 bgm”**（或“继续上次的迁移”）即可。

它会先校验会话并读出 uid，然后分组抓取六个列表（追番/追剧 × 想看/在看/看过），
再逐条取个人评分与短评。请求严格串行且带随机延迟，几百条约需 **6–8 分钟**——这期间别去动那个 Chrome 窗口。

→ `data/bili-export.json`

**随时可以打断。** 每抓一批就落盘一次，重跑只补没抓到的部分。
若返回 `-412`（B 站软限流）：立即停止，**至少等 10 分钟**再继续，已抓到的不会丢。不要立刻重试，那会把软限制变成硬封。

想自己看进度：

```bash
npm run merge -- status
```

### 2. 与 bgm 匹配

```bash
npm run phase15 -- --bgm-user <你的bgm用户名>
```

逐条搜索并分为三档：

| 档位 | 含义 | 默认 |
|---|---|---|
| **perfect** | 标题归一化后完全一致且年月吻合（或唯一候选） | included |
| **attention** | 有歧义，附带前 3 个候选 | 需你处理后才计入 |
| **dup** | bgm 上已收藏 | 永不触碰 |

`--bgm-user` 用于查重，可省略（也支持 `BGM_USER`、环境里的 `BGM_TOKEN`、或交互式输入）；
都没有就跳过查重并给出警告——Phase 2 写入前仍会逐条复查，不会覆盖已有收藏。

搜索结果缓存在 `cache/search/`，重跑不产生新的 bgm 请求。

→ `data/plan.json`、`data/bgm-existing.json`、`out/review-page.html`

### 3. 核对（这一步等于签字）

双击打开 `out/review-page.html`。页面自包含，离线可用，不联网。

- **主表格**默认全选中，勾选某行表示**排除**它。
- 评分可直接改（B 站 0–10 会按曲线换算到 bgm，见 spec.md §3）。
- 短评默认发送，可按行或全局排除。
- **观看进度默认不发送。** B 站的进度是自由文本（`看到第7话`、`已看完第12集`、`看到丰川祥子 0:23`），
  约四分之一解析不出来。进度区会把原始字符串和解析结果并排显示，你确认无误再勾选。没勾的行不会发任何
  分集请求——数字错了会静默改写观看记录，所以默认不信任。
- **attention** 行需要选定候选或填入 subject id，才会计入。

点 **Export**，复制 JSON，存为 `data/decisions.json`。

### 4. 写入 bgm.tv

token 请自己在终端里导出，**不要贴进对话**：

```bash
export BGM_TOKEN=...
export BGM_UA="yourname/bili2bgm (one-shot migration)"

npm run apply -- --dry-run                 # 打印全部请求，不发送
npm run apply
```

限速约 1 req/s 并带抖动。**任何时候都可以 Ctrl-C**：`out/state.jsonl` 只追加，重跑会跳过已完成的行，
不会重复写入；收藏已写但分集失败的行会从分集那步续跑。

失败处理：429/5xx 指数退避并遵守 `Retry-After`；401/403 立即整体中止（token 或 UA 有问题，硬重试有封号
风险）；单行 400/404 记录后继续；连续 3 行失败则暂停等你排查。

```bash
npm run verify -- --sample 10
```

随机抽查已写入的条目。最后看 `out/report.md`：分类统计、失败原因、dup 列表、未处理的 attention 行及其
搜索链接。token 不会出现在任何日志或产物里。

## 目录

```
.claude/skills/bili2bgm/      技能本体，自包含，可单独发布
  SKILL.md                    Claude 的操作手册：判断、节奏、两个人工关卡
  snippets/                   页内 fetch 脚本（含节流与 -412 中止逻辑），原样执行
  scripts/phase1-merge.js     合并、校验、断点续传：merge / status / finalize
  scripts/phase15-plan.js     匹配、查重、生成核对页面
  scripts/phase2-apply.js     写入 CLI：apply [--dry-run] | verify --sample N
  scripts/lib/                契约校验、进度解析、限速
  assets/template.html        核对页面模板
data/ cache/ out/             已 gitignore——你的个人数据与运行状态
```

四个 JSON（`bili-export`、`plan`、`decisions`、`state`）是各阶段之间的接口，都带 `schema_version`
并在边界校验。

## 常见问题

**Claude 说连不上浏览器** — 需要 Chrome 装有 Claude 扩展并处于已连接状态；应用内的预览浏览器不行，
它没有你的 B 站登录态。

**提示未登录** — 抓取前会先校验会话。在扩展连接的那个 Chrome 窗口里登录 B 站即可；
uid 是从会话读的，不需要也不接受手动指定。

**`-412`** — B 站软限流。等 10 分钟以上再继续，进度不丢。

**某条搜不到** — 会落到 attention 档。在页面上把正确的 `bgm.tv/subject/…` 里的 id 填进去。

**分集数写错了** — 说明勾选了解析有误的行。请直接去 bgm 上改，本工具不做回滚。

## 范围

仅一次性迁移，不做增量同步、不做反向同步、除核对页面外无其它界面。只读取你自己的数据，只写入你自己的 bgm 收藏。
