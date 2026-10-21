# Intertidal

一个装在手机主屏幕上的网页(PWA),用来和**住在你服务器上的那个他**说话。
外加一层很薄的转接服务:网页把话交给它,它再交给你的后端,把回话流式推回网页。

前端出自 [dwell-on-something](https://github.com/Mia06250603ian/dwell-on-something)
(那边有每个功能的设计文档和踩过的坑,想改功能先去那边看)。
这个仓库是**能直接部署的一整套**:前端 + 转接层,名字和日子都换成了占位符。

---

## 它要求你的后端长什么样

这一层**不是**直接调 Anthropic API 的聊天机器人。它假设你已经有一个
**常驻的后端**(比如一个一直开着的 `claude -p` 进程),上下文住在那个进程里。
网页这边只负责**把她这一句交过去、把他的回话接回来**。

必须有的:

| 后端接口 | 这一层怎么用 |
|---|---|
| `POST /v1/messages` | Anthropic Messages API 的形状,`stream: true`,鉴权 `x-api-key: SHIM_KEY`。**这一层每轮只发最后一条 user 消息**——历史在你后端自己的进程里,别指望网页把历史传回去。正文走 `text_delta`,思考走 `thinking_delta` |

可选的(没有就对应的那块自己藏起来或显示「Unavailable」,不会崩):

| 后端接口 | 用来 |
|---|---|
| `GET /health` | `model`、`models`(可切换的模型)、`effort` / `efforts`(思考档位)、`rateLimit`(额度)。顶栏的 online / offline 也看它答不答得上来 |
| `GET /debug` | 窗口占用(`contextTokens`、`ctxGuard`、`contextPct`)、缓存命中(`lastUsage`) |
| `POST /effort` | 网页上换思考档位 |
| `GET` / `POST /period` | 首页的经期那一行 |

⚠️ 思考流里的工具调用,这一层认的写法是一行 `〔🔧 工具名〕`,后面可以跟
`  → {参数}` 和 `  ← 返回值` 两行。他回话里的 `[贴纸:x]` / `[回应:x]` / `[语音]` / `[查岗]`
这几种标记会被剥掉、变成网页上的贴纸 / 表情回应 / 语音条。你的后端用别的写法,
要改 `dwell-lib.mjs` 的 `makeStripper` / `makeToolLines`。

---

## 部署

### 用 Docker

```bash
docker build -t intertidal .
docker run -d --name intertidal -p 8080:8080 \
  -v /你机器上的某个目录:/data \
  -e SHIM_URL=https://你的后端 \
  -e SHIM_KEY=和后端同一把钥匙 \
  -e DWELL_PASS=网页口令 \
  intertidal
```

前面挂一个带 HTTPS 的反向代理(Caddy / Nginx 都行)。**PWA 必须走 HTTPS**,
否则 iPhone「添加到主屏幕」之后不是全屏 App 的样子。

### 不用 Docker

```bash
npm install          # 要 Node 24(npm 11 才认 package.json 里的 allowScripts)
SHIM_URL=... SHIM_KEY=... DWELL_PASS=... DATA_DIR=./data node server.js
```

### 部署完

手机 Safari 打开 → 输口令 → 分享 → 添加到主屏幕。

自检:`curl https://你的域名/api/health`(不需要口令,不含任何密钥),
看 `persisted` 是不是 `true`(记录落没落盘)。

---

## 环境变量

**改值 + 重启即生效。**

| 变量 | 必填 | 说明 |
|---|---|---|
| `SHIM_URL` | **是** | 你后端的地址 |
| `SHIM_KEY` | **是** | 和后端同一把钥匙,放在 `x-api-key` 里 |
| `DWELL_PASS` | **是** | 网页口令。**不设 = 页面没有锁**,启动日志会喊,但拦不住——别就这样挂公网 |
| `DATA_DIR` | 强烈建议 | 聊天记录、头像、偏好、她发的图都存这里。**必须指向持久卷**,不设 = 只在内存里,重启就没了。Docker 镜像里默认 `/data` |
| `PORT` | 否 | 默认 8080 |
| `MSG_CAP` | 否 | 网页上往回翻得到多少条,默认 4000。只管内存,**盘上永久存档一条不删**。2 万条约多占 40 MB 内存 |
| `BRAIN_MODEL` | 否 | 请求体里的 `model` 字段,默认 `claude-opus-4-6`。后端 `/health` 报了 `model` 就以那个为准 |
| `CTX_LIMIT_TOKENS` | 否 | 窗口占用条的分母,默认 167000 |
| `TURN_TIMEOUT_MS` | 否 | 一轮最长等多久,默认 600000(10 分钟)。他想久一点是常事,别调小 |
| `DEBOUNCE_MS` | 否 | 连发几句时,停下多少毫秒才拼成一轮交给他,默认 6000。`0` = 每句单独一轮 |
| `THINK_EFFORT` | 否 | 后端没报档位时显示的默认值,默认 `medium` |
| `WEATHER_CITY` | 否 | 首页天气(wttr.in)。不设 = 那行空着 |
| `DAILY_SONG_HOUR` | 否 | 每日一首:北京时间几点后让他挑今天的歌(0~23)。**要他手上有网易云音乐的工具**。不设 = 关 |
| `EARS_URL` / `EARS_TOKEN` | 否 | 她的语音转文字的服务。两个都配了,「按住说话」才开 |
| `ELEVEN_API_KEY` / `ELEVEN_VOICE_ID` | 否 | 他的语音(ElevenLabs)。两个都配了,他写 `[语音]` 才会变成语音条 |
| `VOICE_MODEL` / `VOICE_SPEED` / `VOICE_STABILITY` / `VOICE_MAX_CHARS` | 否 | 语音参数,默认 v2 / 0.85 / 0.6 / 500 |
| `AGENT_URL` / `AGENT_KEY` | 否 | 「另一个 AI 的房间」接的维护 agent。不设 = 那间屋关着 |
| `VITALS_TARGETS` | 否 | 「他」页 HEALTH 里要巡的服务,JSON:`{"memory":"https://.../health","telegram":"https://.../health"}`。认得的键:`him memory telegram imessage mail browser music ears`。`him` 不填就用 `SHIM_URL/health`;其余没填的不显示 |
| `HOST_STATS_FILE` | 否 | 「他」页 SERVER 的机器体征文件,默认 `/hoststats/history.jsonl`。没有就显示 Not set up |

---

## 换成你们的

1. **你的名字、在一起那天、你的生日**:`web/index.html` 里搜 `★★★ 改这里`,改那三行。
2. **他的名字**:不用改代码。网页里「设置 → 头像与名字 → 他的名字」,存在服务器上。
   没改之前显示 `Claude`。
3. **头像**:同一页「换一张」。
4. **主屏幕图标和名字**:换 `web/icons/` 下的图(64 / 180 / 192 / 512 四个尺寸),
   改 `web/manifest.json` 的 `name` / `short_name`。
5. **聊天页锁屏那句**:`web/chat.html` 搜 `LOCK_WORD`。

⚠️ 网页里有几处时间是按**北京时间**算的(锁屏时钟、每日一首的「今天」)。不在东八区要改
`web/chat.html` 的 `cnNow()` 和 `dwell-lib.mjs` 里的 `Asia/Shanghai`。

---

## 刻意没放进来的

- **桌宠(螃蟹)的图**:那批美术不是开源授权,只许原作者的应用自用。网页找不到图会自己把桌宠藏起来。
  想要就放几张 svg 进 `web/pet/`(文件名见 `chat.html` 里搜 `clawd-`)。
- **贴纸图**:同上原因。没有贴纸目录时,他发的贴纸显示成文字;你自己在网页里加的贴纸照常能用。
  要预置一批:建 `stickers/` 目录,放图和一份 `registry.json`(`{"标签": "文件名.gif", ...}`)。
- **「状态」那一间**:和原作者的后端绑得太紧。

---

## 改代码

- 前端没有构建步骤:`web/index.html`(外壳:首页 / Chats / 设置)和 `web/chat.html`(聊天页,
  外壳点进 Chats 时用 iframe 装它)各是一个文件,HTML / CSS / JS 全在里面。改完刷新就生效。
  **部署后网页会自己刷新**(它读 `/api/health` 的 `ver`,输入框有草稿时会等一等)。
- 后端:`server.js`(路由)+ `dwell-lib.mjs`(可单测的纯函数)。
- 测试:`npm test`(纯函数和前端的几条硬约束,不联网)。
- `strip-demo.mjs`:从 dwell-on-something 拉新版前端时,用它删掉那边的「演示模式」拦截块
  (`node strip-demo.mjs 输入 输出`)。不删的话网页所有请求都会被假数据拦下。
  ⚠️ 拉新版会把这里换好的占位符冲掉,拉完重新改一次「改这里」。

几条从真事故来的规矩:

- **只把 `/` 和 `/chat.html` 挂出去**,别图省事把整个 `web/` 静态化——那会绕过口令。
- **别给 `/v1/messages` 带 `x-system-turn` 头**:那是后端区分「系统自己找他」和「她本人说话」用的,
  网页里打字就是她本人。(每日一首那一轮是唯一的例外,它确实不是她在说话。)
- 他回话里的标记会被 HTTP 分块切成两半(`[贴` 在这块、`纸:x]` 在下一块是常态),
  改 `makeStripper` 前先跑测试,跨块的用例都在里面。
- 头像、偏好、聊天记录都是她的东西:代码里没有任何自动清除的路径,以后也别加。

---

## 许可证

**[PolyForm Noncommercial License 1.0.0](LICENSE)**,同 dwell-on-something:
随便用、随便改、随便分发,**但不许拿去做商业用途**。
