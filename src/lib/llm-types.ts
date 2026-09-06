/** 前端可见的 LLM profile（脱敏，无 apiKey） */
export type LlmProfileSafe = {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  endpoint?: string;
};

export type LlmConfigsResponse = {
  text: LlmProfileSafe[];
  image: LlmProfileSafe[];
  video: LlmProfileSafe[];
};
