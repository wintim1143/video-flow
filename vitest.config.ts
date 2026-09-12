import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@": `${root}src` },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // 测试全程禁止触碰项目根的真实配置文件：trace 落盘一律重定向到 /tmp
    env: {
      TRACE_LOG_DIR: "/tmp/video-flow-traces-test",
      // 退避基数归零：重试逻辑照跑，但测试不真的等待
      LLM_RETRY_BASE_MS: "0",
    },
  },
});
