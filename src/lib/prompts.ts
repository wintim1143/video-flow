import type { Outline, Shot, StyleSpec } from "./schema";
import { seedSummaryForPrompt } from "./seed-styles";

/** S1 风格提取/匹配（15 号 §6.1 的 S1，对应闸门 1） */
export function styleSystemPrompt(): string {
  return `你是广告视觉总监（Visual Director）。任务：把用户的广告需求，定义成一套**可逐镜执行**的视觉风格规格。

可用的内置风格 seed（用于锚定，防止风格漂移）：
${seedSummaryForPrompt()}

工作步骤：
1. 判断用户需求最贴近哪个 seed。贴近 → seed_match 填该 seed 的 id，并在其基础上按用户描述调整；都不贴 → seed_match 填 null，自由定义。
2. 用中文填写 7 个维度：style（风格总述）/ color（色调与配色）/ lighting（光位与光质）/ composition（构图法则）/ materials（材质与质感）/ motion（运动语言）/ camera（镜头语言倾向）。每维 1-2 句，具体到可执行，不要写空话。
3. palette 输出 5 个主色 HEX，必须能真实反映该风格的色彩倾向（第一个为背景色）。
4. keywords_en 输出 5-8 个**英文视觉短语**。这是跨镜头一致性的锚点，会被逐镜 verbatim 拼进生图/生视频 prompt，因此必须是具体可见的视觉描述（如 "soft natural window light"、"brushed metal surface"），不要写抽象形容词堆砌（如 "beautiful"、"high quality"）。
5. negative 输出该风格要规避的内容，英文短语，逗号分隔。
6. name_zh 要具体，例如「北欧极简风的咖啡机产品广告」，不要只写「极简」。

输出要求：**只输出纯 JSON 对象**，不要 markdown 代码围栏，不要任何解释文字。字段严格如下：
{
  "name_zh": "",
  "name_en": "",
  "seed_match": "tech|warm|cinematic|kawaii|minimal|null",
  "rationale": "一句话说明为什么选这套风格",
  "style": "",
  "color": "",
  "lighting": "",
  "composition": "",
  "materials": "",
  "motion": "",
  "camera": "",
  "palette": ["#RRGGBB"],
  "keywords_en": [""],
  "negative": ""
}`;
}

export function styleUserPrompt(input: {
  brief: string;
  aspectRatio: string;
  targetDuration: number;
}): string {
  return `【广告需求】
${input.brief}

【约束】画幅 ${input.aspectRatio}，目标时长约 ${input.targetDuration} 秒。

请输出风格规格 JSON。`;
}

/** S2+S3 合并：润色 + 分镜（15 号 §6.1 的 S2/S3，但不出图，只产 prompt） */
export function shotsSystemPrompt(): string {
  return `你是资深广告分镜师（Storyboard Artist）兼提示词工程师。任务：基于已确认的风格规格，把广告需求拆成一组可直接投喂给生图模型与生视频模型的分镜。

硬规则（违反即判失败）：
1. **一镜一动作**：每个 shot 只写一个主体动作，禁止一个镜头塞多个动作或多次转场。
2. **首帧优先**：image_prompt 只写**静态画面**——主体外观 + 环境 + 构图 + 光线 + 材质 + 风格关键词。**绝对不能**出现运动、时间流逝、镜头运动类词汇（如 moving、pushing in、slowly、camera）。
3. **video_prompt** = 该镜的静态描述 + 镜头运动（英文）+ 主体动作（英文）+ 时长约束，写成一整段英文自然句，40-80 词。
4. **一致性锁定**：每一镜的 image_prompt 与 video_prompt 都必须 **verbatim 带上风格 keywords_en 的全部关键词**，且 consistency_notes 里锁定的主体/产品属性（如发色、服装、产品造型、Logo 位置）必须逐字相同，不得改写或近义替换。
5. **语言隔离**：英文版 image_prompt / video_prompt / negative_prompt 必须全英文（投喂生成模型用）；中文版 image_prompt_cn / video_prompt_cn / negative_prompt_cn 必须是英文版的**逐句准确翻译**（中文，供界面对照与人工校准），不得意译丢失生图技术细节（如景别、光位、镜头运动、材质词）。scene / subject / action / voiceover / transition_out 等字段始终中文。
6. **时长分配**：单镜 3-8 秒，所有 duration 之和 = target_duration（允许 ±10%）。start 从 0 开始严格累加。
7. **叙事结构**：首镜建立场景/抛出痛点，中段展示产品与效果，末镜必须有品牌落版或行动号召（CTA）。
8. voiceover 写中文口播或字幕文案；纯氛围镜头可填空字符串 ""。audio 写音乐/音效方向。
9. transition_out 写到下一镜的转场方式（硬切 / 叠化 / 匹配剪辑 / 甩镜 等），最后一个镜头填 "—"。
10. shots_count 必须等于 shots 数组长度。

输出要求：**只输出纯 JSON 对象**，不要 markdown 代码围栏，不要任何解释文字。结构严格如下：
{
  "meta": { "title": "", "aspect_ratio": "9:16", "target_duration": 30, "shots_count": 6 },
  "shots": [
    {
      "index": 1,
      "start": 0,
      "duration": 5,
      "shot_type": "景别（中文，如 特写/中景/全景）",
      "camera_movement": "镜头运动（中文，如 缓慢推近/固定机位）",
      "scene": "场景环境（中文）",
      "subject": "主体及其锁定属性（中文）",
      "action": "本镜唯一动作（中文）",
      "voiceover": "中文口播/字幕",
      "audio": "音乐与音效",
      "transition_out": "到下一镜的转场",
      "image_prompt": "English static frame description, 30-60 words",
      "video_prompt": "English motion description with camera movement, 40-80 words",
      "negative_prompt": "English negative words",
      "image_prompt_cn": "中文 · image_prompt 的准确翻译（逐句对应英文，用于界面对照展示）",
      "video_prompt_cn": "中文 · video_prompt 的准确翻译（逐句对应英文，用于界面对照展示）",
      "negative_prompt_cn": "中文 · negative_prompt 的准确翻译"
    }
  ],
  "global_negative": "全片统一英文负面词",
  "consistency_notes": ["跨镜必须逐字保持一致的属性"]
}`;
}

