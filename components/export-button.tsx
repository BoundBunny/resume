"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@iconify/react";
import type { ResumeData } from "@/types/resume";
import { generatePdfFilename, exportToMagicyanFile, downloadFile, cn } from "@/lib/utils";
import {
  MM_TO_PX,
  PAGE_CONTENT_HEIGHT_MM,
  PAGE_HEIGHT_MM,
  PAGE_MARGIN_MM,
  measurePagination,
  mountPageClone,
  type MeasuredPagination,
} from "@/lib/pagination";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { createZip, type ZipEntry } from "@/lib/zip";
import type { Options as HtmlToImageOptions } from "html-to-image/lib/types";

type ImageFormat = "png" | "jpg" | "webp" | "svg";

interface ExportButtonProps {
  resumeData: ResumeData;
  variant?: "default" | "outline" | "ghost" | "destructive" | "secondary" | "link";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
  showImageOptions?: boolean; // 在没有预览面板时可关闭图片导出
}

// 1x1 透明像素：图片加载失败时占位，避免抛错
const IMAGE_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIABAP///wAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

/**
 * 移出视口但保持正常渲染。注意不能用 opacity/visibility 隐藏：
 * html-to-image 会把这些样式一起复制进输出，导致导出图片是空白的。
 */
function hideOffscreen(el: HTMLElement) {
  el.style.position = "fixed";
  el.style.left = "-10000px";
  el.style.top = "0";
  el.style.pointerEvents = "none";
}

