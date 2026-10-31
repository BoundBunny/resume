import { NextRequest, NextResponse } from "next/server"
import { AUTH_COOKIE, authCookieValue, getSitePassword, sha256Hex } from "@/lib/auth"

/** 只允许站内相对路径，排除 //host 与 /\host 这类协议相对地址，防止开放重定向 */
function safeRedirectTarget(from: string): string {
  if (!/^\/(?![/\\])/.test(from)) return "/"
  if (from === "/auth" || from.startsWith("/auth?")) return "/"
  return from
}

export async function POST(req: NextRequest) {
  const password = getSitePassword()

  // 未配置口令时无需认证，直接回首页
  if (!password) {
    return NextResponse.redirect(new URL("/", req.url))
  }

  const contentType = req.headers.get("content-type") || ""
  let inputPwd = ""
  let from = "/"

  if (contentType.includes("application/json")) {
    let body: Record<string, unknown> = {}
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      body = {}
    }
    inputPwd = String(body["password"] ?? "")
    from = String(body["from"] ?? "/") || "/"
  } else {
    const form = await req.formData()
    inputPwd = (form.get("password") ?? "").toString()
    from = (form.get("from") ?? "/").toString() || "/"
  }

  // 比较摘要而非明文，避免基于字符串比较的时序差异
  const [inputDigest, expectedDigest] = await Promise.all([sha256Hex(inputPwd), sha256Hex(password)])
  if (inputDigest !== expectedDigest) {
    const url = new URL("/auth", req.url)
    if (from) url.searchParams.set("from", from)
    url.searchParams.set("e", "1")
    // 303 让浏览器以 GET 方式跳转，避免页面路由收到 POST 返回 405
    return NextResponse.redirect(url, 303)
  }

  const res = NextResponse.redirect(new URL(safeRedirectTarget(from), req.url), 303)
  res.cookies.set(AUTH_COOKIE, await authCookieValue(password), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 天
  })
  return res
}
