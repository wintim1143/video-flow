import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "video-flow · 广告分镜工作台",
  description: "文本 → 风格匹配 → 分镜脚本（M0 里程碑：只产 prompt，不生图/不生视频）",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
