# 部署 minizep HTTP 服务

在一台 Linux 主机上用 systemd 运行 minizep 的 HTTP 服务（MCP 和 REST 在同一个端口），只监听回环地址和
VPN 地址（例如 Tailscale），数据放在本机的 Postgres + pgvector 容器里，向量由远端的 OpenAI 兼容
embedding 服务计算。接口本身见 [API.md](API.md)。

文中的地址都是示例：`100.64.0.10` 是本机的 VPN 地址，`100.64.0.20` 是 embedding 网关，
`/srv/minizep` 是 checkout 路径，`minizep` 是服务账号。

## 拓扑

```
VPN 上的客户端（agent、脚本）
  │  Authorization: Bearer <token>
  ▼
Linux 主机
  minizep.service ── node dist/server/http.js，监听 127.0.0.1:8787 和 100.64.0.10:8787
    /mcp     MCP（Streamable HTTP）
    /v1/*    REST
    /health  存活检查，只返回 {"ok":true}，不需要 token
    /ui      Web UI（可选，设置 MINIZEP_UI_GROUPS 才有，不需要 token，见第 8 节）
      │
      ├──► Postgres + pgvector 容器，127.0.0.1:5433（只在回环上）
      ├──► embedding 网关 http://100.64.0.20:11435（经 VPN）──► Slurm 作业里的 llama.cpp
      └──► 抽取用 LLM（OpenAI 兼容 chat completions，HTTPS）
```

| 文件 | 作用 |
|---|---|
| `deploy/systemd/minizep.service` | unit 模板：重启策略、沙箱，每一项都有注释 |
| `deploy/minizep.env.example` | 服务读取的全部环境变量，分组注释，没有真实值 |
| `deploy/install.sh` | 幂等的安装/升级脚本 |
| `deploy/tokens.sh` | 生成 token，可选写入 env 文件 |
| `deploy/test/*.test.sh` | 上面两个脚本的测试（不需要 root，`bash deploy/test/install.test.sh`） |

## 1. 准备

- Linux + systemd，Node.js ≥ 20.11，git，Docker（跑 Postgres 容器）。
  服务里 node 的路径是写死的绝对路径；用 nvm 装的 node 换版本或卸载后要重新跑 `install.sh --node ...`，
  所以服务器上更推荐发行版或 NodeSource 的系统 node。
- 服务账号（不要用 root，也不要用日常登录的账号）：

  ```bash
  sudo useradd --system --create-home --shell /usr/sbin/nologin minizep
  sudo install -d -o minizep -g minizep /srv/minizep
  sudo -u minizep git clone <repo-url> /srv/minizep
  ```

- Postgres + pgvector（容器只绑定 `127.0.0.1:5433`）。`infra/postgres/setup.sh` 默认把数据放在
  `/var/tmp/minizep-pg`，很多发行版的 systemd-tmpfiles 会按时间清理 `/var/tmp`，生产环境换到持久目录：

  ```bash
  sudo MINIZEP_PGDIR=/var/lib/minizep-pg bash infra/postgres/setup.sh
  sudo cat /var/lib/minizep-pg/url      # 连接串（含生成的密码），下一步填进 env 文件
  ```

- VPN：主机已加入 tailnet，`tailscale ip -4` 能看到本机地址。

## 2. 安装

```bash
cd /srv/minizep
sudo deploy/install.sh --user minizep --node /usr/bin/node
```

第一次运行会：以 `minizep` 身份 `npm ci` + `npm run build`；渲染 unit 并装到
`/etc/systemd/system/minizep.service`；从 `deploy/minizep.env.example` 生成 `/etc/minizep/minizep.env`
（root 所有、600）；`systemctl daemon-reload`。env 文件里还有 `CHANGE_ME` 或 `MINIZEP_TOKENS` 为空时，
脚本**不会**启用和启动服务，而是提示先填配置：

```bash
sudoedit /etc/minizep/minizep.env
```

至少要填：