export function ExportButton({
  resumeData,
  variant = "default",
  size = "default",
  className,
  showImageOptions = true,
}: ExportButtonProps) {
  const [isExporting, setIsExporting] = useState(false);
  const { toast } = useToast();

  /**
   * 总是离屏渲染一份 A4 版面（.pdf-preview-mode）用于导出，
   * 保证无论从哪个页面触发，图片几何都与 PDF 一致。
   */
  const renderOffscreenPreview = async (): Promise<{ sourceEl: HTMLElement; cleanup: () => void }> => {
    const host = document.createElement("div");
    hideOffscreen(host);
    host.className = "pdf-preview-mode";
    document.body.appendChild(host);

    const [{ createRoot }, { default: ResumePreview }] = await Promise.all([
      import("react-dom/client"),
      import("./resume-preview"),
    ]);

    const root = createRoot(host);
    root.render(React.createElement(ResumePreview, { resumeData }));

    // 等待渲染与布局生效
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
    const source = host.querySelector<HTMLElement>(".resume-preview");
    if (!source) {
      root.unmount();
      host.remove();
      throw new Error("无法生成预览内容用于导出");
    }

    const cleanup = () => {
      try { root.unmount(); } catch { }
      host.remove();
    };
    return { sourceEl: source, cleanup };
  };

  /** 克隆到离屏容器，并把跨域图片改为同源代理加载，避免画布污染 */
  async function prepareNodeForExport(source: HTMLElement): Promise<{ nodeForExport: HTMLElement; cleanup: () => void }> {
    const clone = source.cloneNode(true) as HTMLElement;
    const container = document.createElement("div");
    hideOffscreen(container);
    // 与源节点保持相同的 A4 样式上下文，避免克隆后内边距变化导致重排
    container.className = "pdf-preview-mode";
    const rect = source.getBoundingClientRect();
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.margin = "0";
    container.appendChild(clone);
    document.body.appendChild(container);

    const imgs = Array.from(clone.querySelectorAll<HTMLImageElement>("img"));
    const sameOrigin = (url: string) => {
      try {
        return new URL(url, window.location.href).origin === window.location.origin;
      } catch { return true; }
    };
    for (const img of imgs) {
      const src = img.getAttribute("src") || "";
      if (!src || src.startsWith("data:") || src.startsWith("blob:")) continue;
      if (!/^https?:\/\//i.test(src) || sameOrigin(src)) continue;
      img.setAttribute("src", `/api/image-proxy?url=${encodeURIComponent(src)}`);
      img.removeAttribute("crossorigin");
    }
    await waitForImages(imgs, 5000);

    return { nodeForExport: clone, cleanup: () => container.remove() };
  }

  function waitForImages(images: HTMLImageElement[], timeout = 5000) {
    const pending = images.filter((img) => !img.complete || img.naturalWidth === 0);
    if (pending.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const t = window.setTimeout(finish, timeout);
      let remaining = pending.length;
      const onLoad = () => {
        remaining -= 1;
        if (remaining <= 0) { window.clearTimeout(t); finish(); }
      };
      for (const img of pending) {
        img.addEventListener("load", onLoad, { once: true });
        img.addEventListener("error", onLoad, { once: true });
      }
    });
  }

  /**
   * 构造第 pageIndex 页的“取景窗”：A4 大小、四周 10mm 留白的白色页面，
   * 内部取景区裁出该页内容。与预览卡片使用同一套切分逻辑。
   *
   * 注意分两层：外层 holder 负责移出视口，内层 pageWindow 不带任何定位样式，
   * 只截取 pageWindow。html-to-image 会复制被截节点的计算样式，若直接截带有
   * position: fixed / left: -10000px 的节点，内容会被画到画布之外，得到空白图片。
   */
  function buildPageWindow(nodeForExport: HTMLElement, pagination: MeasuredPagination, pageIndex: number) {
    const holder = document.createElement("div");
    hideOffscreen(holder);
    holder.className = "pdf-preview-mode";

    const pageWindow = document.createElement("div");
    pageWindow.style.width = `${nodeForExport.getBoundingClientRect().width}px`;
    pageWindow.style.height = `${PAGE_HEIGHT_MM * MM_TO_PX}px`;
    pageWindow.style.padding = `${PAGE_MARGIN_MM * MM_TO_PX}px 0`;
    pageWindow.style.boxSizing = "border-box";
    pageWindow.style.overflow = "hidden";
    pageWindow.style.background = "#ffffff";

    const viewport = document.createElement("div");
    viewport.style.height = `${PAGE_CONTENT_HEIGHT_MM * MM_TO_PX}px`;
    viewport.style.overflow = "hidden";
    viewport.style.position = "relative";
    pageWindow.appendChild(viewport);
    holder.appendChild(pageWindow);
    document.body.appendChild(holder);

    mountPageClone(viewport, nodeForExport, pagination, pageIndex);

    return { pageWindow, cleanup: () => holder.remove() };
  }

  async function convertBlobToFormat(blob: Blob, mime: string): Promise<string | null> {
    try {
      if (!("createImageBitmap" in window)) return null;
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bmp, 0, 0);
      const dataUrl = canvas.toDataURL(mime);
      try { bmp.close(); } catch { }
      return dataUrl && dataUrl.startsWith("data:") ? dataUrl : null;
    } catch {
      return null;
    }
  }

  async function renderPageImage(
    htmlToImage: typeof import("html-to-image"),
    node: HTMLElement,
    format: ImageFormat
  ): Promise<string> {
    const options: HtmlToImageOptions = {
      quality: format === "jpg" ? 0.95 : 1,
      pixelRatio: 2,
      backgroundColor: "#ffffff",
      cacheBust: true,
      imagePlaceholder: IMAGE_PLACEHOLDER,
      // 关闭字体内嵌，避免 html-to-image 解析字体时对 undefined 调用 trim 抛错
      skipFonts: true,
    };
    switch (format) {
      case "png":
        return htmlToImage.toPng(node, options);
      case "jpg":
        return htmlToImage.toJpeg(node, options);
      case "svg":
        return htmlToImage.toSvg(node, options);
      case "webp": {
        // html-to-image 没有 toWebp：先生成位图，再用 canvas 转码；不支持时退回原始类型
        const blob = await htmlToImage.toBlob(node, options);
        if (!blob) throw new Error("生成 WEBP 失败");
        return (await convertBlobToFormat(blob, "image/webp")) ?? URL.createObjectURL(blob);
      }
    }
  }

  function triggerDownload(url: string, filename: string) {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    if (url.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function urlToBytes(url: string): Promise<Uint8Array> {
    const blob = await (await fetch(url)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    return bytes;
  }

  /**
   * 图片导出：与 PDF 使用同一套分页模型。
   * 单页直接下载；多页时打包为一个 ZIP，避免浏览器拦截连续触发的多个下载。
   */
  const exportAsImage = async (format: ImageFormat) => {
    setIsExporting(true);
    try {
      const { sourceEl, cleanup: cleanupPreview } = await renderOffscreenPreview();
      let pageCount = 1;
      try {
        const { nodeForExport, cleanup: cleanupClone } = await prepareNodeForExport(sourceEl);
        try {
          const pagination = measurePagination(nodeForExport);
          pageCount = pagination.pageCount;
          const htmlToImage = await import("html-to-image");
          const baseName = generatePdfFilename(resumeData.title).replace(/\.pdf$/i, "");

          const pageUrls: string[] = [];
          for (let i = 0; i < pageCount; i++) {
            const { pageWindow, cleanup: cleanupWindow } = buildPageWindow(nodeForExport, pagination, i);
            try {
              pageUrls.push(await renderPageImage(htmlToImage, pageWindow, format));
            } finally {
              cleanupWindow();
            }
          }

          if (pageUrls.length === 1) {
            triggerDownload(pageUrls[0], `${baseName}.${format}`);
          } else {
            const entries: ZipEntry[] = [];
            for (let i = 0; i < pageUrls.length; i++) {
              entries.push({ name: `${baseName}-P${i + 1}.${format}`, data: await urlToBytes(pageUrls[i]) });
            }
            triggerDownload(URL.createObjectURL(createZip(entries)), `${baseName}.zip`);
          }
        } finally {
          cleanupClone();
        }
      } finally {
        cleanupPreview();
      }

      toast({
        title: "导出成功",
        description:
          pageCount > 1
            ? `简历共 ${pageCount} 页，已按页导出为 ${format.toUpperCase()} 并打包为 ZIP（P1 到 P${pageCount}）`
            : `简历已导出为 ${format.toUpperCase()} 格式`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e || {});
      console.error("导出图片失败:", msg);
      toast({
        title: "导出失败",
        description: `导出图片时发生错误：${msg}`,
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const exportAsPDF = () => {
    const filename = generatePdfFilename(resumeData.title || "");
    const childWindow = window.open(`/pdf/preview/${filename}`, '_blank');
    if (!childWindow) {
      console.error('Failed to open popup window');
      toast({
        title: "导出失败",
        description: "无法打开 PDF 预览窗口，请检查浏览器弹窗设置",
        variant: "destructive",
      });
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      // 只接受同源预览窗口的握手消息
      if (event.origin !== window.location.origin) return;
      if (event.source === childWindow && event.data?.type === 'ready') {
        childWindow.postMessage({ type: 'resumeData', data: resumeData }, window.location.origin);
        window.removeEventListener('message', handleMessage);
      }
    };

    window.addEventListener('message', handleMessage);

    // 设置超时，如果子窗口没有准备好
    setTimeout(() => {
      window.removeEventListener('message', handleMessage);
    }, 5000); // 5秒超时
  };

  const exportAsJSON = () => {
    try {
      const fileContent = exportToMagicyanFile(resumeData);
      const filename = generatePdfFilename(resumeData.title || "").replace(".pdf", ".json");
      downloadFile(fileContent, filename, "application/json");
      toast({
        title: "导出成功",
        description: `简历已导出为 JSON 格式`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e || {});
      console.error("导出 JSON 失败:", msg);
      toast({
        title: "导出失败",
        description: `导出 JSON 时发生错误：${msg}`,
        variant: "destructive",
      });
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={variant}
          size={size}
          disabled={isExporting}
          className={cn(
            "gap-2",
            className,
            variant === "default" ? "bg-green-600 hover:bg-green-700 text-white" : undefined
          )}
        >
          <Icon icon="mdi:download" className="w-4 h-4" />
          {isExporting ? "导出中..." : "导出"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={exportAsPDF}>
          <Icon icon="mdi:file-pdf-box" className="w-4 h-4 mr-2" />
          PDF 格式
        </DropdownMenuItem>
        <DropdownMenuItem onClick={exportAsJSON}>
          <Icon icon="mdi:code-json" className="w-4 h-4 mr-2" />
          JSON 格式
        </DropdownMenuItem>
        {showImageOptions && (
          <>
            <DropdownMenuItem onClick={() => exportAsImage("png")}>
              <Icon icon="mdi:file-image" className="w-4 h-4 mr-2" />
              PNG 格式
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => exportAsImage("jpg")}>
              <Icon icon="mdi:file-jpg-box" className="w-4 h-4 mr-2" />
              JPG 格式
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => exportAsImage("webp")}>
              <Icon icon="mdi:file-image" className="w-4 h-4 mr-2" />
              WEBP 格式
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => exportAsImage("svg")}>
              <Icon icon="mdi:svg" className="w-4 h-4 mr-2" />
              SVG 格式
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default ExportButton;
