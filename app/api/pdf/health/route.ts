import { jsonResponse, launchBrowser } from "@/lib/pdf-server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 15

/** 健康检查：验证无头浏览器能否启动 */
export async function GET() {
  try {
    const browser = await launchBrowser()
    await browser.close()
    return jsonResponse({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return jsonResponse({ ok: false, error: message }, 503)
  }
}
