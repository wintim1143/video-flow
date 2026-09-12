# video-flow · M0 里程碑

**一句话**：输入一段广告文字描述 → LLM 匹配/定义视觉风格 → 生成可直接投喂生图与生视频模型的分镜脚本。
**本里程碑不生图、不生视频**，产物就是可复制的 prompt，你自己粘贴到任意平台去生成。

对应规划文档：`15-文生广告视频-需求确认与开发流程.md` 的 M1 之前插入的 M0 切片。

---

## 快速开始

```bash
# 1. 配置 LLM（OpenAI 兼容协议，官方/中转站均可）
cp .env.example .env.local
#    然后编辑 .env.local，填三个值：
#    LLM_API_KEY=sk-xxx
#    LLM_BASE_URL=https://你的地址/v1     # 必须带 /v1
#    LLM_MODEL=gpt-4o-mini

# 2. 启动
npm run dev          # http://localhost:3200

# 3. （可选）跑回归测试
npm test             # vitest，74+ 例，纯 lib 层、无数据库、不耗 LLM 额度
```

## 多 LLM 配置（文本 / 图片 / 视频）

默认只用 `.env.local` 的一个文本 LLM（足够跑通 M0）。需要多模型时，在项目根建 `llm.config.json`（已被 gitignore，key 只存本地；参考 `llm.config.example.json`）：

```json
{
  "text": [
    { "id": "terra", "name": "GPT-5.6 Terra", "baseURL": "https://lanfengai.cn/v1", "apiKey": "sk-xxx", "model": "gpt-5.6-terra" },
    { "id": "ds",    "name": "DeepSeek（纯文本）", "baseURL": "https://你的地址/v1", "apiKey": "sk-xxx", "model": "deepseek-chat", "vision": false }
  ],
  "image": [
    { "id": "img1", "name": "某生图服务", "baseURL": "https://生图服务商/v1", "apiKey": "sk-xxx", "model": "模型名", "endpoint": "/images/generations" }
  ],
  "video": [
    { "id": "agnes", "name": "Agnes Video 2.5 Flash", "baseURL": "https://apihub.agnes-ai.com/v1", "apiKey": "sk-xxx", "model": "agnes-video-2.5-flash", "endpoint": "/videos", "provider": "agnes" }
  ]
}
```

- **text**：数组，可配多个。顶栏「文本LLM」下拉随时切换，风格 / 分镜生成共用当前选中项。`name` 缺省用 `model`；`id` 缺省自动生成。
  - `reasoningEffort` 可选（`minimal`/`low`/`high`，设 `""` 关闭）：推理模型（如 gpt-5.6 系）默认 `minimal`，实测把单镜耗时从 ~120s 降到 ~19s；服务商不支持时自动剥离该参数。
  - `vision` 可选：**缺省 = 支持图片输入**；填 `false` 表示纯文本模型（如 DeepSeek），上传参考图提取风格时前端下拉会自动过滤掉它、服务端返回 `VISION_UNSUPPORTED`。
- **image**：配置后才在 ② 风格 tab 出现「生成风格样张」区块 —— 用当前风格（含你编辑后的色板/关键词）出一张测试图，确认视觉方向是否满意；`endpoint` 缺省 `/images/generations`（OpenAI Images 协议）。同一接口也服务 ③ 分镜的关键帧生成，只是多传两个参数：`size` 按画幅（如 `720x1280`，**不限枚举**）与 `preferUrl: true`（要**公网 URL** 而非 base64 —— I2V 读不了 b64）。
- **video**：配置后在 ③ 分镜 tab 出现「视频生成」区块，每个分镜内多一条「生成关键帧 → 生成视频」两步链路（见「关键帧 → I2V」一节）—— 异步任务：建任务 → 服务端按配额轮询 → 出片后内联播放 / 下载。`provider` 选择厂商适配器（见下一节），缺省按 `baseURL` 推断；`mode` 通常不用填，适配器会按实际传入的媒体字段推断（有首尾帧 → `keyframe`，有参考图/音频 → `reference`，否则 `text`）。
- 配置文件存在时**优先于** `.env.local`；无此文件 / 非法 JSON 自动回退 `.env.local` 单文本配置（`LLM_REASONING_EFFORT` 环境变量可覆盖回退配置的思考力度）。
- ⚠️ **key 只能写在 `llm.config.json`（已被 gitignore）或 `.env.local`，`llm.config.example.json` 是模板、会被提交，切勿填真实 key。**

