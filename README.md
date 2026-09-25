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
| **混合检索** | BM25 关键词 + 向量余弦，用 RRF 融合排序；靠近查询所提实体的事实略微加分（图距离），无关结果被截掉；支持时间旅行查询 |

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
  search/rerank.ts          图距离加分 + 相关度截断（内存与 Postgres 两条路径共用）
  provider/                 可插拔的 LLM 与 Embedding 实现
  server/mcp.ts             MCP server（stdio）
```

## 快速开始

```bash
npm install
npm test            # 时序语义/并发/幂等/存储一致性/迁移；Postgres 用例只连一次性数据库（见 docs/DEPLOY.md）
npm run demo        # 离线：mock 抽取器 + hash 向量，无需任何外部依赖
npm run demo:real   # 真实：DeepSeek 抽取 + 集群 GPU embedding
npm run mcp:smoke   # MCP 协议冒烟测试
```

## 部署

在 Linux 主机上以 systemd 服务运行 HTTP 服务（MCP 与 REST 同一端口，只监听回环和 VPN 地址，
后端是本机 Postgres + pgvector 容器和远端 embedding 服务）：

```bash
sudo deploy/install.sh --user minizep     # 构建、安装 unit、生成 /etc/minizep/minizep.env（不启动）
sudoedit /etc/minizep/minizep.env         # 填地址、token（deploy/tokens.sh）、数据库、embedding
sudo deploy/install.sh --user minizep     # 启用、重启、等 /health 就绪
```

- [docs/DEPLOY.md](docs/DEPLOY.md)：拓扑、只在 VPN 上暴露、token 与 group、轮换 token、接入 MCP 客户端、
  REST 快速上手、Web UI、测试数据库、升级与回滚、embedding 换班
- [docs/API.md](docs/API.md)：MCP 工具与 REST（`/v1`）接口，以及可选的 Web UI（`/ui`，`MINIZEP_UI_GROUPS`）

## 生产化状态

| 能力 | 状态 |
|---|---|
| 时序语义单测（时间窗/时间旅行/历史保留） | ✅ 双时间轴：有效时间 `at` + 知识时间 `as_of` |
| 摄取串行化（并发不再产生重复实体） | ✅ 按 group 加锁：同一 group 串行，不同 group 并发（竞态曾用探针证实：10 并发 → 10 个重复实体） |
| 幂等（同文本同 group 同一天只摄取一次） | ✅ 键 = 规范化内容哈希 + `validAt` 的 UTC 日期，或显式 `idempotencyKey`；只跳过已处理成功的重复，失败/未完成的原地重新处理 |
| LLM 失败隔离 + 重试恢复 | ✅ episode 先以 pending 落盘，失败标记 failed 并保留原文，`retryFailed()` 原地重试；启动时恢复 pending |
| Postgres + pgvector 存储后端 | ✅ 与内存实现跑同一套契约测试 |
| JSON → 数据库迁移 | ✅ 幂等，重映射实体 uuid，保留时间窗 |
| 测试隔离（独立 schema） | ✅ 每个测试文件独立 schema，可并行 |
| 检索下推数据库 | ✅ pgvector 向量 + Postgres 全文检索，与内存路径结果一致 |
| HTTP 服务 + token 鉴权 | ✅ token → 允许的 group 列表（第一个为默认），越权 `group_id` 被拒绝；会话绑定创建它的 token |
| 异步摄取 + 任务队列 | ✅ 有界并发、任务状态可查；返回 job id 前 episode 已落盘，重启不丢 |
| stdio ↔ HTTP 桥接 | ✅ 只支持 stdio 的客户端也能共享同一份图谱 |
| embedding 常驻 | ✅ 到时限前滚动换班（新作业健康后才切换），作业消失时自动重投 |

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
  "args": ["/path/to/minizep/dist/server/mcp.js"],
  "env": { "MINIZEP_EMBED_URL": "http://<gateway>:11435" }
} } }
```

**HTTP（多客户端）** —— 一个进程服务多个 agent，共享同一份图谱：

```bash
export MINIZEP_TOKENS="tokA:teamA|shared,tokB:teamB"   # token -> 允许的 group，第一个为默认
npm run serve                                           # http://127.0.0.1:8787/mcp
curl localhost:8787/health                              # 只返回 {"ok":true}
```