| 变量 | 内容 |
|---|---|
| `MINIZEP_HOST` | `127.0.0.1,100.64.0.10`：回环 + 本机 VPN 地址（见第 3 节） |
| `MINIZEP_TOKENS` | 用 `deploy/tokens.sh` 生成（见第 4 节） |
| `MINIZEP_DATABASE_URL` | 上一步 `url` 文件的内容。unit 开了 `PrivateTmp=`，服务自己读不到 `/var/tmp` 下的 url 文件 |
| `MINIZEP_EMBED_URL` / `MINIZEP_EMBED_DIMS` | embedding 网关地址和模型维度 |
| LLM | `MINIZEP_LLM_BASE_URL` + `MINIZEP_LLM_API_KEY`；两个都不设时读服务账号的 `~/.openclaw/openclaw.json` |

然后再跑一次同样的命令：这次会 `systemctl enable` + `restart`，并轮询回环地址上的 `/health`，
超时（默认 60 秒，`--health-timeout`）会打印 `systemctl status` 和最近 50 行日志后失败退出。

| 参数 | 说明 |
|---|---|
| `--user NAME` | 服务账号，不能是 root（默认 `$SUDO_USER`） |
| `--dir PATH` | 要构建和运行的 checkout（默认脚本所在的 checkout） |
| `--env-file PATH` | env 文件（默认 `/etc/minizep/minizep.env`）；已存在时**从不改动** |
| `--node PATH` | node 可执行文件（默认 PATH 里的；sudo 下 root 的 PATH 通常没有 nvm 的 node） |
| `--snapshot-dir PATH` | 仅内存存储：`MINIZEP_DB` 所在目录，创建给服务账号并在沙箱里设为可写 |
| `--health-timeout S` | 重启后等 `/health` 的秒数 |
| `--dry-run` | 只打印每一步和渲染出的 unit，不做任何改动（不需要 root） |

每一步都可以重复执行：unit 只在内容变化时重写（并打印 diff），env 文件只在不存在时创建。

日常操作：

```bash
systemctl status minizep
journalctl -u minizep -f                      # 启动日志里的 store= 一行应该是 postgres (...)
systemd-analyze security minizep              # 查看沙箱评分
```

不用 Postgres 的单机试用：env 文件里不设 `MINIZEP_DATABASE_URL`，设
`MINIZEP_DB=/var/lib/minizep/graph.json`，安装时加 `--snapshot-dir /var/lib/minizep`。
沙箱里整个文件系统只读，只有这个目录可写。

## 3. 只在 VPN 上暴露

- `MINIZEP_HOST` 列出回环和本机的 VPN 地址，例如 `127.0.0.1,100.64.0.10`。**不要在有公网网卡的主机上用
  `0.0.0.0` 或 `::`**：那样服务直接暴露在公网上，唯一的防线只剩 token（`install.sh` 发现通配地址会告警）。
- 回环地址要留着：`install.sh` 在那里检查 `/health`，本机的 stdio 代理也连它。
- 服务比 VPN 先起来时，VPN 地址还没分配（`EADDRNOTAVAIL`），服务按退避重试直到地址出现，
  回环地址先正常服务；unit 也排在 `tailscaled.service` 之后（只排序，不依赖）。
- 流量是明文 HTTP。Tailscale/WireGuard 本身加密了传输；不要不加 TLS 反向代理就在 VPN 之外的网络上提供服务。
- 确认监听的地址：

  ```bash
  sudo ss -ltnp | grep 8787      # 只应看到 127.0.0.1:8787 和 100.64.0.10:8787
  ```

- 用 VPN 的 ACL 再收紧一层：只有需要的设备能连 8787。Tailscale 策略文件示例（给主机打上
  `tag:minizep`，`group:agents` 是允许访问的用户组）：

  ```jsonc
  {
    "tagOwners": { "tag:minizep": ["autogroup:admin"] },
    "acls": [
      { "action": "accept", "src": ["group:agents"], "dst": ["tag:minizep:8787"] }
      // ……其余规则。定义了 acls 之后，没有列出的访问一律拒绝
    ]
  }
  ```

  主机防火墙可以作为补充，例如 ufw：`sudo ufw allow in on tailscale0 to any port 8787 proto tcp`，
  其余入站默认拒绝。
- Postgres 容器只绑定回环（`setup.sh` 的 `-p 127.0.0.1:5433:5432`），不要把它发布到 VPN 上。
- embedding 网关上的 `embed-proxy.py` 默认监听 `0.0.0.0`，在网关主机上用 `PROXY_LISTEN_HOST` 设成它的 VPN 地址。

