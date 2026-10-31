import { errorResponse, jsonResponse, pdfResponse, readResumeData, renderResumePdf } from "@/lib/pdf-server"
import { generatePdfFilename } from "@/lib/utils"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

/** 直接生成并返回 PDF（inline） */
export async function POST(req: Request) {
  try {
    const resumeData = await readResumeData(req)
    if (!resumeData) return jsonResponse({ error: "Missing resumeData" }, 400)

    const pdf = await renderResumePdf(req, resumeData)
    return pdfResponse(pdf, generatePdfFilename(resumeData.title || "resume"))
  } catch (error) {
    return errorResponse(error)
  }
}
