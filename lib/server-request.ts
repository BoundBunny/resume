/**
 * 服务端远程抓取的安全工具，用于约束由用户数据驱动的网络请求，避免 SSRF。
 * 同时被 Edge 运行时（图片代理）与 Node 运行时（PDF 路由）使用，因此不依赖 node: 内置模块。
 */

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/,
  /\.localhost$/,
  /^127(\.\d{1,3}){3}$/,
  /^0(\.\d{1,3}){3}$/,
  /^10(\.\d{1,3}){3}$/,
  /^192\.168(\.\d{1,3}){2}$/,
  /^169\.254(\.\d{1,3}){2}$/,
  /^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/,
  // 100.64.0.0/10（运营商级 NAT）
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])(\.\d{1,3}){2}$/,
  /^::1$/,
  /^::$/,
  // fc00::/7 私有地址，fe80::/10 链路本地，::ffff: IPv4 映射地址一律拒绝
  /^f[cd][0-9a-f]{2}:/,
  /^fe[89ab][0-9a-f]:/,
  /^::ffff:/,
  /^metadata(\.|$)/,
  /\.internal$/,
  /\.local$/,
]

export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
}

/** 是否为本机回环地址（本地开发时允许无头浏览器访问自身） */
export function isLoopbackHostname(hostname: string): boolean {
  const h = normalizeHostname(hostname)
  return h === "localhost" || h.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(h) || h === "::1"
}

/** 是否为内网、回环、链路本地或云元数据等不应由服务端代为访问的地址 */
export function isPrivateHostname(hostname: string): boolean {
  const h = normalizeHostname(hostname)
  if (!h) return true
  return PRIVATE_HOST_PATTERNS.some((re) => re.test(h))
}

/** 解析一个允许服务端访问的公网 http(s) 地址；协议不符、携带凭据或指向内网时返回 null */
export function parsePublicHttpUrl(raw: string | null | undefined): URL | null {
  if (!raw || typeof raw !== "string") return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (url.username || url.password) return null
  if (isPrivateHostname(url.hostname)) return null
  return url
}

export interface RemoteResource {
  bytes: Uint8Array<ArrayBuffer>
  contentType: string
}

export interface FetchRemoteOptions {
  /** 响应体上限，默认 8MB */
  maxBytes?: number
  /** 单次请求超时，默认 8 秒 */
  timeoutMs?: number
  /** 最多跟随的重定向次数，默认 3；每一跳都会重新做地址校验 */
  maxRedirects?: number
  /** 仅接受匹配的 Content-Type，例如 /^image\// */
  allowedContentType?: RegExp
}

/**
 * 安全地抓取远程资源：只允许公网 http(s)，手动处理重定向并逐跳校验，限制体积与超时。
 * 任何不满足条件的情况都返回 null，而不是抛错，便于调用方降级。
 */
export async function fetchRemoteResource(
  raw: string,
  options: FetchRemoteOptions = {}
): Promise<RemoteResource | null> {
  const {
    maxBytes = 8 * 1024 * 1024,
    timeoutMs = 8000,
    maxRedirects = 3,
    allowedContentType,
  } = options

  let current = parsePublicHttpUrl(raw)
  if (!current) return null

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(current.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; ResumeExporter/1.0)",
          accept: "image/avif,image/webp,image/apng,image/*;q=0.8,*/*;q=0.5",
        },
      })

      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined)
        const location = res.headers.get("location")
        if (!location) return null
        let nextUrl: URL
        try {
          nextUrl = new URL(location, current)
        } catch {
          return null
        }
        const safeNext = parsePublicHttpUrl(nextUrl.toString())
        if (!safeNext) return null
        current = safeNext
        continue
      }

      if (!res.ok || !res.body) return null

      const contentType = (res.headers.get("content-type") || "application/octet-stream")
        .split(";")[0]
        .trim()
        .toLowerCase()
      if (allowedContentType && !allowedContentType.test(contentType)) {
        await res.body.cancel().catch(() => undefined)
        return null
      }

      const declared = Number(res.headers.get("content-length") || "0")
      if (declared > maxBytes) {
        await res.body.cancel().catch(() => undefined)
        return null
      }

      const bytes = await readBodyWithLimit(res.body, maxBytes)
      if (!bytes) return null
      return { bytes, contentType }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

async function readBodyWithLimit(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

export function toDataUrl(resource: RemoteResource): string {
  return `data:${resource.contentType};base64,${bytesToBase64(resource.bytes)}`
}
