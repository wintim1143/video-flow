/** 前端可见的 LLM profile（脱敏，无 apiKey） */
export type LlmProfileSafe = {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  endpoint?: string;
  /** 是否支持图片输入；缺省 = 支持，显式 false = 纯文本模型 */
  vision?: boolean;
};

export type LlmConfigsResponse = {
  text: LlmProfileSafe[];
  image: LlmProfileSafe[];
  video: LlmProfileSafe[];
};