## 4. Token 与 group

`MINIZEP_TOKENS` 是逗号分隔的 `<token>:<group>[|<group>...]` 列表：

```
MINIZEP_TOKENS=<tokenA>:teamA|shared,<tokenB>:teamB
```

- 每个 token 能用的 group 就是它列出的这些，**第一个是默认 group**。
- 请求不带 `group_id` 时用默认 group；带了且在列表里就用它；不在列表里直接拒绝
  （"group not permitted for this token"）。MCP 工具和 REST 走同一套规则。
- MCP 会话绑定创建它的 token：换一个 token 带着别人的会话 id 来请求会得到 403。会话空闲超过
  `MINIZEP_SESSION_TTL_MS`（默认 30 分钟）失效，最多同时 `MINIZEP_MAX_SESSIONS`（默认 256）个，
  超出时淘汰空闲最久的。
- 本机单用户的 stdio 服务（`dist/server/mcp.js`）不做这层检查，接受任意 `group_id`。

生成 token（32 字节随机数，base64url，43 个字符，不含 `,` `:` `|`）：

```bash
deploy/tokens.sh --group 'teamA|shared'           # 只打印一条 "token:groups"，不写任何文件
sudo deploy/tokens.sh --group teamB --append /etc/minizep/minizep.env
sudo systemctl restart minizep                    # env 文件只在启动时读取
```

`--append` 会先把 env 文件备份成 `minizep.env.bak.<时间>`（同样的权限），再原子地改写
`MINIZEP_TOKENS` 这一行。token 只显示这一次，通过私密渠道交给客户端。

建议：每个客户端/agent 一个 token（可以单独吊销）；token 不进仓库、不进 URL、不进 shell 历史
（下面的例子用 `read -rs` 读入）。

重启的影响：env 文件在启动时读取，所以改 token 要重启；MCP 会话在进程内存里，重启后客户端要重新初始化会话；
正在排队的异步摄取最多等 `MINIZEP_DRAIN_TIMEOUT_MS`（默认 120 秒，unit 的 `TimeoutStopSec=150` 比它长），
没处理完的 episode 已经以 pending 落盘，下次启动继续处理。

## 5. 轮换 token

旧 token 在新 token 可用之前一直有效，客户端不中断：

1. 生成新 token 并加入 env 文件：`sudo deploy/tokens.sh --group teamA --append /etc/minizep/minizep.env`
2. `sudo systemctl restart minizep`
3. 把新 token 配到客户端，确认能用：

   ```bash
   read -rs MINIZEP_TOKEN && export MINIZEP_TOKEN
   curl -sS -H "Authorization: Bearer $MINIZEP_TOKEN" http://100.64.0.10:8787/v1/stats
   ```

4. `sudoedit /etc/minizep/minizep.env`，从 `MINIZEP_TOKENS` 里删掉旧的那一条
5. `sudo systemctl restart minizep`，旧 token 从此被拒绝
6. 删掉备份：`sudo rm /etc/minizep/minizep.env.bak.*`（备份里有旧 token）

token 泄露时立即做第 4、5 步：重启同时清掉了用这个 token 建立的所有会话。

## 6. 接入 MCP 客户端

**HTTP 传输**（客户端支持 Streamable HTTP 和自定义请求头）：地址是 `http://<VPN 地址>:8787/mcp`，
请求头 `Authorization: Bearer <token>`。Claude Code：

```bash
claude mcp add --transport http minizep http://100.64.0.10:8787/mcp \
  --header "Authorization: Bearer $MINIZEP_TOKEN"
```

或者在项目的 `.mcp.json` 里引用环境变量，token 不写进文件：

```json
{
  "mcpServers": {
    "minizep": {
      "type": "http",
      "url": "http://100.64.0.10:8787/mcp",
      "headers": { "Authorization": "Bearer ${MINIZEP_TOKEN}" }
    }
  }
}
```

**stdio 代理**（客户端只支持 stdio）：在客户端机器上构建一份 checkout（`npm ci && npm run build`），
让客户端启动代理，代理把请求原样转发给 HTTP 服务：

