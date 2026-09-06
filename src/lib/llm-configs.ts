import fs from "node:fs";
import path from "node:path";

/**
 * 多 LLM 配置层。
 * 来源优先级：llm.config.json（项目根） > .env.local（仅 text 回退，保持向后兼容）。
 * apiKey 只在服务端流转，对外一律走 listProfilesSafe 脱敏。
 */

export type LlmKind = "text" | "image" | "video";

export interface LlmProfile {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
  /** image 专用：API 路径，默认 /images/generations */
  endpoint?: string;
  /**
   * 推理模型的思考力度（OpenAI 兼容 reasoning_effort）。
   * 默认 minimal：分镜 JSON 任务不需要深思考，可把耗时降低一个数量级。
   * 服务商不支持时自动降级去掉该参数。设为 "" 可显式关闭。
   */
  reasoningEffort?: string;
  /**
   * 是否支持图片输入（vision/多模态）。
   * 缺省(undefined) = 支持（向后兼容：现有配置零改动）；显式 false = 纯文本模型（如 DeepSeek），
   * 参考图提取风格时前端不可选、服务端拒绝。
   */
  vision?: boolean;
}

export type LlmConfig = Record<LlmKind, LlmProfile[]>;

const CONFIG_PATH = path.join(process.cwd(), "llm.config.json");

interface RawProfile {
  id?: unknown;
  name?: unknown;
  baseURL?: unknown;
  apiKey?: unknown;
  model?: unknown;
  endpoint?: unknown;
  reasoningEffort?: unknown;
  vision?: unknown;
}

function normalizeList(raw: unknown, kind: LlmKind): LlmProfile[] {
  if (!Array.isArray(raw)) return [];
  const out: LlmProfile[] = [];
  (raw as RawProfile[]).forEach((o, i) => {
    if (!o || typeof o !== "object") return;
    const baseURL = typeof o.baseURL === "string" ? o.baseURL.trim() : "";
    const apiKey = typeof o.apiKey === "string" ? o.apiKey.trim() : "";
    const model = typeof o.model === "string" ? o.model.trim() : "";
    if (!baseURL || !apiKey || !model) return; // 缺任一字段直接丢弃，不半残运行
    out.push({
      id: typeof o.id === "string" && o.id.trim() ? o.id.trim() : `${kind}-${i + 1}`,
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : model,
      baseURL: baseURL.replace(/\/+$/, ""),
      apiKey,
      model,
      endpoint: typeof o.endpoint === "string" && o.endpoint.trim() ? o.endpoint.trim() : undefined,
      reasoningEffort:
        typeof o.reasoningEffort === "string" && o.reasoningEffort.trim() ? o.reasoningEffort.trim() : undefined,
      /* 仅显式 false 才标记纯文本；缺省按支持处理（向后兼容） */
      vision: o.vision === false ? false : undefined,
    });
  });
  return out;
}

function loadFile(): LlmConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    // 文件不存在 / 非法 JSON → 全空，靠 env 回退
  }
  return {
    text: normalizeList(raw.text, "text"),
    image: normalizeList(raw.image, "image"),
    video: normalizeList(raw.video, "video"),
  };
}

/** 读配置（带 .env.local 回退）。每次现读，改完配置刷新页面即生效，无需重启 */
export function loadLlmConfig(): LlmConfig {
  const cfg = loadFile();
  if (!cfg.text.length) {
    const apiKey = process.env.LLM_API_KEY?.trim();
    const baseURL = process.env.LLM_BASE_URL?.trim();
    const model = process.env.LLM_MODEL?.trim();
    if (apiKey && baseURL && model && !apiKey.startsWith("sk-xxxx") && !baseURL.includes("your-gateway")) {
      const envEffort = process.env.LLM_REASONING_EFFORT?.trim();
      const envVision = process.env.LLM_VISION?.trim();
      cfg.text = [
        {
          id: "env-default",
          name: `${model}（.env.local）`,
          baseURL: baseURL.replace(/\/+$/, ""),
          apiKey,
          model,
          reasoningEffort: envEffort || "minimal",
          vision: envVision === "false" || envVision === "0" ? false : undefined,
        },
      ];
    }
  }
  return cfg;
}

export function listProfiles(kind: LlmKind): LlmProfile[] {
  return loadLlmConfig()[kind];
}

/** 取指定 profile；id 缺省/无效时回退该组第一个；组为空返回 null */
export function resolveProfile(kind: LlmKind, id?: string): LlmProfile | null {
  const list = listProfiles(kind);
  if (!list.length) return null;
  return list.find((p) => p.id === id) ?? list[0];
}

/** 脱敏版（给前端下拉用，绝不含 apiKey） */
export function listProfilesSafe(
  kind: LlmKind
): Array<Omit<LlmProfile, "apiKey">> {
  return listProfiles(kind).map(({ apiKey: _k, ...rest }) => rest);
}
