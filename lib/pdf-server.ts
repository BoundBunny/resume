/**
 * 服务端 PDF 生成的共用实现，供 /api/pdf、/api/pdf/[filename] 与 /api/pdf/health 复用。
 * 仅在 Node.js 运行时使用。
 */
import type { Browser, Page } from "puppeteer-core"
import { existsSync } from "node:fs"
import type { ResumeData } from "@/types/resume"
import { AUTH_COOKIE, authCookieValue, getSitePassword } from "@/lib/auth"
import {
  fetchRemoteResource,
  isLoopbackHostname,
  isPrivateHostname,
  parsePublicHttpUrl,
  toDataUrl,
} from "@/lib/server-request"

export class PdfError extends Error {
  status: number
  constructor(message: string, status = 500) {
    super(message)
    this.name = "PdfError"
    this.status = status
  }
}

/** 请求体文本上限，防止超大 JSON 拖垮进程 */
const MAX_BODY_CHARS = 2 * 1024 * 1024
/** 同时运行的无头浏览器数量上限，可用 PDF_MAX_CONCURRENT 覆盖 */
const MAX_CONCURRENT = Math.max(1, Number(process.env.PDF_MAX_CONCURRENT) || 2)
/** 等待队列长度上限，可用 PDF_MAX_QUEUE 覆盖；超出直接返回 503 */
const MAX_QUEUE = Math.max(0, Number(process.env.PDF_MAX_QUEUE) || 8)
const QUEUE_TIMEOUT_MS = 30_000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function jsonResponse(payload: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  })
}

export function errorResponse(error: unknown): Response {
  if (error instanceof PdfError) return jsonResponse({ error: error.message }, error.status)
  const message = error instanceof Error ? error.message : String(error)
  return jsonResponse({ error: message }, 500)
}

// ---------------------------------------------------------------------------
// 请求体解析
// ---------------------------------------------------------------------------

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function assertBodySize(text: string) {
  if (text.length > MAX_BODY_CHARS) throw new PdfError("简历数据过大，无法生成 PDF", 413)
}

/** 只做结构校验，不校验业务规则，避免编辑中途的空标签等情况阻断导出 */
function isResumeData(value: unknown): value is ResumeData {
  if (!value || typeof value !== "object") return false
  const v = value as Partial<ResumeData>
  if (typeof v.title !== "string") return false
  if (!v.personalInfoSection || !Array.isArray(v.personalInfoSection.personalInfo)) return false
  if (!Array.isArray(v.modules)) return false
  return true
}

/** 兼容三种提交方式：application/json、text/plain(JSON 字符串)、表单字段 resumeData */
export async function readResumeData(req: Request): Promise<ResumeData | null> {
  const ct = (req.headers.get("content-type") || "").toLowerCase()
  let raw: unknown = null

  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null)
    const val = form?.get("resumeData")
    const text = typeof val === "string" ? val : val instanceof Blob ? await val.text() : ""
    assertBodySize(text)
    raw = text ? safeJsonParse(text) : null
  } else {
    const text = await req.text().catch(() => "")
    assertBodySize(text)
    const parsed = text ? safeJsonParse(text) : null
    raw =
      parsed && typeof parsed === "object" && "resumeData" in (parsed as Record<string, unknown>)
        ? (parsed as { resumeData: unknown }).resumeData
        : parsed
  }

  return isResumeData(raw) ? raw : null
}

// ---------------------------------------------------------------------------
// 站点地址解析
// ---------------------------------------------------------------------------

function normalizeOrigin(value: string): string {
  const withProto = /^https?:\/\//i.test(value) ? value : `https://${value}`
  return new URL(withProto).origin
}

/**
 * 解析无头浏览器应访问的站点地址。
 * 优先使用显式配置（SITE_URL / NEXT_PUBLIC_SITE_URL），其次使用 Vercel 注入的地址；
 * 都没有时退回请求自身的 origin，但拒绝指向内网或云元数据的 Host，防止被伪造请求头利用。
 */