```json
{
  "mcpServers": {
    "minizep": {
      "command": "node",
      "args": ["/path/to/minizep/dist/server/stdio-proxy.js"],
      "env": {
        "MINIZEP_HTTP_URL": "http://100.64.0.10:8787/mcp",
        "MINIZEP_TOKEN": "<token>"
      }
    }
  }
}
```

两种方式看到的是同一份图谱，能用哪些 group 由 token 决定。

## 7. REST 快速上手

所有 `/v1` 接口用同一个 bearer token，JSON 进 JSON 出；出错时返回 `{"error": "..."}` 和相应的状态码，
请求体上限 1 MB。字段和返回结构见 [API.md](API.md)。`at` 是有效时间（"那时什么是真的"），
`as_of` 是知识时间（"那时系统知道什么"）。

```bash
export MINIZEP_URL=http://100.64.0.10:8787
read -rs MINIZEP_TOKEN && export MINIZEP_TOKEN        # 粘贴 token，不进 shell 历史
auth=(-H "Authorization: Bearer $MINIZEP_TOKEN" -H 'content-type: application/json')

curl -sS "$MINIZEP_URL/health"                        # {"ok":true}，不需要 token

# 写入（同步：等抽取完成后返回结果）
curl -sS "${auth[@]}" "$MINIZEP_URL/v1/memories" -d '{
  "content": "Alice Chen joined Globex as a Staff Engineer on 2026-03-02.",
  "group_id": "teamA", "source": "text", "valid_at": "2026-03-02T09:00:00+08:00"}'

# 异步写入：episode 落盘后立即返回 job id
curl -sS "${auth[@]}" "$MINIZEP_URL/v1/memories" -d '{"content": "...", "async": true}'
curl -sS "${auth[@]}" "$MINIZEP_URL/v1/memories/jobs/<job-id>"

# 检索；加 at / as_of / include_historical 做时间旅行
curl -sS "${auth[@]}" "$MINIZEP_URL/v1/search" -d '{"query": "Where does Alice work?", "limit": 5}'
curl -sS "${auth[@]}" "$MINIZEP_URL/v1/search" \
  -d '{"query": "Alice employer", "at": "2025-06-01T00:00:00Z", "include_historical": true}'

# 实体和它的事实（路径里的名字要 URL 编码，例如 "Alice Chen" -> Alice%20Chen）
curl -sS "${auth[@]}" "$MINIZEP_URL/v1/entities?query=Alice&limit=10"
curl -sS "${auth[@]}" "$MINIZEP_URL/v1/entities/Alice%20Chen/facts?include_historical=true"
name=$(node -p 'encodeURIComponent(process.argv[1])' 张三)
curl -sS "${auth[@]}" "$MINIZEP_URL/v1/entities/$name/facts"

# 某一时刻图中为真的事实
curl -sS "${auth[@]}" "$MINIZEP_URL/v1/facts?at=2026-01-01T00:00:00Z&limit=50"

# 溯源：原始 episode
curl -sS "${auth[@]}" "$MINIZEP_URL/v1/episodes?limit=10"
curl -sS "${auth[@]}" "$MINIZEP_URL/v1/episodes/<id>"

# 手动关闭一条事实；retract: true 表示它从来就不成立
curl -sS "${auth[@]}" "$MINIZEP_URL/v1/facts/<uuid>/invalidate" \
  -d '{"reason": "entered by mistake", "retract": true}'

# 统计（运行细节只在这里，需要 token）
curl -sS "${auth[@]}" "$MINIZEP_URL/v1/stats?group_id=teamA"
```

## 8. Web UI（可选）

服务可以附带一个浏览器页面：按 group 浏览图谱（有效时间 `at` 和知识时间 `as_of` 都可以拖动）、事实、实体和
episode，写入记忆，手动结束或撤回事实。默认关闭，在 env 文件里设置 `MINIZEP_UI_GROUPS` 才开启：

```
MINIZEP_UI_GROUPS=teamA|shared
```

- 值是 `|` 分隔的 group 列表，第一个是页面的默认 group；`*` 表示所有 group。不设（或为空）就没有 UI，
  `/` 和 `/ui` 都是 404。
