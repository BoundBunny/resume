import {
  errorResponse,
  jsonResponse,
  pdfResponse,
  readResumeData,
  renderResumePdf,
  safeDecode,
} from "@/lib/pdf-server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 180

interface CacheEntry {
  data: Uint8Array
  expires: number
}

// 进程内短期缓存最近生成的 PDF，供浏览器内置查看器的“下载”按钮再次 GET 时复用。
// 挂到 globalThis 以免 dev/HMR 重载模块时丢失。
declare global {
  var __PDF_CACHE__: Map<string, CacheEntry> | undefined
}
const PDF_CACHE: Map<string, CacheEntry> = globalThis.__PDF_CACHE__ ?? (globalThis.__PDF_CACHE__ = new Map())

const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX_ENTRIES = 50
const TOKEN_COOKIE = "pdfToken"

/** 清理过期条目并限制总量，避免长期运行时内存无限增长 */
function pruneCache(now = Date.now()) {
  for (const [key, entry] of PDF_CACHE) {
    if (entry.expires <= now) PDF_CACHE.delete(key)
  }
  while (PDF_CACHE.size > CACHE_MAX_ENTRIES) {
    const oldest = PDF_CACHE.keys().next().value
    if (oldest === undefined) break
    PDF_CACHE.delete(oldest)
  }
}

function tokenCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""
  return `${TOKEN_COOKIE}=${token}; Path=/api/pdf; Max-Age=${CACHE_TTL_MS / 1000}; HttpOnly; SameSite=Lax${secure}`
}

function tokenFromCookie(req: Request): string | null {
  const cookie = req.headers.get("cookie") || ""
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${TOKEN_COOKIE}=([^;]+)`))
  return match ? safeDecode(match[1]) : null
}

type RouteContext = { params: Promise<{ filename: string }> | { filename: string } }

async function filenameFrom(ctx: RouteContext): Promise<string> {
  const params = await Promise.resolve(ctx.params)
  return safeDecode(params.filename || "resume.pdf")
}

/** 生成 PDF 并缓存，然后 303 到携带 token 的 GET 地址，便于内联预览与下载复用同一 URL */
export async function POST(req: Request, ctx: RouteContext) {
  try {
    const resumeData = await readResumeData(req)
    if (!resumeData) return jsonResponse({ error: "Missing resumeData" }, 400)

    const pdf = await renderResumePdf(req, resumeData)
    const filename = await filenameFrom(ctx)

    const token = crypto.randomUUID().replace(/-/g, "")
    pruneCache()
    PDF_CACHE.set(token, { data: pdf, expires: Date.now() + CACHE_TTL_MS })

    // 使用相对地址重定向，不依赖请求头中的 Host
    const location = `/api/pdf/${encodeURIComponent(filename)}?token=${encodeURIComponent(token)}`
    return new Response(null, {
      status: 303,
      headers: {
        Location: location,
        "set-cookie": tokenCookie(token),
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

/** 读取缓存的 PDF；缓存失效时返回 404 提示重新生成 */
export async function GET(req: Request, ctx: RouteContext) {
  try {
    const url = new URL(req.url)
    const token = url.searchParams.get("token") || tokenFromCookie(req)
    const cached = token ? PDF_CACHE.get(token) : undefined

    if (!cached || cached.expires <= Date.now()) {
      if (token) PDF_CACHE.delete(token)
      return jsonResponse({ error: "PDF cache expired. Please regenerate." }, 404)
    }

    return pdfResponse(cached.data, await filenameFrom(ctx))
  } catch (error) {
    return errorResponse(error)
  }
}