## 分镜生成：两段式 + 串行 + 流式进度

分镜不用「一次生成整个 JSON」（推理模型下必超时），改为：

1. **大纲**（一次小调用，10-90s）：每镜一句话规划节奏与叙事，顺带产出全片负面词、一致性锁定项、**实体档案**、**状态链**与**转场设计**；
2. **逐镜展开**（**串行**流水线）：单镜小输出（实测 ~19s/镜），失败自动重试 1 次，仍失败只标记该镜，其余镜照常；
3. 全程 SSE 推送进度：前端实时显示「第 X/Y 镜」进度条、每镜耗时；失败镜出现「重试第 N 镜」按钮（调 `/api/shot` 定点重试，不必整单重来）。

> **为什么是串行而不是并发**：串行的目的是「尾帧链」——镜 N 的成品（image_prompt / end_state）会作为参考喂给镜 N+1，实现「镜 N 末帧 = 镜 N+1 首帧」的动势衔接。并发下邻居完成的先后顺序不保证，接力会丢失。参考实现：`ai-video-pipeline`（尾帧链）、`StoryMem`（跨镜记忆）、`HoloCine`（转场前移到导演层统一规划）。

### 跨镜连续性（防"车头翻转"式错位）

逐镜独立生成时，仅锁风格与产品属性不够——主体在**空间中的状态**（车头朝向、车灯亮灭、光源方向、时间天气）不锁就会镜间跳变。三层机制：

- **实体档案 `entities`**：每个跨镜主体一条锁定英文描述符 `descriptor_en`（外观 + **朝向基准约定**，如 "front of the car facing the camera, headlights on"），逐镜 verbatim 嵌入 prompt；
- **状态链 `start_state / end_state`**：每镜的镜首/镜末状态（朝向/位置/状态 + 环境），大纲硬性要求镜 N 的 end_state = 镜 N+1 的 start_state，未经转场说明禁止翻转；
- **转场设计 `transition_out`（大纲统一规划）**：相邻两镜同场景/同主体连续时，必须用**匹配剪辑 / 首尾帧衔接**并写明动势怎么承接；换场才允许硬切/叠化。**禁止无设计的生硬跳切**（如产品特写直接跳到模特脸部）。该字段与状态链一样，由服务端用大纲值强制覆盖，不让单镜展开自由发挥。
- 单镜展开时，prompt 注入「上一镜末状态 + 本镜首末状态 + 上一镜成品参考 + 本镜转场设计」；
- 分镜卡上以「状态链：镜首 → 镜末」可视化展示，方便人工核对。

### 秒级节拍 · beats（粒度自适应）

每镜可带一节拍数组，把动作按时段切分（如 `0-1s: ...` / `1-2s: ...`），帮助生视频模型控制节奏，防止所有动作挤在一段粗粒度描述里。

**粒度由 LLM 按本镜动作复杂度决定，不固定每秒一拍**：动作密集、姿态变化丰富的镜可细到 0.5 秒级；动作单一或静态氛围镜可以整镜一拍。硬约束只有结构性的：时间段连续覆盖 `0 → duration`（末拍可短）、每拍一个连续小动作、首拍从 `start_state` 出发、末拍结束于 `end_state`。

## 三步流程

> 三个环节是**常驻 tab**，只要该步有数据就能来回切换（在分镜里切回风格、再切回来都不会丢）。工作状态（需求 / 风格 / 分镜 / 时长）会**自动存到 localStorage**，刷新页面不丢；分镜页右下角有「清空进度」按钮可一键回到空白页。

