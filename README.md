# 小马甲决策指挥台 · GitHub Pages 静态演示

由本机 `xueqiu-insight-agent` 指挥台导出的只读静态快照，保留原界面、页签和交互，数据不实时更新。

## 在线演示

`https://littleqian12.github.io/bigv-finance-assistant/`

## 数据快照

- 快照时间：**2026/11/15 22:45**
- 来源：**小马甲（雪球用户 xxxx）**
- 日报：54 篇已归档日报，含历史切换与正文渲染
- 隔日建议：11 份已归档报告，含逐帖核对
- 历史逻辑链：40 条
- 历史归档：500 条演示子集
- 随笔沉淀：100 条
- Kronos 运行记录：7 条，含预测详情与图表
- 采集诊断、运行状态、Author Agents、Hermes 技能、基础能力均保留了可展示数据

## 脱敏与边界

- 所有雪球账号 ID、`xueqiu.com/<uid>/` 与 `xueqiu.com/u/<uid>` 路径统一替换为 `xxxx`
- 本机绝对路径替换为 `/Users/xxxx`
- 不包含 `.env`、认证文件、会话正文、密钥或原始私聊内容
- 页面带 `noindex,nofollow`，并标注“非实时、不构成投资建议”
- 历史图片使用“图片证据已脱敏”占位图

## 哪些是快照，哪些是模拟

| 模块 | 来源 |
|---|---|
| 今日日报、隔日建议、逻辑链、随笔、历史归档、诊断、Kronos 记录 | 本机真实快照 |
| RAG 复核、Author Agents 操作、Kronos 新建预测、历史图片 | 前端模拟或占位 |
| 定时刷新、30 秒自动刷新 | 读取静态快照，不触发本机任务 |

所有按钮只在前端执行；不会连接本机 Dashboard、CDP、Kronos 或交易账户。

## 本地运行

```bash
node scripts/snapshot.mjs   # 需要本机 127.0.0.1:8788 指挥台在运行
node scripts/build-demo.mjs # 生成 docs/
node scripts/check.mjs
node scripts/smoke-test.mjs # 需要本机 Chrome
python3 -m http.server 8021 --directory docs
```

打开 `http://127.0.0.1:8021/`。

## 部署

`docs/` 为完整静态产物。推送到 `main` 后，GitHub Actions 会发布到 `gh-pages` 分支，GitHub Pages 从该分支提供站点。

## 说明

仅用于工程和界面展示，不构成投资建议，也不代表原帖作者观点。若来源方要求下线，删除 `gh-pages` 分支或仓库即可。