- 改完 `sudo systemctl restart minizep`，然后在 VPN 上的浏览器里打开 `http://100.64.0.10:8787/ui`
  （`/` 和 `/ui/` 会跳转过去）。页面文件是 checkout 里的 `ui/index.html`，npm 包和容器镜像里也带着。

**UI 没有登录。** `/ui` 页面和它调用的 `/ui/api/v1/*` 都不需要 token：服务端把这些请求当成一个固定的调用方，
只能读写 `MINIZEP_UI_GROUPS` 里的 group。换句话说，**能连上监听地址的任何人都能读写这些 group**。所以：

- 只在私有网络上开启：回环地址，或者按第 3 节只监听 VPN 地址、再用 ACL 限定能访问 8787 的设备。
  不要在公网能访问到的地址上开启。
- 只列出需要在页面上看的 group。`*` 会把所有 group（包括只发给别的 token 的 group）交给能打开页面的人。
- `/v1` 和 `/mcp` 的 token 鉴权不变，UI 不改变任何 token 的权限。

服务端对每个 UI 请求做两项检查，不满足就返回 403：

- `Host`（去掉端口）必须是 IP 地址、`localhost`，或者 `MINIZEP_UI_HOSTS` 里列出的名字。DNS rebinding
  攻击的页面用的是攻击者自己的域名，所以会被挡住。要用主机名打开 UI（例如 MagicDNS 名字），把它加进去，
  多个用逗号分隔，不带端口：

  ```
  MINIZEP_UI_HOSTS=minizep.tailnet.example
  ```

- 浏览器带了 `Origin` 时，它必须正好是 `http://<Host>`，并且 `Sec-Fetch-Site` 不存在或者是 `same-origin`：
  别的网站上的页面既不能写，也读不到结果。请求体和其余接口一样只接受 `application/json`。

UI 和其余接口一样是明文 HTTP，靠 VPN 加密传输。检查：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://100.64.0.10:8787/ui                     # 200
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Origin: http://evil.example' \
  http://100.64.0.10:8787/ui/api/v1/stats                                                # 403
```

## 9. 测试只连一次性数据库

Postgres 相关的测试按这个顺序找数据库：`MINIZEP_TEST_DATABASE_URL` → `MINIZEP_DATABASE_URL` →
`/var/tmp/minizep-pg/url`。在生产主机上后两个指向的就是**生产库**，而测试会在里面建 schema、
`TRUNCATE`、`ALTER TABLE`。所以：

- 测试在开发机或 CI 上跑，不在生产主机上跑；`install.sh` 不跑测试。
- 需要 Postgres 用例时，起一个一次性的容器，并**显式**设置 `MINIZEP_TEST_DATABASE_URL`：

  ```bash
  docker run -d --rm --name minizep-pg-test -p 127.0.0.1:55432:5432 \
    -e POSTGRES_HOST_AUTH_METHOD=trust pgvector/pgvector:pg17
  until docker exec minizep-pg-test pg_isready -h 127.0.0.1 -U postgres; do sleep 1; done
  docker exec minizep-pg-test psql -U postgres -c 'CREATE EXTENSION IF NOT EXISTS vector'
  env -u MINIZEP_DATABASE_URL \
    MINIZEP_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres npm test
  docker stop minizep-pg-test          # --rm：容器和数据一起删掉
  ```

- 不设 `MINIZEP_TEST_DATABASE_URL` 时 `npm test` 里的 Postgres 用例会跳过（前提是另外两个来源也不存在）。
- 永远不要把 `MINIZEP_TEST_DATABASE_URL` 写进服务的 env 文件。

部署脚本自己的测试不需要数据库也不需要 root：

```bash
bash deploy/test/install.test.sh
bash deploy/test/tokens.test.sh
```

## 10. 升级与回滚

升级：

```bash
cd /srv/minizep                                        # git 命令都以 checkout 的所有者身份运行
prev=$(sudo -u minizep git rev-parse HEAD)             # 记下当前版本，回滚用
sudo -u minizep git fetch --tags
new=<新的 tag 或 commit>
sudo -u minizep git diff "$prev" "$new" -- deploy/minizep.env.example   # 新的环境变量（都有默认值）
sudo install -d -m 700 /var/backups/minizep
docker exec minizep-pg pg_dump -U minizep -Fc minizep | sudo tee "/var/backups/minizep/$(date +%F).dump" >/dev/null
sudo -u minizep git checkout "$new"
sudo deploy/install.sh --user minizep --node /usr/bin/node   # 构建、刷新 unit（打印 diff）、重启、等 /health
journalctl -u minizep -n 50
```

- 启动时的 schema 迁移都是增量的（加列、加索引、回填 `search_text`；旧的 `facts_fts` 索引由新索引取代），
  旧版本代码能忽略新增的列。
- `npm ci` 会替换正在运行的进程下面的 `node_modules`；构建失败时脚本在重启之前停下，旧进程继续服务，
  但磁盘上已经是半新半旧的状态，这时尽快按下面回滚，别等进程自己重启。

回滚：

```bash
sudo -u minizep git checkout "$prev"
sudo deploy/install.sh --user minizep --node /usr/bin/node
```

新版本写入的数据旧版本读不了时，停服务后从升级前的备份恢复：

```bash
sudo systemctl stop minizep
sudo cat /var/backups/minizep/<date>.dump |
  docker exec -i minizep-pg pg_restore -U minizep -d minizep --clean --if-exists