**风格来源二选一或混用**：① 纯文字描述 → LLM 匹配/定义风格；② 上传参考图 → vision 模型从图**提取**风格（palette 从图实际取色、keywords_en 复刻图中视觉特征），文字可留空或仅补充产品/内容信息；③ 图+文同给（图定风格、文定内容）。参考图在浏览器端压缩到 ≤1024px JPEG 后上传。所选文本 LLM 需支持图片输入（不支持时会明确报 VISION_UNSUPPORTED 并提示换模型）。

| 阶段 | 做什么 | 产出（均可编辑） |
|---|---|---|
| ① 需求 | 填广告描述 + 选时长/画幅（**默认 5s**，预设 5/15/30/60） | — |
| ② 风格（闸门 1） | LLM 按 8 维度定义风格，优先匹配内置 seed | 风格卡：色板 / 七维设定 / 英文一致性关键词 / 负面词 —— 全部字段可改，色板 HEX 可增删 |
| ③ 分镜 | 按确认的风格拆 N 镜 | 每镜**中英对照** prompt：英文用于生成（可复制），中文用于展示校准；每镜有 EN/中文 切换，Image / Video / Negative / 节拍 均可直接编辑 |

> 若需求读起来像「App / 小程序 / 播放器 / 界面交互」这类**功能演示**，需求页会提示：视频模型渲染不出像素级一致的 UI 与可读文字，功能演示建议走**真机录屏**（画面里的视频画布再让 AI 动起来），本工具更适合做该 App 的**品牌情绪片**。

交互要点：
- **编辑 prompt**：点进文本框即可改，失焦（或 Cmd+Enter）自动保存；复制按钮复制的就是当前语言 + 你改后的内容。
- **复制带前缀**：单镜视频 prompt 的「复制」会自动带 `【广告视频 · 画幅 9:16 · 本镜时长 2.5秒 · 单镜独立生成】` 前缀，粘到生成平台不用再口头交代画幅和时长。
- **风格改完怎么同步到分镜**：改完风格字段后点分镜 tab 的「用当前风格写分镜」会重算；不改不自动覆盖你手工调过的分镜。
- 不满意可在 ② 点「换一套」（可附带调整要求，如"更冷一点"），风格成本为零、可反复重来，**不消耗任何生图/生视频额度**。

## 导出

- 复制全部图像 Prompt(EN)（批量去生首帧图，英文生成版）
- 复制全部视频 Prompt(EN)（批量去图生视频，已带画幅/时长前缀、节拍与负面词）
- **复制整片 Prompt（单段长文本）** / 下载整片 `.txt`：按「整片模式」视频模型（Seedance / MiniMax h3 / 即梦长视频）的惯用结构，把整条分镜拼成**一条**可一次投喂的长 prompt —— 全局头（类型/时长/画幅/风格/视觉关键词/语言）→ 主体角色卡 → 全片状态弧 → 逐镜（含节拍时间轴）→ 声音设计 → 约束清单。与逐镜模式**互补**：单段适合快速出片，逐镜适合精确控制节奏与跨镜一致。
- 复制 / 下载 Markdown（完整分镜脚本，**含 EN + 中文对照双份**，含风格、一致性锁定、每镜状态链与节拍）
- 复制 / 下载 JSON（给后续 Mastra workflow 直接消费）

> 注意：批量复制 Image/Video 只给英文（直接投喂生成模型）；要看中文说明去 Markdown 或分镜 tab 里切「中文」。

### 尾帧链工作流（逐镜模式怎么串起来）

按镜序**串行**生成视频 → 每镜生成后截取**最后一帧** → 下一镜用该帧作为首帧参考（图生视频），两镜动势即可无缝衔接；换场镜按各镜标注的转场方式拼接。Markdown 导出里也带这段说明。

## 视频生成：可插拔厂商适配器

视频接口**没有事实标准**——不同厂商的创建路径、查询路径、字段命名、时长类型、成片地址位置全都不同。以 Agnes 为例（一手核对官方文档）：

