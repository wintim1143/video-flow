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

/** S1-B：从参考图提取风格（图是风格唯一/主要来源，文字仅补充内容信息） */
export function styleFromImageSystemPrompt(): string {
  return `你是广告视觉总监（Visual Director）。任务：分析用户上传的参考图，把它的**视觉风格**提取成一套可逐镜执行的风格规格——后续所有分镜都要复刻这张图的视觉气质。

可用的内置风格 seed（用于锚定；参考图与某个 seed 高度贴近时填其 id，否则填 null）：
${seedSummaryForPrompt()}

工作步骤：
1. 仔细观察参考图：主色调与配色关系、光照方向与光质、构图方式、材质质感、整体风格倾向、画面的运动感暗示。
2. 用中文填写 7 个维度：style（风格总述）/ color（色调与配色，必须与图中实际色彩一致）/ lighting（光位与光质，写明光源在画面哪个方向）/ composition（构图法则）/ materials（材质与质感）/ motion（该风格适合的运动语言）/ camera（镜头语言倾向）。每维 1-2 句，具体到可执行。
3. palette 输出 5 个主色 HEX，**必须从图中实际取色**（第一个为背景/主底色），禁止凭空编色。
4. keywords_en 输出 5-8 个**英文视觉短语**，精确复刻图中的视觉特征（如 "warm tungsten side light"、"matte charcoal metal surface"）。这是跨镜头一致性的锚点，会被逐镜 verbatim 拼进生图/生视频 prompt，必须具体可见，禁止抽象词。
5. negative 输出与该风格冲突、应规避的内容（英文短语，逗号分隔）。
6. name_zh 要具体，例如「暖调黄昏光的咖啡产品风格」，并点明"提取自参考图"。
7. rationale 一句话：这张图的风格特征是什么、适合什么类型的产品广告。

注意：只提取**风格**，不要描述图片内容本身是什么产品/场景——内容由用户的文字描述提供（若有）。

输出要求：**只输出纯 JSON 对象**，不要 markdown 围栏，不要任何解释文字。字段严格如下：
{
  "name_zh": "",
  "name_en": "",
  "seed_match": "tech|warm|cinematic|kawaii|minimal|null",
  "rationale": "",
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

export function styleFromImageUserPrompt(input: { brief: string }): string {
  return input.brief.trim()
    ? `请分析这张参考图的视觉风格，输出风格规格 JSON。

【文字补充】（参考图之外的广告内容信息，仅用于 name_zh/rationale 的贴合，不影响风格提取本身）
${input.brief.trim()}`
    : "请分析这张参考图的视觉风格，输出风格规格 JSON。";
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
8. **实体档案 entities**：为每个跨镜出现的主体（产品/人物/载具等）输出一条 { name_zh, descriptor_en }。descriptor_en 是**锁定的英文视觉描述**，必须写明：外观特征 + **朝向/方位的基准约定**（如 "front of the car facing the camera, headlights on, red taillight strip visible"）+ 关键状态词。descriptor_en 会被逐镜 verbatim 拼进生图/生视频 prompt，因此必须具体、自包含，禁止抽象词（如 "beautiful"）。
9. **状态链 start_state / end_state**：每镜输出镜首状态 start_state 与镜末状态 end_state（中文）。内容必须写明：**主体的朝向与方位**（如"车头朝向镜头偏左 45°"、人物面向右侧）、主体状态（车灯亮灭、门窗开合、人物姿态）、环境状态（时间/天气/光源方向，如"夕阳侧逆光从画面左侧打来"）。
10. **状态链连续性（最高优先级）**：镜 N 的 end_state 必须与镜 N+1 的 start_state **完全一致**——除非 transition 明确换场/换时，也必须在两处写明"转场后：……"。朝向、光源方向一旦建立，未经转场说明禁止翻转（例如上一镜车头朝向镜头，下一镜不允许凭空变成车尾朝向镜头）。

输出要求：**只输出纯 JSON 对象**，不要 markdown 围栏，不要解释。结构严格如下：
{
  "meta": { "title": "", "aspect_ratio": "9:16", "target_duration": 30 },
  "shots_count": 6,
  "global_negative": "English, comma separated",
  "consistency_notes": ["跨镜逐字一致的属性"],
  "entities": [
    { "name_zh": "主体中文名", "descriptor_en": "locked English visual descriptor with orientation baseline" }
  ],
  "outline": [
    { "index": 1, "duration": 5, "shot_type": "全景", "scene": "场景一句话", "action": "唯一动作一句话", "voiceover": "口播或空串", "start_state": "镜首状态（朝向/位置/状态+环境）", "end_state": "镜末状态" }
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
4. **一致性锁定**：image_prompt / video_prompt 必须 **verbatim 带上风格 keywords_en 的全部关键词**；consistency_notes 锁定的属性逐字相同，不得改写或近义替换；entities 里相关主体的 descriptor_en 必须 **verbatim 嵌入**（可自然融入句子，但朝向与状态词不得改动）。
5. **状态链衔接（最高优先级，违反即全片错位）**：image_prompt 描述的静态画面必须**严格等于**本镜 start_state——主体的朝向、方位、状态（如车灯亮灭）与光源方向必须与 start_state 完全一致，禁止凭空翻转或改向；video_prompt 必须从 start_state 出发、**连续演化到 end_state 结束**，中间不得跳变。上一镜 end_state 已在下方给出，你的画面就是从那一刻接续的。
6. **语言隔离**：image_prompt / video_prompt / negative_prompt 全英文；image_prompt_cn / video_prompt_cn / negative_prompt_cn 是对应英文版的**逐句准确翻译**（不得意译丢失生图技术细节）。scene / subject / action / voiceover / transition_out 等中文字段全中文。
7. transition_out 写到下一镜的转场方式（硬切 / 叠化 / 匹配剪辑 / 甩镜 等）；如果是最后一个镜头填 "—"。
8. audio 写本镜音乐/音效方向（中文）。camera_movement 写镜头运动（中文）。

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
  "start_state": "照抄大纲给定的本镜镜首状态，不得改写",
  "end_state": "照抄大纲给定的本镜镜末状态，不得改写",
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
  const prevItem = input.outline.outline.find((o) => o.index === input.index - 1);
  const nextItem = input.outline.outline.find((o) => o.index === input.index + 1);
  const prev = input.neighbors.filter((n) => n.index === input.index - 1)[0];
  const next = input.neighbors.filter((n) => n.index === input.index + 1)[0];
  const last = input.index >= input.outline.outline.length;

  return `【广告需求】
${input.brief}

【已确认的风格规格】（keywords_en 必须 verbatim 拼进两个英文 prompt）
${JSON.stringify({ style: input.style.style, color: input.style.color, lighting: input.style.lighting, composition: input.style.composition, materials: input.style.materials, palette: input.style.palette, keywords_en: input.style.keywords_en, negative: input.style.negative }, null, 2)}

【全片大纲】（保持与其他镜连贯）
${compact}

【实体档案】（相关主体的 descriptor_en 必须 verbatim 嵌入两个英文 prompt，朝向与状态词不得改动）
${input.outline.entities.length ? input.outline.entities.map((e) => `- ${e.name_zh}：${e.descriptor_en}`).join("\n") : "（无）"}

【一致性锁定】（逐字沿用，不得改写）
${input.outline.consistency_notes.join("；") || "（无特别锁定项）"}

【全片统一负面词】${input.outline.global_negative || "（无）"}

【本次要展开的镜头】第 ${input.index} 镜：
${JSON.stringify(item, null, 2)}

${prevItem?.end_state ? `【上一镜（镜${prevItem.index}）末状态】（你的画面必须从此状态接续，朝向/光源/位置不得跳变）\n${prevItem.end_state}\n` : ""}${item.start_state ? `【本镜镜首状态】image_prompt 的静态画面必须严格等于此状态\n${item.start_state}\n` : ""}${item.end_state ? `【本镜镜末状态】video_prompt 必须演化到此状态结束\n${item.end_state}\n` : ""}${prev ? `【上一镜（镜${prev.index}）要点】场景：${prev.scene}｜主体：${prev.subject}\n上一镜 image_prompt 开头（衔接参考）：${prev.image_prompt.slice(0, 120)}…\n` : ""}${next || nextItem ? `【下一镜（镜${(next ?? nextItem)!.index}）要点】场景：${(next ?? nextItem)!.scene}｜动作：${(next ?? nextItem)!.action}\n` : ""}${last ? "【注意】这是最后一个镜头：transition_out 填 \"—\"，画面要有品牌落版或 CTA。\n" : ""}
请输出第 ${input.index} 镜的完整分镜 JSON。`;
}