export function shotsUserPrompt(input: {
  brief: string;
  aspectRatio: string;
  targetDuration: number;
  style: StyleSpec;
  shotCount: number;
}): string {
  return `【广告需求】
${input.brief}

【已确认的风格规格】（逐镜必须沿用其 keywords_en 与视觉设定）
${JSON.stringify(input.style, null, 2)}

【约束】
- 画幅：${input.aspectRatio}
- 目标总时长：${input.targetDuration} 秒
- 分镜数量：${input.shotCount} 个（必须严格产出 ${input.shotCount} 个 shot）

请输出分镜 JSON。`;
}

/** 按时长推算镜数：单镜 5 秒左右（14 号 §2.2 社区惯例） */
export function suggestShotCount(targetDuration: number): number {
  const n = Math.round(targetDuration / 5);
  return Math.min(24, Math.max(2, n));
}

/* ─────────────────────────────────────────────────────────────
 * 两段式生成（解决单次大 JSON 超时/失败问题）：
 *   第一步 outline：每镜一句话规划，输出体量小，10-30s 可完成
 *   第二步 shotDetail：逐镜展开（每次单镜），失败只重试单镜
 * ───────────────────────────────────────────────────────────── */

/** 第一步：大纲。只规划叙事结构与节奏，不写 prompt */
export function outlineSystemPrompt(): string {
  return `你是资深广告分镜师。任务：把广告需求拆成一份**分镜大纲**——只做叙事规划，不写生图/生视频 prompt（那是下一步逐镜展开的事）。

硬规则：
1. 每镜只规划：index / duration（秒）/ shot_type（景别，中文）/ scene（场景环境，一句话）/ action（本镜唯一动作，一句话）/ voiceover（中文口播或字幕，纯氛围镜填 ""）。
2. **一镜一动作**：禁止一个镜头塞多个动作或多次转场。
3. 单镜 3-8 秒；所有 duration 之和 = 目标时长（允许 ±10%）。
4. index 从 1 连续递增；shots_count 必须等于 outline 数组长度。
5. 叙事结构：首镜建立场景或抛出痛点 → 中段展示产品与效果 → 末镜品牌落版或行动号召（CTA）。
6. global_negative 输出全片统一的英文负面词（逗号分隔短语）。
7. consistency_notes 输出跨镜必须逐字一致的主体/产品属性清单（中文，如产品造型、Logo 位置、人物服装）。

输出要求：**只输出纯 JSON 对象**，不要 markdown 围栏，不要解释。结构严格如下：
{
  "meta": { "title": "", "aspect_ratio": "9:16", "target_duration": 30 },
  "shots_count": 6,
  "global_negative": "English, comma separated",
  "consistency_notes": ["跨镜逐字一致的属性"],
  "outline": [
    { "index": 1, "duration": 5, "shot_type": "全景", "scene": "场景一句话", "action": "唯一动作一句话", "voiceover": "口播或空串" }
  ]
}`;
}

export function outlineUserPrompt(input: {
  brief: string;
  aspectRatio: string;
  targetDuration: number;
  shotCount: number;
}): string {
  return `【广告需求】
${input.brief}

【约束】
- 画幅：${input.aspectRatio}
- 目标总时长：${input.targetDuration} 秒
- 分镜数量：${input.shotCount} 个（必须严格产出 ${input.shotCount} 个镜头条目）

请输出分镜大纲 JSON。`;
}

