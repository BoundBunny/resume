"use client"

import { useEffect, useState } from "react"
import dynamic from "next/dynamic"
import PdfLoading from "@/components/pdf-loading"
import type { ResumeData } from "@/types/resume"
import { Button } from "@/components/ui/button"
import { Icon } from "@iconify/react"

// 动态导入 PDF 组件，禁用 SSR
const DynamicPDFViewer = dynamic(
  () => import("@/components/pdf-viewer").then((mod) => mod.PDFViewer),
  { ssr: false, loading: () => <PdfLoading /> }
)

function PDFPreviewContent() {
  // 在首屏渲染时保持为 null，避免因读取 sessionStorage 导致 SSR/CSR 标记不一致
  const [resumeData, setResumeData] = useState<ResumeData | null>(null)
  const [fallback, setFallback] = useState(false)
  // derive from location to avoid setState in effect
  const serverFilename = typeof window !== 'undefined'
    ? (window.location.pathname || '').split('/').filter(Boolean).pop()
    : undefined

  // Wire postMessage handshake once
  useEffect(() => {
    // 1) 首次挂载后再从 sessionStorage 恢复数据，确保与服务器标记一致
    try {
      const cached = sessionStorage.getItem('resumeData')
      if (cached) {
        const parsed: ResumeData = JSON.parse(cached)
        if (typeof queueMicrotask === 'function') {
          queueMicrotask(() => setResumeData(parsed))
        } else {
          setTimeout(() => setResumeData(parsed), 0)
        }
      }
    } catch { }

    const handleMessage = (event: MessageEvent) => {
      // 只接受同源页面投递的简历数据
      if (event.origin !== window.location.origin) return;
      const payload = (event as unknown as { data?: { type?: string; data?: ResumeData } }).data;
      if (payload?.type === 'resumeData' && payload.data) {
        setResumeData(payload.data);
        try { sessionStorage.setItem('resumeData', JSON.stringify(payload.data)); } catch { }
      }
    };
    window.addEventListener('message', handleMessage);
    if (window.opener) {
      window.opener.postMessage({ type: 'ready' }, window.location.origin);
    }
    return () => window.removeEventListener('message', handleMessage);
  }, [])

  // 当处于回退（浏览器打印）模式时，拦截 Ctrl/Cmd+P，跳转到纯净打印页，
  // 该页面会等待字体就绪后再自动触发打印，避免行距因替换字体而变化。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
        if (fallback) {
          e.preventDefault();
          try {
            const url = new URL('/print', window.location.origin);
            url.searchParams.set('auto', '1');
            window.open(url.toString(), '_blank', 'noopener,noreferrer');
          } catch {
            try { window.location.href = '/print?auto=1'; } catch { }
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fallback]);

  // 在拿到数据前直接显示“正在生成 PDF…”的等待视图，避免空白页
  if (!resumeData) return <PdfLoading fullScreen />

  return (
    <div className="pdf-preview-page-root flex flex-col h-screen overflow-hidden print:h-auto print:overflow-visible">
      {fallback && (
        <div className="flex items-center justify-between p-4 border-b no-print print:hidden">
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl font-bold">PDF预览</h1>
            <div className="flex items-baseline gap-1 text-xs text-muted-foreground">
              <Icon icon="mdi:alert-circle" className="w-3.5 h-3.5 text-amber-600" />
              <span>服务器不可用，已切换为浏览器打印。请在打印对话框中勾选“背景图形”，边距保持“默认”。</span>
              <Button size="sm" className="ml-2 h-6 px-2 py-1 text-xs" onClick={() => window.print()}>
                打印/保存为 PDF
              </Button>
            </div>
          </div>
        </div>
      )}
      <div className="flex-1 overflow-hidden flex print:overflow-visible print:h-auto">
        <div className="w-full h-full print:h-auto">
          <DynamicPDFViewer
            resumeData={resumeData}
            renderNotice="external"
            serverFilename={serverFilename}
            onModeChange={(m) => setFallback(m === "fallback")}
          />
        </div>
      </div>
    </div>
  )
}

export default function PDFPreviewPage() {
  // 直接渲染内容，不使用 Suspense 回退以避免“加载中...”中间态
  return <PDFPreviewContent />
}

