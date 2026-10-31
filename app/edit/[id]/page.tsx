"use client"

import { use, useState } from "react"
import { useRouter } from "next/navigation"
import ResumeBuilder from "@/components/resume-builder"
import { Button } from "@/components/ui/button"
import { Icon } from "@iconify/react"
import type { ResumeData, StoredResume } from "@/types/resume"
import { tryGetResumeById, updateEntryData, StorageError } from "@/lib/storage"
import { useToast } from "@/hooks/use-toast"
import { useHydrated } from "@/hooks/use-hydrated"

export default function EditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { toast } = useToast()

  // localStorage 只能在浏览器中读取：服务端得到 null，客户端首帧也先渲染空壳，
  // 水合完成后再展示，避免直接打开或刷新时报错或标记不一致
  const hydrated = useHydrated()
  const [entry] = useState<StoredResume | null>(() => tryGetResumeById(id))

  const handleSave = async (data: ResumeData) => {
    try {
      const updated = updateEntryData(id, data)
      toast({ title: "保存成功", description: new Date(updated.updatedAt).toLocaleString() })
    } catch (e: unknown) {
      if (e instanceof StorageError && e.code === "QUOTA_EXCEEDED") {
        toast({
          title: "保存失败：存储空间不足",
          description: "请删除一些旧的简历，或导出为 JSON 文件后清理存储。",
          variant: "destructive",
        })
      } else {
        const message = e instanceof Error ? e.message : "未知错误"
        toast({ title: "保存失败", description: message, variant: "destructive" })
      }
    }
  }

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
      <ResumeBuilder
        initialData={entry.resumeData}
        onBack={() => router.push("/")}
        onSave={(data) => handleSave(data)}
      />
    </main>
  )
}
