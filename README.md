# minizep

给 AI agent 用的**时序知识图谱记忆**框架 —— 手搓的 mini 版 [GetZep / Graphiti](https://github.com/getzep/graphiti)。

不是"聊天记录 + 向量检索"，而是把对话和文档蒸成**实体—关系—事实**的图谱，每条事实带**时间有效期**。信息变更时旧事实被**失效而不是删除**，所以既能回答"现在什么是真的"，也能回答"去年这个时候什么是真的"。

## 为什么需要它

普通 RAG 的痛点是：文档更新后旧信息还在，模型会同时检索到互相矛盾的两个版本，自己也不知道该信谁。

minizep 的做法（对标 Graphiti）：

| 机制 | 说明 |
|---|---|
| **双时间轴** | `validAt`/`invalidAt` = 现实中何时为真；`createdAt`/`expiredAt` = 系统何时学到、何时不再采信 |
| **矛盾消解** | 新事实与旧事实冲突时，旧事实被标记 `expiredAt`，**保留在历史中可追溯** |
| **关系终止** | "Alice 离职了"不是新建一条 `LEFT` 边，而是给原 `WORKS_AT` 打上 `invalidAt` |
| **完整溯源** | 每个实体和事实都能追溯回产生它的 episode（原始文本） |
| **混合检索** | BM25 关键词 + 向量余弦，用 RRF 融合排序，支持时间旅行查询 |

## 架构

```
L0  Episode   原始数据（消息/笔记/文档片段）—— 一切的溯源终点
L1  Entity    抽取出的实体，带标签和会演化的摘要
L1  Fact      实体间的有向边，带时间有效期窗口
```

```
src/
  model/types.ts            数据模型 + isFactActive() 时间窗判定
  store/memory-store.ts     内存图存储（邻接索引）+ JSON 快照
  store/persistence.ts      原子化落盘 + 防抖
  pipeline/ingest.ts        摄取管线：抽取 → 去重 → 矛盾消解 → 失效
  search/retrieval.ts       手写 BM25 / 余弦 / RRF 融合
  provider/                 可插拔的 LLM 与 Embedding 实现
  server/mcp.ts             MCP server（stdio）
```

## 快速开始

```bash
npm install
npm test            # 49 项测试（时序语义/并发/幂等/存储一致性/迁移）
npm run demo        # 离线：mock 抽取器 + hash 向量，无需任何外部依赖
npm run demo:real   # 真实：DeepSeek 抽取 + 集群 GPU embedding
npm run mcp:smoke   # MCP 协议冒烟测试
```

## 生产化状态

| 能力 | 状态 |
|---|---|
| 时序语义单测（时间窗/时间旅行/历史保留） | ✅ 6 项 |
| 摄取串行化（并发不再产生重复实体） | ✅ 已用探针证实竞态真实存在（10 并发 → 10 个重复实体） |
| 幂等（同文本同 group 只摄取一次） | ✅ 基于内容哈希，大小写/空白无关 |
| LLM 失败隔离 + 重试恢复 | ✅ 失败原文保留并可 `retryFailed()` |
| Postgres + pgvector 存储后端 | ✅ 与内存实现跑同一套契约测试 |
| JSON → 数据库迁移 | ✅ 幂等，重映射实体 uuid，保留时间窗 |
| 测试隔离（独立 schema） | ✅ 每个测试文件独立 schema，可并行 |
| 检索下推数据库 | ✅ pgvector 向量 + Postgres 全文检索，与内存路径结果一致 |
| HTTP 服务 + token 鉴权 | ✅ 每 token 映射独立 namespace，隔离已验证 |
| 异步摄取 + 任务队列 | ✅ 有界并发、任务状态可查 |
| stdio ↔ HTTP 桥接 | ✅ 只支持 stdio 的客户端也能共享同一份图谱 |
| embedding 常驻 | ✅ 作业被取消后 24 秒内自动重投，服务自动恢复 |

### 数据库后端

```bash
bash infra/postgres/setup.sh          # 本地 Postgres 17 + pgvector 0.8.6（容器，数据持久化）
export MINIZEP_DATABASE_URL="$(cat /var/tmp/minizep-pg/url)"
export MINIZEP_EMBED_DIMS=1024        # 必须与实际 embedder 维度一致
npm run mcp                           # 自动使用 Postgres
```

不设 `MINIZEP_DATABASE_URL` 时回退到内存图 + JSON 快照（单机开发用）。

**向量维度是 schema 级的**：换 embedding 模型必须重建索引，否则启动时会明确报错而不是静默算错分数：

```bash
npm run migrate -- snapshot.json --reembed    # 重新计算向量并写入
```

### 两种运行形态

**stdio（单客户端）** —— 给 Claude Code / Cursor 用：

```json
{ "mcpServers": { "minizep": {
  "command": "node",
  "args": ["/home/evsio0n/.openclaw/workspace/minizep/dist/server/mcp.js"],
  "env": { "MINIZEP_EMBED_URL": "http://<gateway>:11435" }
} } }
```

**HTTP（多客户端）** —— 一个进程服务多个 agent，共享同一份图谱：

```bash
export MINIZEP_TOKENS="tokA:teamA,tokB:teamB"   # token -> 独立 namespace
npm run serve                                    # http://127.0.0.1:8787/mcp
curl localhost:8787/health
```

没有配置 token 时服务**拒绝启动**（除非显式设 `MINIZEP_ALLOW_ANONYMOUS=1`，仅限本地开发）。
每个 token 只能读写自己的 namespace，`graph_stats` 也只统计本 namespace。

**stdio 桥接 （客户端只支持 stdio，但要共享同一份图谱）**：

```json
{ "mcpServers": { "minizep": {
  "command": "node",
  "args": ["/home/evsio0n/.openclaw/workspace/minizep/dist/server/stdio-proxy.js"],
  "env": { "MINIZEP_HTTP_URL": "http://127.0.0.1:8787/mcp", "MINIZEP_TOKEN": "tokA" }
} } }
```

代理把请求原样转发给 HTTP 服务，所以所有客户端看到的是同一份记忆，token 决定 namespace；
新增工具时这个桥不需要跟着改。

### 异步摄取

抽取要调用 LLM（数秒），长文档不该让客户端干等：

```
add_memory { content: "...", async: true }  →  { job_id }
memory_job_status { job_id }                →  running / succeeded / failed
```

### Embedding 服务位置

集群 GPU 常驻 + 网关主机 Tailscale 直连（详见 `infra/embedding/`）：

```
agent ──► <gateway>:11435 ──► <compute-node>:<job-port> (llama.cpp)
```

- `llamacpp-serve.sh`：Slurm 作业模板（分区等占位符见文件头注释，路径用环境变量）。不固定节点；
  端口由作业号推导（`PORT_BASE + SLURM_JOB_ID % PORT_RANGE`），新旧作业落在同一节点也不冲突。
  启动时把 `<节点IP>:<端口>` 写入 `$BASE/endpoints/<jobid>`，退出时删除。
- `supervise.sh`：每 `INTERVAL` 秒检查一次，维护 `$BASE/current-target`（只指向健康的后端）。
- `embed-proxy.py`：TCP 转发到 `current-target`；没有可用后端时返回 HTTP 503 + JSON 错误，而不是直接断开。

**滚动续期**：Slurm 有 7 天时限，所以"常驻"靠提前换班，而不是等作业消失再重投：

1. 所有运行中/排队中的作业剩余时间都不超过 `LEAD`（默认 3 小时）时，提交新作业；一个都没有时同样提交（冷启动）。
2. 新作业的 `GET /health` 返回 200（模型加载完成）后，`current-target` 才原子地切到它（总是指向最新的健康作业）。
3. 切换满 `GRACE` 秒（默认 300）后，取消同名的旧作业。
4. 启动后或上次健康之后超过 `STALE_AFTER` 秒（默认 1800）仍不健康的作业会被取消，不再算作"已覆盖"，
   所以卡住的新作业不会挡住下一次续期。`squeue` 失败时这一轮什么都不做。

```bash
DRY_RUN=1 ONCE=1 BASE=<job-dir> infra/embedding/supervise.sh   # 只打印决策，不做任何改动
bash infra/embedding/test/supervise.test.sh                     # 假 squeue/sbatch/scancel/curl/getent
python3 infra/embedding/test/test_embed_proxy.py
```

> 本文档中的 `<gateway>` / `<compute-node>` 是占位符；实际部署时由 `MINIZEP_EMBED_URL` 指定。

## 接入 MCP 客户端

```bash
npm run build
```

在 Claude Code / Cursor 的 MCP 配置里加入：

```json
{
  "mcpServers": {
    "minizep": {
      "command": "node",
      "args": ["/home/evsio0n/.openclaw/workspace/minizep/dist/server/mcp.js"],
      "env": {
        "MINIZEP_DB": "/home/evsio0n/.minizep/graph.json",
        "MINIZEP_EMBED_URL": "http://127.0.0.1:11435"
      }
    }
  }
}
```

### 暴露的工具

| 工具 | 用途 |
|---|---|
| `add_memory` | 摄取文本，返回抽取到的实体/新事实/被失效的事实 |
| `search_facts` | 混合检索（可传 `at` 时间旅行、`include_historical` 查历史） |
| `facts_about` | 某实体的全部事实及有效期 |
| `facts_at` | 指定时刻图中为真的事实 |
| `list_entities` / `list_episodes` | 实体列表 / 原始 episode（溯源） |
| `graph_stats` | 图谱统计 |

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `MINIZEP_DB` | `~/.minizep/graph.json` | 快照路径 |
| `MINIZEP_GROUP` | `default` | 默认命名空间（多租户/多项目隔离） |
| `MINIZEP_LLM_PROVIDER` | `deepseek` | 从 `~/.openclaw/openclaw.json` 读取凭据 |
| `MINIZEP_LLM_MODEL` | `deepseek-flash` | **不要用 `deepseek-v4-pro`**（见下） |
| `MINIZEP_LLM_API_KEY` / `MINIZEP_LLM_BASE_URL` | — | 显式覆盖，优先于配置文件 |
| `MINIZEP_EMBED_URL` | `http://127.0.0.1:11435` | llama.cpp / vLLM / 任意 OpenAI 兼容端点 |
| `MINIZEP_EMBED_MODEL` | `qwen3-embed` | |

### 关于 LLM 选择

实测 `deepseek-v4-pro` 是推理模型，4000 tokens 的预算**会全部被 `reasoning_content` 吃掉**，`content` 返回空字符串（耗时 50s+）。抽取任务用 `deepseek-flash` 即可：9~17s，合法 JSON。

### 关于 Embedding

推荐本地 llama.cpp + Qwen3-Embedding-0.6B。注意**新版 ollama 不再编译 SM70 内核**，V100 上只能跑 CPU；用 llama.cpp 从源码编译（`-DCMAKE_CUDA_ARCHITECTURES=70`）才能真正用上 GPU：

```bash
llama-server -m qwen3-embed-q8.gguf --embedding --pooling last -ngl 99 --port 11435
```

实测（50 条批量）：llama.cpp/V100 是 ollama/CPU 的 **2.24×**。

## 已知限制

1. **无级联失效** —— "Alice 离职"只失效 `WORKS_AT`，依附它的 `HAS_ROLE` 仍为活跃状态。需要依赖约束或在 prompt 里要求级联。
2. **重复抽取噪声** —— 同一段文本多次摄取可能产生大小写不同（`Staff Engineer` vs `staff engineer`）的实体变体，目前只做精确名称匹配去重，没有实体消歧（Graphiti 用 LLM 做 dedup）。
3. **快照体积** —— 向量直接存进 JSON，1024 维 × 每条实体/事实。1000 条量级约数十 MB，量大时应把向量拆到独立的二进制/向量库。
4. **矛盾检测偏保守** —— 依赖 LLM 判断，且 `invalidations` 是主路径，`detectContradiction` 只作兜底。
5. **检索未下推数据库** —— 见上文"P1 遗留"；向量与关键词检索都还在 Node 进程内完成。
5. **无 community 层** —— 没有 Graphiti 的 L2 社区聚类与增量摘要。

## 打包与部署

```bash
npm run build                 # 编译到 dist/
npm pack                      # 生成 minizep-0.2.0.tgz（53 文件 / 46.5 kB）
```

包内含 4 个可执行文件：

| 命令 | 用途 |
|---|---|
| `minizep-serve` | HTTP MCP 服务（多客户端、token 鉴权） |
| `minizep-mcp` | stdio MCP 服务（单客户端，本地进程内图谱） |
| `minizep-proxy` | stdio ↔ HTTP 桥接 |
| `minizep-migrate` | JSON 快照 → 数据库迁移 |

安装后可直接使用：

```bash
npm install ./minizep-0.2.0.tgz
npx minizep-serve            # 缺 token 时会明确拒绝启动
```

### 生产必需的环境变量

容器/CI 里读不到开发机的个人配置，这些必须显式提供：

| 变量 | 必需 | 说明 |
|---|---|---|
| `MINIZEP_TOKENS` | ✅ | `token:group,...`；不设则拒绝启动 |
| `MINIZEP_LLM_API_KEY` + `MINIZEP_LLM_BASE_URL` | ✅ | 抽取用的 LLM |
| `MINIZEP_REQUIRE_REAL_PROVIDERS=1` | 建议 | 缺少 LLM 时**直接启动失败**，而不是静默降级成 mock 抽取器 |
| `MINIZEP_DATABASE_URL` | 建议 | 不设则用进程内内存图 |
| `MINIZEP_EMBED_URL` / `MINIZEP_EMBED_DIMS` | 建议 | 维度必须与实际模型一致 |

不设 `MINIZEP_REQUIRE_REAL_PROVIDERS` 时会打出醒目告警后回退到 `MockLLMProvider`
（规则抽取器，产出的数据没有意义）—— 生产环境务必打开这个开关。

### 容器

```bash
docker build -t minizep:0.2.0 .
docker run --rm -p 8787:8787 \
  -e MINIZEP_TOKENS="tokA:teamA" \
  -e MINIZEP_DATABASE_URL="postgres://user:pass@host:5432/minizep" \
  -e MINIZEP_EMBED_URL="http://<gateway>:11435" \
  minizep:0.2.0
```

镜像以非 root（`node`）运行，带 `HEALTHCHECK` 打 `/health`。

## 来源与依赖

代码全部手写（TypeScript），设计对标 Graphiti/Zep 的**架构思路**（Episode/Entity/Fact 三层、
双时间轴、RRF 混合检索、MCP 工具面），未移植任何第三方代码 —— Graphiti 是 Python，
本项目是 TypeScript，不存在代码复用。

运行时依赖仅 3 个，均为 MIT：

| 依赖 | 用途 |
|---|---|
| `@modelcontextprotocol/sdk` | MCP 协议与传输 |
| `pg` | PostgreSQL 驱动 |
| `zod` | 工具入参校验 |

外部组件：Qwen3-Embedding-0.6B（Apache-2.0，经 llama.cpp 推理）、PostgreSQL + pgvector。
本仓库 `license` 字段为 `UNLICENSED`（内部项目），如需开源发布请先确定许可证。

## 参考

- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory (arXiv 2501.13956)](https://ar5iv.labs.arxiv.org/html/2501.13956)
- [Graphiti 仓库](https://github.com/getzep/graphiti)

## 许可证

本仓库尚未指定开源许可证（`package.json` 中标记为 `UNLICENSED`，且 `private: true` 以阻止误发布到 npm）。
在明确选择许可证之前，默认保留所有权利。
