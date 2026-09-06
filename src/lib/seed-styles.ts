/**
 * 极小自建风格 seed（15 号决策 1）。
 * 作用：防「纯文本自由发挥 → 风格漂移」。LLM 先尝试匹配其一，匹配不上才自由定义。
 * 只做锚定语料，不做运行时模板库。
 */
export interface SeedStyle {
  id: string;
  name_zh: string;
  name_en: string;
  /** 命中关键词（中文），用于提示与 UI 展示 */
  keywords: string[];
  style: string;
  color: string;
  lighting: string;
  composition: string;
  materials: string;
  motion: string;
  camera: string;
  palette: string[];
  keywords_en: string[];
  negative: string;
}

export const SEED_STYLES: SeedStyle[] = [
  {
    id: "tech",
    name_zh: "科技感",
    name_en: "Tech / Futurism",
    keywords: ["科技", "智能", "数码", "未来", "AI", "芯片", "app", "极客"],
    style:
      "干净冷冽的科技广告风，深色空间衬托发光产品，强调精密感与未来感，克制不炫技。",
    color: "深蓝黑主色，青蓝与品红点缀，高对比冷色调，局部霓虹高光。",
    lighting: "暗场轮廓光 + 边缘冷光勾边，产品表面有细腻反射与体积雾。",
    composition: "中心对称或三分法，大量负空间，产品悬浮于画面中央。",
    materials: "磨砂金属、玻璃、哑光塑料、拉丝铝，表面洁净无指纹。",
    motion: "匀速机械运动、平滑轨道推进、电流流动、粒子涌现。",
    camera: "锁定三脚架与滑轨为主，缓慢 dolly in / orbit，避免手持晃动。",
    palette: ["#0B1220", "#12324A", "#22D3EE", "#7DD3FC", "#E879F9"],
    keywords_en: [
      "futuristic tech commercial",
      "deep navy and cyan palette",
      "rim lighting",
      "clean negative space",
      "volumetric haze",
      "brushed metal and glass",
    ],
    negative:
      "cluttered background, warm cozy tones, handheld shake, cartoon, text artifacts, low resolution",
  },
  {
    id: "warm",
    name_zh: "温情生活",
    name_en: "Warm Lifestyle",
    keywords: ["温情", "家庭", "亲子", "陪伴", "治愈", "生活", "家居", "美食"],
    style: "自然生活流，真实人物与日常瞬间，暖调柔光，强调情绪与陪伴感。",
    color: "米白、奶油、暖木色为主，柔和低饱和，肤色优先。",
    lighting: "大面积自然散射光，窗光与黄昏逆光，柔和高光不过曝。",
    composition: "偏写实抓拍构图，人物视线留白，允许轻微不规则。",
    materials: "棉麻、原木、陶瓷、食物真实质感，保留生活痕迹。",
    motion: "生活化自然动作，慢速但有呼吸感，避免机械匀速。",
    camera: "肩扛轻微呼吸感或固定机位，中近景为主，浅景深。",
    palette: ["#FDF6EC", "#E8C9A8", "#C97B4A", "#8C5E3C", "#F2B5A0"],
    keywords_en: [
      "warm lifestyle commercial",
      "creamy beige palette",
      "soft natural window light",
      "shallow depth of field",
      "authentic candid moment",
      "cozy home textures",
    ],
    negative:
      "cold sterile, harsh flash, plastic skin, over-saturated, stock photo stiffness",
  },
  {
    id: "cinematic",
    name_zh: "电影大片",
    name_en: "Cinematic Epic",
    keywords: ["大片", "电影感", "史诗", "高端", "汽车", "奢侈品", "品牌形象"],
    style: "电影级广告质感，宽幅叙事，强光影造型与氛围，追求品牌高度。",
    color: "青橙对比（teal & orange）或低饱和冷灰，暗部厚重。",
    lighting: "单一主光 + 强反差，硬光造型，逆光剪影与光斑。",
    composition: "宽幅横构图、低机位仰拍、对称与引导线强化气势。",
    materials: "车漆、丝绸、石材、金属，强调反光与纹理细节。",
    motion: "缓慢有力的推进，慢动作点缀，节奏有留白与爆发。",
    camera: "摇臂、斯坦尼康、无人机航拍，长焦压缩与广角气势交替。",
    palette: ["#0E1116", "#1F3A44", "#B5651D", "#E0A458", "#F3E9D2"],
    keywords_en: [
      "cinematic epic commercial",
      "teal and orange grade",
      "anamorphic lens flare",
      "low angle hero shot",
      "dramatic hard key light",
      "35mm film grain",
    ],
    negative:
      "flat even lighting, amateur framing, overexposed, shaky, video game look",
  },
  {
    id: "kawaii",
    name_zh: "萌系活泼",
    name_en: "Playful Kawaii",
    keywords: ["萌", "可爱", "年轻", "活泼", "潮玩", "甜品", "宠物", "学生"],
    style: "高饱和明快的可爱风，圆润造型与卡通化表达，节奏轻快。",
    color: "糖果色系，粉/柠檬黄/薄荷绿撞色，明亮通透。",
    lighting: "柔和均匀无硬影，整体提亮，轻微发光感。",
    composition: "居中饱满构图，图形化元素与贴纸式排版感。",
    materials: "哑光塑料、绒毛、奶油、果冻质感，触感柔软。",
    motion: "弹跳、缩放、快速切换，卡点节奏感强。",
    camera: "快速推拉与轻微手持抖动，俯拍与平视交替。",
    palette: ["#FFF3FA", "#FFB3C6", "#FFE066", "#9BF6FF", "#B8F2B0"],
    keywords_en: [
      "kawaii playful commercial",
      "candy pastel palette",
      "soft even lighting",
      "bouncy motion",
      "rounded shapes",
      "sticker style composition",
    ],
    negative:
      "dark moody, gritty realism, desaturated, horror, harsh shadows, realistic human skin pores",
  },
  {
    id: "minimal",
    name_zh: "极简高级",
    name_en: "Minimal Premium",
    keywords: ["极简", "高级", "留白", "质感", "美妆", "护肤", "设计", "专业"],
    style: "极致克制的极简广告，纯色背景 + 产品本体，靠材质与光影取胜。",
    color: "单一主色（白/米/墨黑）+ 一个点缀色，几乎无杂色。",
    lighting: "柔和顶光或侧逆光，渐变背景，微投影托住产品。",
    composition: "绝对居中或严格三分，大面积留白，画面秩序感强。",
    materials: "玻璃、陶瓷、哑光卡纸、液体，突出表面细腻反射。",
    motion: "极慢位移与微距流转，水滴/粉末/丝带等单一物理运动。",
    camera: "固定微距机位，缓慢平移或极慢推进，焦平面切换。",
    palette: ["#FAFAF8", "#E7E4DE", "#B9B4AA", "#2B2A28", "#C8A96A"],
    keywords_en: [
      "minimal premium commercial",
      "monochrome background",
      "soft gradient backdrop",
      "macro product detail",
      "slow elegant motion",
      "studio softbox lighting",
    ],
    negative:
      "busy background, multiple colors, text overlay, clutter, harsh contrast, low detail",
  },
];

/** 给 LLM 的精简 seed 摘要（控制 prompt 体积） */
export function seedSummaryForPrompt(): string {
  return SEED_STYLES.map(
    (s) =>
      `- id="${s.id}" ${s.name_zh}(${s.name_en}): 关键词[${s.keywords.join("/")}]；${s.style} 色:${s.color} 光:${s.lighting} 构图:${s.composition} 材质:${s.materials} 运动:${s.motion} 镜头:${s.camera}；英文关键词:${s.keywords_en.join(", ")}；负面:${s.negative}`
  ).join("\n");
}

export function findSeed(id: string | null | undefined): SeedStyle | undefined {
  if (!id) return undefined;
  return SEED_STYLES.find((s) => s.id === id);
}