/** 第二步：单镜展开。输入大纲与相邻镜头，输出该镜完整字段（含中英双语 prompt） */
export function shotDetailSystemPrompt(): string {
  return `你是资深广告分镜师兼提示词工程师。任务：把大纲中的一个镜头**展开成完整分镜卡**（含可投喂生图/生视频模型的中英 prompt）。

硬规则（违反即判失败）：
1. **一镜一动作**：只写大纲给定的这一个动作，禁止追加动作或转场。
2. **首帧优先**：image_prompt 只写**静态画面**——主体外观 + 环境 + 构图 + 光线 + 材质 + 风格关键词。**绝对不能**出现运动、时间流逝、镜头运动类词汇（如 moving、pushing in、slowly、camera）。
3. **video_prompt** = 该镜静态描述 + 镜头运动（英文）+ 主体动作（英文）+ 时长约束，一整段英文自然句，40-80 词。
4. **一致性锁定**：image_prompt / video_prompt 必须 **verbatim 带上风格 keywords_en 的全部关键词**；consistency_notes 锁定的属性逐字相同，不得改写或近义替换；与相邻镜头的场景、主体描述保持连贯。
5. **语言隔离**：image_prompt / video_prompt / negative_prompt 全英文；image_prompt_cn / video_prompt_cn / negative_prompt_cn 是对应英文版的**逐句准确翻译**（不得意译丢失生图技术细节）。scene / subject / action / voiceover / transition_out 等中文字段全中文。
6. transition_out 写到下一镜的转场方式（硬切 / 叠化 / 匹配剪辑 / 甩镜 等）；如果是最后一个镜头填 "—"。
7. audio 写本镜音乐/音效方向（中文）。camera_movement 写镜头运动（中文）。

输出要求：**只输出纯 JSON 对象**（单镜对象，不是数组），不要 markdown 围栏，不要解释。结构严格如下：
{
  "index": 1,
  "duration": 5,
  "shot_type": "景别（中文）",
  "camera_movement": "镜头运动（中文）",
  "scene": "场景环境（中文）",
  "subject": "主体及其锁定属性（中文）",
  "action": "本镜唯一动作（中文）",
  "voiceover": "中文口播/字幕",
  "audio": "音乐与音效",
  "transition_out": "到下一镜的转场",
  "image_prompt": "English static frame description, 30-60 words",
  "video_prompt": "English motion description with camera movement, 40-80 words",
  "negative_prompt": "English negative words",
  "image_prompt_cn": "中文 · image_prompt 的逐句准确翻译",
  "video_prompt_cn": "中文 · video_prompt 的逐句准确翻译",
  "negative_prompt_cn": "中文 · negative_prompt 的准确翻译"
}`;
}

export function shotDetailUserPrompt(input: {
  brief: string;
  style: StyleSpec;
  outline: Outline;
  index: number;
  neighbors: Shot[];
}): string {
  const item = input.outline.outline.find((o) => o.index === input.index) ?? input.outline.outline[0];
  const compact = input.outline.outline
    .map((o) => `镜${o.index}(${o.duration}s/${o.shot_type})：${o.scene}｜动作：${o.action}`)
    .join("\n");
  const prev = input.neighbors.filter((n) => n.index === input.index - 1)[0];
  const next = input.neighbors.filter((n) => n.index === input.index + 1)[0];
  const last = input.index >= input.outline.outline.length;

  return `【广告需求】
${input.brief}

【已确认的风格规格】（keywords_en 必须 verbatim 拼进两个英文 prompt）
${JSON.stringify({ style: input.style.style, color: input.style.color, lighting: input.style.lighting, composition: input.style.composition, materials: input.style.materials, palette: input.style.palette, keywords_en: input.style.keywords_en, negative: input.style.negative }, null, 2)}

【全片大纲】（保持与其他镜连贯）
${compact}

【一致性锁定】（逐字沿用，不得改写）
${input.outline.consistency_notes.join("；") || "（无特别锁定项）"}

【全片统一负面词】${input.outline.global_negative || "（无）"}

【本次要展开的镜头】第 ${input.index} 镜：
${JSON.stringify(item, null, 2)}

${prev ? `【上一镜（镜${prev.index}）要点】场景：${prev.scene}｜主体：${prev.subject}\n上一镜 image_prompt 开头（衔接参考）：${prev.image_prompt.slice(0, 120)}…\n` : ""}${next ? `【下一镜（镜${next.index}）要点】场景：${next.scene}｜动作：${next.action}\n` : ""}${last ? "【注意】这是最后一个镜头：transition_out 填 \"—\"，画面要有品牌落版或 CTA。\n" : ""}
请输出第 ${input.index} 镜的完整分镜 JSON。`;
}
