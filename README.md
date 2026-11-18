# Shop Agent Demo

基于大语言模型 Agent 的商店智能导购系统，包含商品交易、人工客服接待和受限智能导购，用于课程设计与演示。

## 功能

- 商品分类、多标签、共享属性、多个规格及图片管理。
- 买家账号、账号安全、最多三个常用地址、购物车、订单与模拟支付。
- 店长、经理、店员分工；工作账号与买家购物权限隔离，数据库预留多店铺能力。
- 持久聊天通道、按客服容量自动派单、转接、离线处理与接待记录。
- 人工优先，无空闲客服时由 Agent 接待；支持需求记忆、商品筛选、相关推荐、详情查询与转人工。
- 店员回复建议需人工确认；Agent 不能代买家下单、支付或修改商店数据。

订单流程截止到卖家已发货；支付为模拟行为，未接入真实物流、退款、评价及优惠券业务。对话通过 HTTP 与 SSE 更新，尚未实现模型逐字输出。

## 技术栈与目录

Node.js 24.21.x、pnpm 10.34.7、TypeScript、React、Vite、Fastify、Prisma、PostgreSQL 17.11。真实导购接入 DeepSeek Responses API，商品图片支持本地存储或火山引擎私有 TOS。

```text
apps/web/              前端
apps/shop-api/         商店接口、人工接待和 Agent 运行时
apps/agent/            外接 Agent 服务预留
packages/contracts/   接口类型与校验规则
packages/database/    数据模型、迁移与开发种子数据
scripts/              开发、验证、演示数据及部署工具
deploy/               容器、Nginx、证书续期与备份配置
```

数据库包含 20 张业务表、13 次迁移、34 条外键。数据库结构以 Prisma 模型和迁移 SQL 为准。

仓库仅保留此 README。开发交流、进度、验收截图、课程图纸及报告保存在本地，不纳入版本管理。

## 首次安装

需要 Docker、Docker Compose 和 nvm。在项目根目录执行：

```bash
nvm install
nvm use
npm install --global pnpm@10.34.7
pnpm install --frozen-lockfile
cp .env.example .env
```

编辑 `.env`：设置数据库密码，并同步修改 `DATABASE_URL` 中的密码。然后执行：

```bash
docker compose up -d --wait postgres
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

开发种子创建 `buyer_demo`、`seller_demo`、`manager_demo`、`staff_demo` 四个账号，初始密码在 `.env` 的 `DEMO_*_PASSWORD` 中配置。种子用于本地开发，重复执行不会重置已有密码、价格或库存，不应作为生产环境初始化工具。

## 已有环境启动与停止

已有数据库及依赖时，无需重新执行种子：

```bash
source ~/.nvm/nvm.sh
nvm use
docker compose up -d --wait postgres
pnpm dev
```

- 前端：<http://127.0.0.1:5173>
- 登录：<http://127.0.0.1:5173/#/login>
- 后端健康检查：<http://127.0.0.1:3000/api/health>

前后端默认仅监听本机。按 `Ctrl+C` 停止应用；数据库单独停止：

```bash
docker compose stop postgres
```

停止容器保留数据卷。API 重启后需要重新登录。

## Agent 与图片配置

`.env.example` 提供完整配置项，真实密钥仅放在后端环境变量中。

| 配置 | 作用 |
| --- | --- |
| `AGENT_MODE=mock` | 无需模型密钥的模拟导购 |
| `AGENT_MODE=deepseek` | 真实导购，需要 `DEEPSEEK_API_KEY`，调用会产生费用 |
| `AGENT_MODE=disabled` | 仅人工接待 |
| `SHOP_IMAGE_STORAGE=local` | 本地图片，上传目录需要持久化 |
| `SHOP_IMAGE_STORAGE=tos` | 私有 TOS，需配置地域、桶、端点及后端凭据 |

DeepSeek 使用专用直连传输，项目进程合并 `NO_PROXY` 排除项，不修改系统代理。TOS 图片由后端生成短期签名地址，浏览器直接从对象存储读取；密钥不发送给前端。

开发种子只提供基础目录；完整演示商品配置在 `scripts/data/demo-catalog-20261118.json`，记录商品、规格、图片来源及许可链接。以下命令默认检查或预览，不写入数据：

```bash
pnpm db:demo-catalog
pnpm db:demo-descriptions
```

执行商品目录写入需配置 TOS、准备素材并显式使用脚本的 `--prepare`、`--apply` 等参数。图片为实物示意，不保证与具体规格完全一致；素材来源与 [Pexels 许可](https://www.pexels.com/license/) 见商品配置。

## 验证与构建

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
```

接口与浏览器测试需要可用的开发数据库及基础演示数据，应在开发或隔离测试环境运行。

```bash
pnpm test:deepseek          # Responses API 连通性
pnpm test:deepseek:compat   # SDK 与工具调用兼容性
pnpm test:agent:live        # 真实 Agent 业务验证
```

真实模型测试需要密钥，并消耗模型额度。

## 部署

`deploy/` 提供 API、Web、PostgreSQL 的独立容器配置，以及证书续期和数据库备份脚本。采用本地构建、验证、传输镜像后在服务器运行的方式，服务器无需编译前端。

生产配置通过独立的 `.env`、`api.env`、`postgres.env` 提供，不提交到 Git。部署工具位于 `scripts/deploy/`，其中包含本次演示使用的路径、目标地址和验收条件；迁往新环境前应先核对参数，不能直接当作通用一键部署工具。

单个 API 进程维护会话、在线状态和任务队列；重启会失去这些临时状态，持久商品、订单和消息仍在 PostgreSQL 中。多实例部署需要另行实现共享会话与任务协调。

## 离线分词资源

`apps/shop-api/assets/deepseek-v4/` 中的两个 JSON 来自 DeepSeek 官方 [token 用量文档](https://api-docs.deepseek.com/quick_start/token_usage/) 链接的 [分词器归档](https://cdn.deepseek.com/api-docs/deepseek_v4_tokenizer.zip)，下载于 2026-10-22，文件未经修改。官方归档未附单独许可声明。

后端通过 `@huggingface/tokenizers`（Apache-2.0）离线估算请求用量，资源哈希固定在 `apps/shop-api/src/agent/budget.ts` 并在使用前校验，不在运行时下载或执行远程代码。估算加入余量，实际用量仍以模型服务返回结果为准。