export function resolveTrustedOrigin(req: Request): string {
  const configured = (process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "").trim()
  if (configured) return normalizeOrigin(configured)

  const vercel = (process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "").trim()
  if (vercel) return normalizeOrigin(vercel)

  let origin = ""
  try {
    origin = new URL(req.url).origin
  } catch {
    /* fall through */
  }
  if (!origin) {
    const proto = (req.headers.get("x-forwarded-proto") || "http").split(",")[0].trim()
    const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim()
    if (host) origin = `${proto}://${host}`
  }
  if (!origin) throw new PdfError("无法解析站点地址，请配置 SITE_URL 环境变量", 400)

  const hostname = new URL(origin).hostname
  if (isPrivateHostname(hostname) && !isLoopbackHostname(hostname)) {
    throw new PdfError("站点地址不合法，请配置 SITE_URL 环境变量", 400)
  }
  return origin
}

// ---------------------------------------------------------------------------
// 浏览器启动与渲染
// ---------------------------------------------------------------------------

/** 按平台列出常见的 Chrome / Edge / Chromium 安装位置 */
function systemChromeCandidates(): string[] {
  if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(
      (v): v is string => !!v
    )
    return roots.flatMap((root) => [
      `${root}\\Google\\Chrome\\Application\\chrome.exe`,
      `${root}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${root}\\Chromium\\Application\\chrome.exe`,
    ])
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/snap/bin/chromium",
  ]
}

interface ResolvedBrowser {
  executablePath: string
  bundled: boolean
}

/**
 * 解析可用的浏览器：
 * 1. 环境变量 PUPPETEER_EXECUTABLE_PATH / CHROME_PATH 显式指定；
 * 2. Linux 上优先使用 @sparticuz/chromium 内置的 headless shell（Serverless 场景）；
 * 3. 其他平台（或内置不可用时）自动探测本机安装的 Chrome / Edge。
 */
async function resolveBrowser(chromium: typeof import("@sparticuz/chromium").default): Promise<ResolvedBrowser> {
  const envPath = (process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || "").trim()
  if (envPath) return { executablePath: envPath, bundled: false }

  if (process.platform === "linux") {
    try {
      const bundledPath = await chromium.executablePath()
      if (bundledPath && existsSync(bundledPath)) return { executablePath: bundledPath, bundled: true }
    } catch {
      /* 内置二进制不可用，继续探测系统浏览器 */
    }
  }

  const found = systemChromeCandidates().find((candidate) => existsSync(candidate))
  if (found) return { executablePath: found, bundled: false }

  throw new PdfError(
    "未找到可用的 Chrome / Edge。请安装 Chrome，或通过 PUPPETEER_EXECUTABLE_PATH 指定浏览器路径",
    503
  )
}

export async function launchBrowser(): Promise<Browser> {
  const [{ default: chromium }, { default: puppeteer }] = await Promise.all([
    import("@sparticuz/chromium"),
    import("puppeteer-core"),
  ])

  const { executablePath, bundled } = await resolveBrowser(chromium)
  return puppeteer.launch({
    args: bundled
      ? chromium.args
      : ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
    defaultViewport: { width: 1200, height: 1600, deviceScaleFactor: 2 },
    executablePath,
    // 内置二进制是 chrome-headless-shell，args 中已带 --headless='shell'；系统浏览器使用新版无头模式
    headless: bundled ? "shell" : true,
  })
}