| 维度 | Agnes Video 2.5 / Flash |
|---|---|
| 创建 | `POST {baseURL}/videos` |
| 查询 | `GET {origin}/agnesapi?video_id=&model_name=` —— **跳出 `/v1` 命名空间** |
| 时长 | `seconds`，**字符串** `"4"`–`"12"` |
| 分辨率 | `size`，**档位** `"720P"`（不是 `1280x720`） |
| 画幅 | `aspect_ratio`，与 `size` 正交 |
| 模式 | `mode` **必填**：`text` / `keyframe` / `reference`，且必须与实际媒体字段匹配 |
| 首帧 | `first_frame` / `last_frame`（不是 `image` / `input_reference`） |
| 成片地址 | `metadata.url`，且仅 `status: "completed"` 时可信 |

Agnes 文档还专门列出会返回 400 的**别名清单**（`input_reference`、`video_url`、`width` / `height` / `fps`）——说明这些命名在别家那里是合法的。所以差异必须靠适配器吸收：

```
VideoTaskRequest（统一入参：prompt / seconds / aspectRatio / firstFrame / images…）
        ↓  resolveVideoProvider(profile)
   ┌────┴─────────────────┐
 agnes               openai（兜底：POST /videos + GET /videos/{id}）
 buildCreate / parseCreate / buildQuery / parseQuery / inferMode
```

- 适配器在 `src/lib/video-providers.ts`；**新增一家厂商 = 写一个 `VideoProvider` 实现 + 注册表登记一行**，路由、UI、类型层都不用改。
- 选适配器：`profile.provider`（`agnes` / `openai`）；缺省按 `baseURL` 推断（含 `agnes` 走 agnes）。
- 本地就能拦掉的错误不浪费配额：时长越界、`keyframe` 没给帧、`reference` 没给媒体，都在发请求前抛 `BAD_REQUEST`。

### 关键帧 → I2V（M1 闭环）

分镜里的 `image_prompt` 是**纯静态**描述（无运动词），本来就是为生关键帧写的；直接用运动 prompt 文生视频等于把这半套 prompt 工程浪费掉，出片的主体也更容易漂。所以每镜多一步「先生关键帧，再图生视频」：

```
Shot.image_prompt ──POST /api/image（preferUrl）──▶ 公网图 URL
                                                      │
                         写回 Shot.keyframe_url ──────┘
                                                      │
      buildShotVideoPayload() 带上 firstFrame ────────┘
                                                      ▼
              POST /api/video → 适配器推断 mode=keyframe → first_frame
```

- **`preferUrl` 是关键**：I2V 的首帧必须是上游能自己拉取的**公网地址**，base64 字符串它读不了。而网关实测有个坑——传 `response_format: "b64_json"` 时它**不再返回 `url`**，所以 `preferUrl: true` 时**根本不发** `response_format`，直接取默认返回里的 `url`。
- **首帧尺寸必须与画幅同比例**：`keyframeSizeFor()` 按 `aspect_ratio` 选尺寸（9:16 → `720x1280`，16:9 → `1280x720`）。实测 2:3 首帧（`1024x1536`）会让成片变成 704×1088（画幅被首帧带偏），换成 9:16 首帧后成片是 704×1280 —— 高度对齐文档标称的 720P 竖屏。上游会把边长吸附到 64 的倍数，比例是准的。
- **串行队列**：`use-keyframes.ts` 逐镜排队生成，避免多镜并发把图接口打爆（与分镜生成同理）。
- **失败不阻塞**：单镜关键帧失败只标记该镜，不影响其他镜；也可以跳过关键帧直接文生视频（退化为 `mode: "text"`）。

> 边界：关键帧生图走的是 image profile，与视频 profile 是两套配置，都要配好才有完整链路。

### 异步任务：两套限流，量级差 20 倍

一次「生成视频」= **建任务 + N 次查询**。但两侧限流**完全不同**，早期版本把它们合成一把锁，结果建完任务要干等 60 秒才查得到结果（5 秒的视频要一分钟才知道成没成）。现在拆成两个独立闸门：

