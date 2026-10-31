"use client"

import { use, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Icon } from "@iconify/react"
import type { StoredResume } from "@/types/resume"
import { tryGetResumeById } from "@/lib/storage"
import ResumePreviewPaginated from "@/components/resume-preview-paginated"
import { useHydrated } from "@/hooks/use-hydrated"

export default function ViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  // localStorage 只能在浏览器中读取：水合完成后再展示，避免服务端渲染阶段抛错
  const hydrated = useHydrated()
  const [entry] = useState<StoredResume | null>(() => tryGetResumeById(id))

  if (!hydrated) {
    return <main className="min-h-screen bg-background" />
  }

  if (!entry) {
    return (
      <main className="min-h-screen bg-background p-6">
        <div className="flex items-center gap-3">
          <Button variant="outline" className="gap-2 bg-transparent" onClick={() => router.push("/")}>
            <Icon icon="mdi:arrow-left" className="w-4 h-4" /> 返回
          </Button>
          <span className="text-sm text-destructive">未找到该简历</span>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-background">
      <div className="flex items-center justify-between p-4">
        <div className="flex items-center gap-3">
          <Button variant="outline" className="gap-2 bg-transparent" onClick={() => router.push("/")}>
            <Icon icon="mdi:arrow-left" className="w-4 h-4" /> 返回
          </Button>
          <span className="text-sm text-muted-foreground">预览：{entry.resumeData.title}</span>
        </div>
      </div>
      <Separator />
      <div className="p-4">
        <div className="preview-panel w-full">
          <ResumePreviewPaginated resumeData={entry.resumeData} />
        </div>
      </div>
    </main>
  )
}