没有配置 token 时服务**拒绝启动**（除非显式设 `MINIZEP_ALLOW_ANONYMOUS=1`，仅限本地开发）。
每个 token 只能读写它列出的 group：不传 `group_id` 用默认 group，传了不在列表里的 group 会被拒绝；
MCP 会话绑定创建它的 token，别的 token 拿着这个会话 id 会得到 403。

**stdio 桥接 （客户端只支持 stdio，但要共享同一份图谱）**：

```json
{ "mcpServers": { "minizep": {
  "command": "node",
  "args": ["/path/to/minizep/dist/server/stdio-proxy.js"],
  "env": { "MINIZEP_HTTP_URL": "http://127.0.0.1:8787/mcp", "MINIZEP_TOKEN": "tokA" }
} } }
```

代理把请求原样转发给 HTTP 服务，所以所有客户端看到的是同一份记忆，token 决定能用哪些 group；
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
  端口由作业号推导（`PORT_BASE + SLURM_JOB_ID % PORT_RANGE`），该端口在节点上已被占用时（例如同节点上
  另一个作业号相差 `PORT_RANGE` 整数倍的作业）顺延到范围内下一个空闲端口。
  启动时把 `<节点IP>:<端口>` 写入 `$BASE/endpoints/<jobid>`，退出时删除。
- `supervise.sh`：每 `INTERVAL` 秒检查一次，维护 `$BASE/current-target`（只指向健康的后端）。
- `embed-proxy.py`：TCP 转发到 `current-target`；没有可用后端时返回 HTTP 503 + JSON 错误，而不是直接断开。

**滚动续期**：Slurm 有 7 天时限，所以"常驻"靠提前换班，而不是等作业消失再重投：

1. 所有运行中/排队中的作业剩余时间都不超过 `LEAD`（默认 3 小时）时，提交新作业；一个都没有时同样提交（冷启动）。
   剩余时间为 `INVALID`（已超时限）的作业不算覆盖。
2. 新作业的 `GET /health` 返回 200（模型加载完成）后，`current-target` 才原子地切到它（总是指向最新提交的健康作业；
   新旧按提交时间判断，不按作业号，因为作业号会回绕）。健康检查直连节点，不走环境变量里的代理。
3. 切换满 `GRACE` 秒（默认 300）后，取消同名的旧作业。
4. 运行中的作业从 supervisor 第一次看到它健康检查失败起，连续失败超过 `STALE_AFTER` 秒（默认 1800）就被取消，
   不再算作"已覆盖"，所以卡住的新作业不会挡住下一次续期。返回 200、作业被重新排队（requeue），
   或 supervisor 停了超过 `STALE_AFTER` 秒之后，都重新计时，所以 supervisor 重启不会误杀正在服务的作业。
5. 所有作业都健康检查失败时（问题可能在网关这边），`current-target` 指向的作业不取消，但不再算覆盖，
   会提交替补；等有作业恢复健康再取消它。
6. 被 hold 的排队作业（`JobHeldUser`、`JobHeldAdmin`、`launch failed requeued held`）不会自己启动，
   直接取消并重投。需要手动 hold 作业时先停掉 supervisor。

`squeue` 失败时这一轮什么都不做。同一个 `BASE` 只能有一个 supervisor（`flock`），`DRY_RUN=1` 可以同时旁观。

```bash
DRY_RUN=1 ONCE=1 BASE=<job-dir> infra/embedding/supervise.sh   # 只打印决策，不做任何改动
bash infra/embedding/test/supervise.test.sh                     # 假 squeue/sbatch/scancel/curl/getent/ss
python3 infra/embedding/test/test_embed_proxy.py
```

**从旧版 supervisor 迁移**：旧作业脚本固定端口和节点，也不写 `endpoints/`；只换 `supervise.sh` 的话，
续期提交的仍是旧脚本，新作业永远不会成为目标，旧作业到时限照样断服。所以要一起换：

1. 停掉旧的 supervisor（`kill <pid>`）。
2. 把 `infra/embedding/llamacpp-serve.sh` 复制到 `$BASE/llamacpp-serve.sh`（`JOBSCRIPT` 的默认值），
   填好分区等占位符。
3. `DRY_RUN=1 ONCE=1 BASE=<job-dir> infra/embedding/supervise.sh` 确认决策，再用 nohup 启动新的 supervisor。

