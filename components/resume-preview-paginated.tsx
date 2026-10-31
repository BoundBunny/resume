"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ResumeData } from "@/types/resume"
import {
  MM_TO_PX,
  PAGE_CONTENT_HEIGHT_MM,
  PAGE_HEIGHT_MM,
  PAGE_MARGIN_MM,
  PAGE_WIDTH_MM,
  measurePagination,
  mountPageClone,
  type MeasuredPagination,
} from "@/lib/pagination"
import ResumePreview from "./resume-preview"

interface ResumePreviewPaginatedProps {
  resumeData: ResumeData
  className?: string
}

const PAGE_GAP_PX = 16
const PAGE_WIDTH_PX = PAGE_WIDTH_MM * MM_TO_PX
const PAGE_HEIGHT_PX = PAGE_HEIGHT_MM * MM_TO_PX
const PAGE_MARGIN_PX = PAGE_MARGIN_MM * MM_TO_PX
const PAGE_CONTENT_HEIGHT_PX = PAGE_CONTENT_HEIGHT_MM * MM_TO_PX

/**
 * 把简历按 A4 真实分页展示：每页一张白纸、页间留灰色间隔、右下角标页码。
 *
 * 实现方式：离屏渲染一份真实 A4 宽度的简历作为测量源，算出每页起点后，
 * 为每一页克隆一份内容放进固定高度的取景窗并向上平移，裁出该页应显示的部分。
 * 容器不够宽时整体等比缩小。打印时卡片即打印页：取消缩放，每张卡片恰好一页。
 */
export default function ResumePreviewPaginated({ resumeData, className }: ResumePreviewPaginatedProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const sourceRef = useRef<HTMLDivElement | null>(null)
  const viewportRefs = useRef<Array<HTMLDivElement | null>>([])
  const paginationRef = useRef<MeasuredPagination>({ pageStartsMm: [0], pageCount: 1, paddingTopPx: 0 })

  const [pageCount, setPageCount] = useState(1)
  const [version, setVersion] = useState(0)
  const [scale, setScale] = useState(1)

  // 测量源只随简历数据变化而重新渲染，避免父组件更新时产生多余的 DOM 变动
  const sourceNode = useMemo(() => <ResumePreview resumeData={resumeData} />, [resumeData])

  // 测量源内容并计算分页；每次测量都递增 version 以刷新各页克隆
  useEffect(() => {
    const source = sourceRef.current?.querySelector<HTMLElement>(".resume-preview")
    if (!source) return
    let frame = 0

    const measure = () => {
      const measured = measurePagination(source)
      paginationRef.current = measured
      setPageCount(measured.pageCount)
      setVersion((v) => v + 1)
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }

    schedule()
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : undefined
    resizeObserver?.observe(source)
    const mutationObserver = typeof MutationObserver !== "undefined" ? new MutationObserver(schedule) : undefined
    mutationObserver?.observe(source, { subtree: true, childList: true, characterData: true, attributes: true })

    return () => {
      cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
    }
  }, [resumeData])

  // 容器宽度不足一页时等比缩小
  useEffect(() => {
    const host = hostRef.current
    if (!host || typeof ResizeObserver === "undefined") return
    const update = () => {
      const available = host.clientWidth
      setScale(available > 0 ? Math.min(1, available / PAGE_WIDTH_PX) : 1)
    }
    const observer = new ResizeObserver(update)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  // 把测量源克隆到每一页的取景窗
  useLayoutEffect(() => {
    const source = sourceRef.current?.querySelector<HTMLElement>(".resume-preview")
    if (!source) return
    const pagination = paginationRef.current
    viewportRefs.current.slice(0, pageCount).forEach((viewport, index) => {
      if (viewport) mountPageClone(viewport, source, pagination, index)
    })
  }, [pageCount, version])

  const stackHeightPx = pageCount * PAGE_HEIGHT_PX + (pageCount - 1) * PAGE_GAP_PX

  return (
    <div ref={hostRef} className={`paginated-preview relative w-full${className ? ` ${className}` : ""}`}>
      {/* 测量源：固定定位移出视口且不可见，屏幕与打印下都不参与版面 */}
      <div ref={sourceRef} className="paginated-source pdf-preview-mode" aria-hidden="true">
        {sourceNode}
      </div>

      <div className="paginated-pages flex justify-center" style={{ height: stackHeightPx * scale }}>
        <div className="paginated-stack" style={{ width: PAGE_WIDTH_PX * scale, height: stackHeightPx * scale }}>
          <div className="paginated-scale" style={{ width: PAGE_WIDTH_PX, transform: `scale(${scale})`, transformOrigin: "top left" }}>
            {Array.from({ length: pageCount }, (_, index) => (
              <div
                key={index}
                className="resume-page relative bg-white shadow-md"
                style={{
                  width: PAGE_WIDTH_PX,
                  height: PAGE_HEIGHT_PX,
                  padding: `${PAGE_MARGIN_PX}px 0`,
                  boxSizing: "border-box",
                  overflow: "hidden",
                  marginBottom: index < pageCount - 1 ? PAGE_GAP_PX : 0,
                }}
              >
                <div
                  ref={(el) => {
                    viewportRefs.current[index] = el
                  }}
                  className="pdf-preview-mode"
                  style={{ height: PAGE_CONTENT_HEIGHT_PX, overflow: "hidden", position: "relative" }}
                />
                <span className="no-print absolute bottom-2 right-4 select-none text-[11px] text-muted-foreground/70">
                  {index + 1} / {pageCount}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