| 闸门 | 约束对象 | 默认 | 环境变量 | 依据 |
|---|---|---|---|---|
| create | 建任务（吃生成配额，**账户级**） | 60s | `VIDEO_CREATE_MIN_INTERVAL_MS` | Agnes 免费档实测 1 次/分钟 |
| query | 查询（宽松） | 4s | `VIDEO_QUERY_MIN_INTERVAL_MS` | 实测 4.0s×15（整 60s）全 200；2.0s×8 第 4/8 次 429 且 `Retry-After: 2` |

- 服务端统一发牌（`src/lib/video-rate-limit.ts`）：没到点**不发上游请求**，回 `429 THROTTLED + retryAfterMs`。
- 响应字段也分开了：`nextCreateAfterMs`（多久后才能再生成）与 `nextQueryAfterMs`（多久后能再查），**两个数，别混用**。
- 前端全局只有**一个**定时器（`src/lib/use-video-tasks.ts`），等待时长完全按服务端返回的 `nextQueryAfterMs`（或上游 `Retry-After`）来排，不自己拍间隔；任务状态持久化到 localStorage，刷新页面轮询链不断。
- **生成配额是账户级的**，所以 `createReadyAt` 是全局冷却：生成了第 1 镜，其余分镜的「生成视频」按钮会一起变灰倒计时。
- 上游 429（本地闸门或上游限流）只当作「等一下」重新排期，**绝不判任务失败** —— 否则一次瞬时限流就把还在跑的任务钉死。

> 边界：闸门状态是**模块级内存**，只覆盖单进程。dev server / 单实例部署够用；多实例部署需换成共享计数（替换 `video-rate-limit.ts` 的几个函数即可）。
> 边界：Agnes 时长下限是 4 秒，短于 4 秒的分镜会被本地拦下并给出提示。

### API

- `POST /api/video` → 建任务，返回 `taskId` / `status` / `provider` / `mode` / `nextCreateAfterMs` / `nextQueryAfterMs`
- `GET /api/video?taskId=xxx[&profileId=]` → 查询任务；`completed` 时返回 `videoUrl`
- `GET /api/video` → 能力自述：脱敏 profile 列表 + 命中的适配器 + 闸门快照（`{create, query}`）

## 链路日志（/logs）

每次 LLM 调用落一条 JSON 到 `.data/traces-YYYY-MM.jsonl`（按月轮转，已被 gitignore），记录：traceId、步骤、模型、**完整 prompt**、原始输出、耗时、token、报错、**降级重试次数与被剥离的参数**、**429/5xx 退避重试次数**。

- 主页右上角「链路日志」进入 `/logs`：列表 → 点行进详情（system / user / 原始输出 / 错误 / 降级）→ **勾选两条记录左右并排对比**（微调前后、换模型的核心用法）→ 一键导出微调 JSONL（`messages` + `completion`）。
- `GET /api/logs?export=1[&traceId=]` 直接下载微调数据。
- 读取只扫日志文件**尾部若干字节**，日志长大也不会拖慢页面。

## 内置风格 seed

仅作**锚定**用，防纯文本自由发挥导致风格漂移（15 号文档决策 1：不引外部模板库）。
LLM 能匹配上就匹配，匹配不上就自由定义。

`tech 科技感` · `warm 温情生活` · `cinematic 电影大片` · `kawaii 萌系活泼` · `minimal 极简高级`

## 测试用广告描述

直接复制进输入框即可。按内置 5 类 seed 各配一条 + 一条「自由定义」路径 + 一条长时长，用于验证风格匹配与分镜拆解是否正确。

