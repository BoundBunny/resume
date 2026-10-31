/**
 * 口令保护共用工具。
 * 同时被 Edge（proxy）与 Node（API 路由）运行时使用，因此只依赖 Web Crypto，不依赖 node: 模块。
 */

export const AUTH_COOKIE = "site_auth"

/** 读取配置的访问口令；为空表示未启用口令保护 */
export function getSitePassword(): string {
  return (process.env.SITE_PASSWORD ?? "").trim()
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** 认证 Cookie 的值：口令的 SHA-256 摘要，与中间件校验保持一致 */
export function authCookieValue(password: string): Promise<string> {
  return sha256Hex(password)
}

/** 校验请求携带的认证 Cookie；未配置口令时直接放行 */
export async function isAuthorizedCookie(cookieValue: string | null | undefined): Promise<boolean> {
  const password = getSitePassword()
  if (!password) return true
  if (!cookieValue) return false
  const expected = await authCookieValue(password)
  return constantTimeEqual(cookieValue, expected)
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