/** 远程头像内联为 data URL；不安全的地址直接丢弃，避免无头浏览器替攻击者访问内网 */
async function inlineAvatar(avatar: string): Promise<string | undefined> {
  if (/^data:/i.test(avatar)) return avatar
  if (/^blob:/i.test(avatar)) return undefined
  if (!/^https?:\/\//i.test(avatar)) return avatar // 站内相对路径，由页面自行加载

  if (!parsePublicHttpUrl(avatar)) return undefined
  const resource = await fetchRemoteResource(avatar, { allowedContentType: /^image\// })
  return resource ? toDataUrl(resource) : avatar
}

async function waitForResumeReady(page: Page) {
  // /print 页按 A4 分页卡片渲染；优先等待卡片填充完成，退而求其次等待任意简历内容
  try {
    await page.waitForSelector(".resume-page .resume-content", { timeout: 20_000 })
  } catch {
    try {
      await page.waitForSelector(".resume-content", { timeout: 5_000 })
    } catch {
      await sleep(500)
    }
  }
  try {
    await page.waitForNetworkIdle({ idleTime: 300, timeout: 10_000 })
  } catch {
    await sleep(300)
  }
  try {
    await page.waitForFunction(
      () => {
        const root = document.querySelector(".resume-page .resume-content") ?? document.querySelector(".resume-content")
        if (!root) return false
        return !!root.querySelector(".ProseMirror, .resume-module p, .resume-module li, .resume-module a, .resume-module span")
      },
      { timeout: 30_000 }
    )
  } catch {
    /* 没有富文本内容时允许继续 */
  }
  try {
    await page.evaluate(async () => {
      await document.fonts.ready
    })
  } catch {
    /* 字体就绪失败不影响输出 */
  }
  // 字体就绪后分页可能重新测量，留一帧让卡片刷新
  await sleep(150)
}

async function printWithRetry(page: Page): Promise<Uint8Array> {
  const print = () =>
    page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: false,
      // 让 @page 规则生效，页边距由样式表统一控制
      preferCSSPageSize: true,
    })
  try {
    return await print()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/Target closed|Execution context was destroyed/i.test(msg)) throw e
    await sleep(300)
    return await print()
  }
}

/** 渲染简历为 PDF 字节；内部受并发槽位保护，浏览器实例保证关闭 */
export async function renderResumePdf(req: Request, resumeData: ResumeData): Promise<Uint8Array> {
  const origin = resolveTrustedOrigin(req)

  return withPdfSlot(async () => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()

      const password = getSitePassword()
      if (password) {
        await page.setCookie({
          name: AUTH_COOKIE,
          value: await authCookieValue(password),
          url: origin,
          path: "/",
        })
      }

      const prepared: ResumeData = { ...resumeData }
      if (prepared.avatar) prepared.avatar = await inlineAvatar(prepared.avatar)

      // 在页面脚本执行前写入 sessionStorage，避免超长 URL 触发 431
      await page.evaluateOnNewDocument((data: ResumeData) => {
        try {
          window.sessionStorage.setItem("resumeData", JSON.stringify(data))
        } catch {
          /* ignore */
        }
      }, prepared)

      await page.emulateMediaType("print")
      await page.goto(`${origin}/print`, { waitUntil: "domcontentloaded", timeout: 60_000 })
      await waitForResumeReady(page)
      return await printWithRetry(page)
    } finally {
      await browser.close().catch(() => undefined)
    }
  })
}

// ---------------------------------------------------------------------------
// 并发控制
// ---------------------------------------------------------------------------

interface Waiter {
  resolve: () => void
  reject: (e: Error) => void
}

let active = 0
const waiters: Waiter[] = []

async function withPdfSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    if (waiters.length >= MAX_QUEUE) throw new PdfError("服务器繁忙，请稍后重试", 503)
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject,
      }
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter)
        if (idx >= 0) waiters.splice(idx, 1)
        reject(new PdfError("排队等待超时，请稍后重试", 503))
      }, QUEUE_TIMEOUT_MS)
      waiters.push(waiter)
    })
  }

  active++
  try {
    return await task()
  } finally {
    active--
    waiters.shift()?.resolve()
  }
}

// ---------------------------------------------------------------------------
// 响应头辅助
// ---------------------------------------------------------------------------

/** 以 PDF 形式返回字节；拷贝到独立 ArrayBuffer 以满足 BodyInit 类型 */
export function pdfResponse(pdf: Uint8Array, filename: string, extraHeaders?: Record<string, string>): Response {
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": contentDisposition(filename),
      "cache-control": "no-store",
      ...extraHeaders,
    },
  })
}

/** 生成同时兼容旧浏览器与非 ASCII 文件名的 Content-Disposition */
export function contentDisposition(filename: string): string {
  const cleaned = filename.replace(/[\r\n"\\/]/g, "_")
  const asciiFallback = cleaned.replace(/[^\x20-\x7E]/g, "_")
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(cleaned)}`
}

/** 对路径参数做一次安全解码；遇到非法转义串时原样返回 */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