| # | 测试目的 | 粘贴这段 | 预期 |
|---|---|---|---|
| T1 | 科技感 seed | 一款智能手表「PulseFit」，主打全天候健康监测和 14 天续航，目标人群是注重健康的都市上班族，画面希望有未来感和精密感。 | 命中 `tech`：深蓝黑底 + 青蓝点缀、rim light、产品悬浮居中 |
| T2 | 温情生活 seed | 一款宠物鲜粮品牌「毛孩子」，想让主人在厨房给猫狗备餐的温馨画面，传达陪伴与安心的感觉。 | 命中 `warm`：奶油暖调、窗光、生活抓拍感 |
| T3 | 电影大片 seed | 硬派越野车「TERRA 9」品牌形象片，沙丘、暴雨、翻山越岭，要史诗感和压迫性的气势。 | 命中 `cinematic`：低机位仰拍、teal & orange、强反差光 |
| T4 | 萌系活泼 seed | 一款草莓麻薯奶茶的新品推广，面向学生党，希望画面活泼跳跃、色彩明亮、有弹跳感的动效。 | 命中 `kawaii`：糖果色、柔和无硬影、弹跳节奏 |
| T5 | 极简高级 seed | 一支中性木质调香水「MU 01」，只有产品、光影和留白，突出瓶身质感和水珠细节，克制而昂贵。 | 命中 `minimal`：单色背景、微距、大面积留白 |
| T6 | 自由定义路径 | 一条记录凌晨四点批发市场开市的烟火气短片，蒸汽、吆喝、灯光下的摊贩，要真实纪录片质感。 | `seed_match=null`：不套任何 seed，风格自由定义 |
| T7 | 长时长分镜拆解 | 便携式胶囊咖啡机「BrewGo」60 秒完整广告：办公室场景引入痛点 → 产品出场 → 出杯过程特写 → 露营场景 → 结尾品牌落版。 | 镜数自动推到约 12 镜，时码 00:00 累加到 60s，末镜有 CTA |

每条建议的验收点：

1. ② 风格卡右上角应显示命中的 seed 徽标（T6 应显示「自由定义」）；
2. ③ 每镜 Image Prompt 不应含运动词（moving / pushing in 等），Video Prompt 应含镜头运动与动作、明确时长数值；
3. 每镜有「节拍」块，粒度随动作复杂度变化（动作镜更细、氛围镜可整镜一拍）；
4. 相邻镜的「状态链」应首尾相接（镜 N 末状态 = 镜 N+1 首状态），转场为匹配剪辑时动势方向一致；
5. 任选一镜的英文 prompt 复制到生图平台，画面风格应与色板一致；
6. 「换一套」+ 调整要求（如"更冷一点"）后，色板与关键词应发生明显变化。

## 目录结构

```
src/
  app/
    page.tsx                 主工作台（常驻 tab：需求 / 风格 / 分镜；含 localStorage 持久化）
    logs/page.tsx            链路日志页（列表 / 详情 / 双记录对比 / 微调导出）
    api/style/route.ts       S1 风格匹配（含参考图提取风格路径）
    api/shots/route.ts       S2 分镜生成（两段式 + 串行 + SSE）
    api/shot/route.ts        单镜定点重生成（失败镜重试）
    api/image/route.ts       风格样张生图
    api/logs/route.ts        链路日志查询 / 微调 JSONL 导出
    api/llm-configs/route.ts 脱敏的 LLM profile 列表（前端下拉用）
    api/video/route.ts       视频：POST 建任务 / GET 查任务 / GET 能力自述（含厂商与闸门信息）
  components/
    ShotRow.tsx             单镜分镜卡（中英对照 / 节拍 / 状态链 / 复制前缀 / 视频生成条）
    VideoGenBar.tsx         单镜视频生成条（建任务 / 状态 / 进度 / 内联播放 / 下载）
    KeyframeBar.tsx         单镜关键帧条（生图 / 预览 / 重生成 / 清除；首帧喂给 I2V）
    Timeline.tsx            时间轴条
    StyleEditor.tsx         风格卡编辑
    StyleTestImage.tsx      风格样张（生图确认）
    ProgressModal.tsx       生成期间的全屏进度弹窗（防误触）
    CopyButton.tsx          复制按钮
    EditableText.tsx        失焦自动保存的可编辑文本
  lib/
    schema.ts               StyleSpec / Shot / Storyboard / Outline（zod，全字段 catch 兜底）
    seed-styles.ts          5 类内置风格 seed
    prompts.ts              风格 / 大纲 / 单镜展开的 system+user prompt 与 suggestShotCount
    llm.ts                  OpenAI 兼容调用 + JSON 提取 + 降级重试 + 429/5xx 退避 + trace 埋点
    llm-configs.ts          多 profile 配置层（text/image/video，脱敏输出）
    exports.ts              Markdown / JSON / 批量 prompt / 整片单 prompt / 单镜视频 prompt 导出
    text-utils.ts           prompt 文本后处理（整段去重）
    trace-log.ts            链路日志落盘（按月轮转、尾部读取）
    video.ts                视频生成 facade：取 profile → 选适配器 → 过闸门 → 解析 → 记 trace
    video-types.ts          厂商无关的入参 / 出参 / VideoProvider 接口 / VideoError
    video-providers.ts      厂商适配器注册表（agnes / openai 兜底）+ 选适配器
    video-rate-limit.ts     视频限流闸门（create 60s / query 4s，两把独立的锁）
    use-video-tasks.ts      视频任务状态机 + 全局单一轮询器 + localStorage 持久化
    use-keyframes.ts        关键帧状态机（串行队列）+ keyframeSizeFor 画幅选尺寸
    video-payload.ts        buildShotVideoPayload：组装建任务入参（有关键帧则带 firstFrame）
test/                       vitest 回归测试（schema / prompts / exports / trace-log / llm / text-utils / video / video-providers / keyframe）
```

