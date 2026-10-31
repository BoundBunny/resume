import { fetchRemoteResource, parsePublicHttpUrl } from "@/lib/server-request"

export const runtime = "edge"
export const dynamic = "force-dynamic"

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

function badRequest(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/**
 * 远程图片代理：导出图片时用于规避跨域与画布污染。
 * 仅允许公网 http(s) 地址、仅转发 image/* 响应、限制体积，并逐跳校验重定向目标。
 */
export async function GET(req: Request) {
  try {
    const raw = new URL(req.url).searchParams.get("url") || ""
    if (!raw) return badRequest("Missing url")
    if (!parsePublicHttpUrl(raw)) return badRequest("URL not allowed")

    const resource = await fetchRemoteResource(raw, {
      allowedContentType: /^image\//,
      maxBytes: MAX_IMAGE_BYTES,
    })
    if (!resource) return badRequest("Upstream fetch failed or not an image", 502)

    return new Response(resource.bytes, {
      status: 200,
      headers: {
        "content-type": resource.contentType,
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
        // 导出过程中可能重复请求同一图片，允许短暂缓存
        "cache-control": "public, max-age=60",
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e || "")
    return badRequest(msg, 500)
  }
}