正在运行的旧作业没有 `endpoints/<jobid>`，不做健康检查也不会被取消，`current-target` 保持原值；
到续期时提交的新作业健康后才切过去，旧作业在 `GRACE` 秒后取消。`JOBSCRIPT` 不写 `endpoints/` 时
supervisor 启动时会告警；运行超过 5 分钟仍没有发布端点的作业也会告警。

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
      "args": ["/path/to/minizep/dist/server/mcp.js"],
      "env": {
        "MINIZEP_DB": "/path/to/graph.json",
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
| `invalidate_fact` | 手工结束或撤回一条事实（历史保留，`as_of` 仍能看到修正前的认知） |
| `reopen_fact` | 撤销一次错误的结束或撤回：旧记录撤回并留在历史里，插入一份从原起点起有效的更正副本 |
| `graph_stats` | 图谱统计 |

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `MINIZEP_DB` | `~/.minizep/graph.json` | 快照路径 |
| `MINIZEP_GROUP` | `default` | stdio 模式的默认 group（HTTP 模式由 token 决定） |
| `MINIZEP_LLM_PROVIDER` | `deepseek` | 从 `~/.openclaw/openclaw.json` 读取凭据 |
| `MINIZEP_LLM_MODEL` | `deepseek-flash` | **不要用 `deepseek-v4-pro`**（见下） |
| `MINIZEP_LLM_API_KEY` / `MINIZEP_LLM_BASE_URL` | — | 显式覆盖，优先于配置文件 |
| `MINIZEP_EMBED_URL` | `http://127.0.0.1:11435` | llama.cpp / vLLM / 任意 OpenAI 兼容端点 |
| `MINIZEP_EMBED_MODEL` | `qwen3-embed` | |
| `MINIZEP_SEARCH_MIN_COSINE` | `0.4` | 检索的相关度下限：既没有关键词命中、也不靠近查询所提实体的事实，余弦低于它就不返回（见下） |

### 关于 LLM 选择

实测 `deepseek-v4-pro` 是推理模型，4000 tokens 的预算**会全部被 `reasoning_content` 吃掉**，`content` 返回空字符串（耗时 50s+）。抽取任务用 `deepseek-flash` 即可：9~17s，合法 JSON。

### 关于 Embedding

推荐本地 llama.cpp + Qwen3-Embedding-0.6B。注意**新版 ollama 不再编译 SM70 内核**，V100 上只能跑 CPU；用 llama.cpp 从源码编译（`-DCMAKE_CUDA_ARCHITECTURES=70`）才能真正用上 GPU：

```bash
llama-server -m qwen3-embed-q8.gguf --embedding --pooling last -ngl 99 --port 11435
```

实测（50 条批量）：llama.cpp/V100 是 ollama/CPU 的 **2.24×**。

## 已知限制

1. **级联失效只靠 prompt** —— "Alice 离职"时 prompt 要求 LLM 同时失效依附于它的 `HAS_ROLE`/`MEMBER_OF` 等事实，没有结构化的依赖约束；LLM 漏掉时依附事实仍为活跃。
2. **实体消歧有限** —— 名称相同（大小写无关）才合并，`Alice` 和 `Alice Chen` 仍是两个实体（查询侧 `findEntities` 会按前缀/子串/名称向量给出候选），没有 Graphiti 那样的 LLM dedup。
3. **快照体积** —— 向量直接存进 JSON，1024 维 × 每条实体/事实。1000 条量级约数十 MB，量大时应把向量拆到独立的二进制/向量库。
4. **矛盾检测依赖 LLM** —— 抽取给出的 `invalidations` 是主路径，`detectContradiction` 只对同一对实体之间的事实兜底判断；
   同源同关系、换了目标的事实只在一次只有一个值的关系上参与判断：`WORKS_AT`/`HAS_ROLE`/`HAS_TITLE`/`LIVES_IN`/`REPORTS_TO`，
   以及抽取标了 `replacesPrevious` 的事实（雇主、职位、住址、上级、归属这类关系，或文本说新值取代了旧值），
   因为多数关系可以同时有多个值（在多个数据集上评测、用多个工具）。判断要求两者不能同时成立，确认、补充、“不取代”都不算；
   漏判时旧事实不会被关闭，误判时用 `reopen_fact` 撤销（结束时间还在将来的也可以）。
5. **无 community 层** —— 没有 Graphiti 的 L2 社区聚类与增量摘要。
6. **单实例、单写入进程** —— MCP 会话在进程内存里，服务重启后客户端要重新初始化会话，也不能多个实例分担同一批会话。
   每个数据库只能有一个写入进程：启动时会接管所有 `pending` 的 episode，另一个进程若正在处理其中一条，会被重复抽取。
   需要多个客户端时用一个 HTTP 服务 + `minizep-proxy`，不要让 stdio 版 `minizep-mcp` 直连同一个库。
7. **`as_of` 只对事实的第一次变更精确** —— 每条事实只有一行，结束或撤回时就地改写。已经结束的事实不能就地改结束时间
   （返回冲突）：要么撤回，要么用 `reopen_fact` 撤回旧行、插入一份带正确结束时间（或仍然有效）的副本。撤回一条已结束的事实后
   （`reopen_fact` 也是如此），从结束到撤回之间那段时间的 `as_of` 查询会看不到它原来的结束时间（重开时记在旧行的属性里）。
8. **补录旧文档时依附事实可能漏关** —— 旧文档里的主关系（如 `WORKS_AT`）能正确落在已结束的窗口内，
   但同一篇里只在那段关系期间成立的附属事实（如"带领某团队"）不一定跟着关闭，LLM 在抽取旧文档时看不到后来的结束。
9. **检索的相关度截断是粗粒度的** —— 只截掉“没有关键词命中、不靠近查询所提实体、余弦低于 `MINIZEP_SEARCH_MIN_COSINE`”
   的事实。下限 0.4 按 Qwen3-Embedding-0.6B 标定（无关事实约 0.15–0.40，换语言或换说法的相关事实约 0.40–0.65），
   换模型要重新标定；英文查询里的 the/is 这类常见词也算关键词命中，英文图谱里截断因此很少生效。
10. **图距离加分认不出“枢纽”实体** —— 查询里点名的实体（及其一跳邻居）上的事实都加同样的分。点名的是项目这类
    所有组件都挂在它上面的实体时，加分落到它的每条事实上，分不出问题真正问的那个组件；所以加分刻意很小
    （约等于一个排名里第 1 名与第 10 名的差距），只在文本相关度相近的候选之间调整次序。实体按名字识别，
    查询里一个名字都没出现时才退到名称向量：换了叫法（查询说“那个服务”，实体叫“API 网关”）通常认不出来。
11. **没有第二个实体的事件只进摘要** —— 抽取规则要求事实的两端都是具名实体，所以"作业 X 被取消了"这类
    只涉及一个实体的事件会写进该实体的摘要，而不是一条事实；`search_facts` 查不到它，要用
    `facts_about`/实体摘要或原始 episode 才能看到。

## 打包与部署

systemd 部署（安装脚本、unit、env 文件、token）见 [docs/DEPLOY.md](docs/DEPLOY.md)；这里是打包和容器。

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
| `MINIZEP_TOKENS` | ✅ | `token:groupA\|groupB,...`（第一个 group 为默认）；不设则拒绝启动 |
| `MINIZEP_LLM_API_KEY` + `MINIZEP_LLM_BASE_URL` | ✅ | 抽取用的 LLM |
| `MINIZEP_REQUIRE_REAL_PROVIDERS=1` | 建议 | 缺少 LLM 时**直接启动失败**，而不是静默降级成 mock 抽取器 |
| `MINIZEP_DATABASE_URL` | 建议 | 不设则用进程内内存图 |
| `MINIZEP_EMBED_URL` / `MINIZEP_EMBED_DIMS` | 建议 | 维度必须与实际模型一致 |
| `MINIZEP_TIMEZONE` | 可选 | 解析“昨天”“下周五”等相对时间用的 IANA 时区（如 `Asia/Shanghai`），默认取进程时区；写错时启动失败，不会降级成 mock 抽取器 |

不设 `MINIZEP_REQUIRE_REAL_PROVIDERS` 时会打出醒目告警后回退到 `MockLLMProvider`
（规则抽取器，产出的数据没有意义）—— 生产环境务必打开这个开关。

全部环境变量（含会话、排空超时等）及默认值见 [`deploy/minizep.env.example`](deploy/minizep.env.example)。

### 容器

```bash
docker build -t minizep:0.2.0 .
docker run --rm -p 127.0.0.1:8787:8787 \
  -e MINIZEP_TOKENS="tokA:teamA" \
  -e MINIZEP_DATABASE_URL="postgres://user:pass@host:5432/minizep" \
  -e MINIZEP_EMBED_URL="http://<gateway>:11435" \
  minizep:0.2.0
```

镜像以非 root（`node`）运行，带 `HEALTHCHECK` 打 `/health`。容器内监听 `0.0.0.0`，
对外只发布到回环或 VPN 地址（`-p 100.64.0.10:8787:8787`），不要用裸 `-p 8787:8787` 发布到所有网卡。

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
