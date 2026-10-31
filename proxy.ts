import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { AUTH_COOKIE, getSitePassword, isAuthorizedCookie } from "@/lib/auth"

// 无需认证即可访问的路径（静态资源在 matcher 中已排除）
const PUBLIC_PATHS = ["/auth", "/api/auth", "/favicon.ico", "/robots.txt"]

function isPublicPath(pathname: string): boolean {
  if (pathname.startsWith("/_next/")) return true
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export async function proxy(req: NextRequest) {
  // 未配置口令时不启用认证
  if (!getSitePassword()) return NextResponse.next()

  const { pathname, search } = req.nextUrl
  if (isPublicPath(pathname)) return NextResponse.next()

  const cookie = req.cookies.get(AUTH_COOKIE)?.value
  if (await isAuthorizedCookie(cookie)) return NextResponse.next()

  // API 路由（包括 PDF 生成与图片代理）返回 401，页面路由跳转到口令页
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const url = req.nextUrl.clone()
  url.pathname = "/auth"
  url.search = ""
  url.searchParams.set("from", `${pathname}${search}` || "/")
  return NextResponse.redirect(url)
}

// 同时覆盖页面与 API 路由；/api/auth 与静态资源在函数内放行
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
}