sudo systemctl start minizep
```

## 11. Embedding 服务换班

minizep 只知道 `MINIZEP_EMBED_URL`。把它指向网关上的 `embed-proxy.py`（固定地址，经 VPN），
不要指向计算节点上作业的端口，那个端口每个作业都不一样。

Slurm 作业有时限，"常驻"靠 `infra/embedding/supervise.sh` 提前换班：剩余时间不足 `LEAD` 时提交新作业，
新作业 `/health` 返回 200 后才把 `current-target` 切过去，`GRACE` 秒后取消旧作业；`embed-proxy.py`
跟随 `current-target`，所以换班时 minizep 不需要改配置也不需要重启。细节见 README 的
[Embedding 服务位置](../README.md#embedding-服务位置) 和 [`infra/embedding/`](../infra/embedding/)
各脚本开头的注释。

没有可用后端的时候：

- 网关返回 503 和 JSON 错误；
- 摄取不会退化成别的向量：episode 标记为 failed 并保留原文（"stored for retry"），后端恢复后用 MCP 工具
  `retry_failed` 原地重试；
- 检索退化成只用关键词，结果标记 `degraded: true`。

检查网关：`curl -sS http://100.64.0.20:11435/health`。

同一个模型换到新作业上，向量不变，什么都不用做。**换模型或换维度不是换班**：要改 `MINIZEP_EMBED_DIMS`
并重建向量（README"数据库后端"一节）。可选的第二层 `MINIZEP_OLLAMA_URL` 必须是同样维度的模型。

## 12. 排障

| 现象 | 原因和处理 |
|---|---|
| `status=226/NAMESPACE` | 沙箱要挂载的路径不存在：`--snapshot-dir` 的目录、checkout 或 node 路径被删了；重新跑 `install.sh` |
| `status=203/EXEC` | node 路径失效（例如 nvm 换了版本）；`install.sh --node <新路径>` |
| `refusing to start without authentication` | `MINIZEP_TOKENS` 为空 |
| `fatal: no extraction LLM configured` | 设 `MINIZEP_LLM_BASE_URL` + `MINIZEP_LLM_API_KEY`，或检查服务账号的 `~/.openclaw/openclaw.json` |
| 日志里 `store=memory + snapshot` | 没设 `MINIZEP_DATABASE_URL`（沙箱里读不到 `/var/tmp` 下的 url 文件） |
| 日志里反复出现 `EADDRNOTAVAIL` | `MINIZEP_HOST` 里的 VPN 地址不对，或者 VPN 没起来：`tailscale ip -4` |
| `install.sh` 等 `/health` 超时 | 看它打印的 `systemctl status` 和日志；数据库连不上时服务会按退避不断重启 |
| `/ui` 返回 404 | 没设 `MINIZEP_UI_GROUPS`（改 env 文件后要重启） |
| UI 返回 403 `host not allowed for the UI` | 用主机名打开了页面：把这个名字加进 `MINIZEP_UI_HOSTS`，或者用 IP 地址打开 |
| UI 里提示 `group not permitted` | 打开的 group 不在 `MINIZEP_UI_GROUPS` 里 |