## 后续里程碑衔接

- **M1**：「关键帧生图 → I2V 生视频 → 预览」闭环**已贯通**（③ 分镜 tab 内每镜「生成关键帧 → 生成视频」，异步任务 + 配额闸门 + 内联播放）。剩余可做：整片拼接（**注意 M1 规格靠 <10s 单镜砍掉拼接，M3 才做满**）、尾帧链自动回填（镜 N 末帧 → 镜 N+1 首帧，`firstFrame` 通路已就绪）。
- **M3**：多分镜拼接，`consistency_notes` + 状态链即为跨镜一致性锁定的输入。
- 接 Mastra 时，`/api/style`、`/api/shots` 两个 route 的 prompt 与 schema 可原样搬进 workflow step。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 页面红条提示「未配置 LLM_API_KEY…」 | `.env.local` 没填或填了占位值，改完要**重启** dev server |
| 502 + 401/403 | Key 或 BaseURL 不对，用 curl 先验一下中转站是否通 |
| 502 + 429 | 上游限流。已内置 429/5xx 指数退避重试（默认 3 次、尊重 `Retry-After`，可用 `LLM_MAX_ATTEMPTS` 调整）；免费档 1 次/分钟的站点建议改用付费档 |
| 422「模型输出不是合法 JSON」 | 该模型 JSON 能力弱，换一个模型（建议 gpt-4o 级别及以上） |
| 504 超时 | 分镜较长，`LLM_TIMEOUT_MS` 默认 180s，可调大 |
| ③ 分镜 tab 里没有「视频生成」区块 | `llm.config.json` 的 `video` 组为空，或填了但缺 `baseURL`/`apiKey`/`model`（缺任一字段会被整条丢弃） |
| 生成视频报 429 / 「生成视频过于频繁」 | 生成配额冷却中。免费档约 1 次/分钟且**全账户共用**，所有分镜的按钮会一起倒计时；调 `VIDEO_CREATE_MIN_INTERVAL_MS` 或等提示的秒数 |
| 查询报 429 / `too many video status queries` | 上游查询侧限流（约 15 次/60s）。已按 `Retry-After` 自动退避、**不判失败**；调大 `VIDEO_QUERY_MIN_INTERVAL_MS`（默认 4s 实测稳定） |
| 生成视频报「时长超范围」 | Agnes 只接受 4–12 秒，本镜时长不在范围内。改分镜时长或换支持该时长的厂商 |
| 生成视频报「未知的视频厂商」 | `provider` 字段写错。可选值见 `GET /api/video` 的 `providers` 字段 |
| 参考图模式下选不到某个模型 | 该 profile 配了 `"vision": false`（纯文本模型），换支持视觉的模型 |
| 想比较两次生成差异 | 打开 `/logs`，勾选两条记录做左右对比 |
| 页面状态想清空 | 分镜页右下角「清空进度」（等价于清 localStorage 的 `video-flow:workbench:v1`） |
