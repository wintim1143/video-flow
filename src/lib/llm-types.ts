/** 前端可见的 LLM profile（脱敏，无 apiKey） */
export type LlmProfileSafe = {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  endpoint?: string;
  /** 是否支持图片输入；缺省 = 支持，显式 false = 纯文本模型 */
  vision?: boolean;
  /** video 专用：厂商适配器 id（agnes / openai…），见 lib/video-providers.ts */
  provider?: string;
  /** video 专用：强制指定的生成模式；通常留空由适配器按媒体字段推断 */
  mode?: string;
};

export type LlmConfigsResponse = {
  text: LlmProfileSafe[];
  image: LlmProfileSafe[];
  video: LlmProfileSafe[];
};
