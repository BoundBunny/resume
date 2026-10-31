"use client";

import React, { useState } from "react";
import type { ResumeData } from "@/types/resume";
import ResumePreviewPaginated from "@/components/resume-preview-paginated";

/**
 * 打印专用页面：供服务端 Chromium 渲染 PDF，或浏览器直接打印。
 * 使用与预览相同的 A4 分页卡片，打印样式中每张卡片恰好一页、页边距为 0，
 * 因此浏览器打印不会附带页眉页脚，且各页留白一致。
 */
export default function PrintContent({ initialData, autoPrint = false }: { initialData?: ResumeData | null; autoPrint?: boolean }) {
  // 避免在 effect 中同步 setState：使用惰性初始化从 sessionStorage 恢复
  const [resumeData] = useState<ResumeData | null>(() => {
    if (initialData) return initialData;
    if (typeof window !== "undefined") {
      try {
        const s = sessionStorage.getItem("resumeData");
        if (s) return JSON.parse(s) as ResumeData;
      } catch { }
    }
    return null;
  });

  // 自动打印：等字体与分页卡片都就绪后再触发
  React.useEffect(() => {
    if (!autoPrint || !resumeData) return;
    let cancelled = false;
    const run = async () => {
      try {
        await document.fonts.ready;
      } catch { }
      const started = Date.now();
      while (!cancelled && !document.querySelector(".resume-page .resume-content") && Date.now() - started < 3000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (cancelled) return;
      setTimeout(() => {
        try { window.print(); } catch { }
      }, 80);
    };
    void run();
    return () => { cancelled = true; };
  }, [autoPrint, resumeData]);

  if (!resumeData) {
    return (
      <div className="pdf-preview-mode">
        <div className="resume-content p-8">
          <h1 className="text-xl font-bold mb-4">无法加载简历数据</h1>
          <p className="text-muted-foreground">请通过后端生成接口或附带 data 参数访问本页面。</p>
        </div>
      </div>
    );
  }

  return <ResumePreviewPaginated resumeData={resumeData} />;
}
