/**
 * A4 分页模型与测量工具。
 *
 * 版面几何：每页四周统一留 10mm 边距（打印时 `@page { margin: 10mm }`，
 * 屏幕预览时由页面卡片的内边距提供），因此每页可放 297 - 20 = 277mm 的内容，
 * 内容区宽度 190mm。该模型被预览页的分页卡片和图片导出的按页切分共用。
 */

export const MM_TO_PX = 96 / 25.4
export const PAGE_WIDTH_MM = 210
export const PAGE_HEIGHT_MM = 297
/** 每页四周的留白 */
export const PAGE_MARGIN_MM = 10
/** 每页可容纳的内容高度 */
export const PAGE_CONTENT_HEIGHT_MM = PAGE_HEIGHT_MM - PAGE_MARGIN_MM * 2

export interface PaginationBlock {
  /** 模块顶部相对内容流起点的距离 */
  topMm: number
  /** 模块底部相对内容流起点的距离 */
  bottomMm: number
  /** 该模块是否要求从新的一页开始 */
  pageBreakBefore?: boolean
  /** 该模块是否要求不跨页拆分 */
  keepTogether?: boolean
}

export interface PageLayout {
  /** 每一页的起始位置（内容流坐标，mm）。第 1 页固定为 0 */
  pageStartsMm: number[]
  pageCount: number
}

/**
 * 计算分页：先按整页高度推进，再根据模块上的分页开关插入分页点。
 */
export function computePageLayout(blocks: PaginationBlock[], flowHeightMm: number): PageLayout {
  const pageStartsMm: number[] = [0]

  const currentStart = () => pageStartsMm[pageStartsMm.length - 1]
  const currentLimit = () => currentStart() + PAGE_CONTENT_HEIGHT_MM
  const advance = () => pageStartsMm.push(currentLimit())

  for (const block of blocks) {
    // 模块起点已超出当前页时，按整页推进
    let guard = 0
    while (block.topMm > currentLimit() + 0.5 && guard++ < 200) advance()

    // 模块正好落在页首时不重复分页
    if (block.topMm - currentStart() <= 1) continue

    const overflows = block.bottomMm > currentLimit() + 0.5
    if (block.pageBreakBefore || (block.keepTogether && overflows)) {
      pageStartsMm.push(block.topMm)
    }
  }

  // 内容超出最后一页时继续分页
  let tailGuard = 0
  while (flowHeightMm > currentLimit() + 0.5 && tailGuard++ < 200) advance()

  return { pageStartsMm, pageCount: pageStartsMm.length }
}

export interface MeasuredPagination extends PageLayout {
  /** 预览容器顶部内边距，用于把内容流坐标换算回元素坐标 */
  paddingTopPx: number
}

/**
 * 测量预览元素内的模块位置并计算分页结果。
 * @param previewEl 简历预览根元素（.resume-preview）
 */
export function measurePagination(previewEl: HTMLElement): MeasuredPagination {
  const style = getComputedStyle(previewEl)
  const paddingTopPx = parseFloat(style.paddingTop) || 0
  const rect = previewEl.getBoundingClientRect()
  const flowTop = rect.top + paddingTopPx

  const blocks: PaginationBlock[] = Array.from(
    previewEl.querySelectorAll<HTMLElement>(".resume-module")
  ).map((el) => {
    const blockRect = el.getBoundingClientRect()
    return {
      topMm: (blockRect.top - flowTop) / MM_TO_PX,
      bottomMm: (blockRect.bottom - flowTop) / MM_TO_PX,
      pageBreakBefore: el.dataset.pageBreakBefore === "1",
      keepTogether: el.dataset.keepTogether === "1",
    }
  })

  // 内容高度取实际内容底部，忽略预览卡片自身的 min-height
  let contentBottom = flowTop
  for (const child of Array.from(previewEl.children)) {
    const childRect = (child as HTMLElement).getBoundingClientRect()
    if (childRect.bottom > contentBottom) contentBottom = childRect.bottom
  }
  const flowHeightMm = Math.max(0, (contentBottom - flowTop) / MM_TO_PX)

  return { ...computePageLayout(blocks, flowHeightMm), paddingTopPx }
}

/**
 * 第 pageIndex 页实际可见的内容高度：默认一整页，
 * 但若下一页因"从新一页开始"或"不跨页拆分"而提前开始，则只显示到下一页起点，避免内容在两页重复出现。
 */
export function pageVisibleHeightMm(layout: PageLayout, pageIndex: number): number {
  const start = layout.pageStartsMm[pageIndex] ?? 0
  const next = layout.pageStartsMm[pageIndex + 1]
  if (next === undefined) return PAGE_CONTENT_HEIGHT_MM
  return Math.max(0, Math.min(PAGE_CONTENT_HEIGHT_MM, next - start))
}

/**
 * 把整份简历的克隆节点放进某一页的取景窗：克隆向上平移到该页起点，取景窗裁掉其余部分。
 * 预览卡片与图片导出共用，保证两者切分位置一致。
 */
export function mountPageClone(
  viewport: HTMLElement,
  source: HTMLElement,
  pagination: MeasuredPagination,
  pageIndex: number
) {
  const clone = source.cloneNode(true) as HTMLElement
  clone.style.margin = "0"
  clone.style.boxShadow = "none"
  clone.style.minHeight = "0"
  clone.style.transformOrigin = "top left"
  const startMm = pagination.pageStartsMm[pageIndex] ?? 0
  clone.style.transform = `translateY(${-(pagination.paddingTopPx + startMm * MM_TO_PX)}px)`
  clone.setAttribute("aria-hidden", "true")
  viewport.style.height = `${pageVisibleHeightMm(pagination, pageIndex) * MM_TO_PX}px`
  viewport.style.overflow = "hidden"
  viewport.replaceChildren(clone)
}
