"use client"

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import ResumeBuilder from "@/components/resume-builder"
import type { ResumeData } from "@/types/resume"
import {
  createEntryFromData,
  NEW_RESUME_PREFETCH_KEY,
  readNewResumeInitialData,
  StorageError,
} from "@/lib/storage"
import { useToast } from "@/hooks/use-toast"
import { useHydrated } from "@/hooks/use-hydrated"

export default function NewEditPage() {
  // 包裹 Suspense 以满足 useSearchParams 的要求，fallback 为空避免“加载中...”
  return (
    <Suspense fallback={null}>
      <NewEditPageContent />
    </Suspense>
  )
}

function NewEditPageContent() {
  const router = useRouter()
  const search = useSearchParams()
  const { toast } = useToast()

  const cloneId = search.get("clone")
  const useExample = search.get("example") === "1" || search.get("example") === "true"

  // 克隆数据与预加载数据都来自浏览器存储：服务端得到 undefined，
  // 客户端在水合渲染时一次性读取，水合完成后再挂载编辑器，避免标记不一致
  const hydrated = useHydrated()
  const [initialData] = useState<ResumeData | undefined>(() => readNewResumeInitialData(cloneId))

  // 预加载数据只消费一次，避免下次新建时复用旧数据
  useEffect(() => {
    try {
      sessionStorage.removeItem(NEW_RESUME_PREFETCH_KEY)
    } catch {
      /* ignore */
    }
  }, [])

  const handleSave = async (current: ResumeData) => {
    try {
      const entry = createEntryFromData(current)
      toast({ title: "保存成功", description: `已创建：${entry.resumeData.title}` })
      router.replace(`/edit/${entry.id}`)
    } catch (e: unknown) {
      if (e instanceof StorageError && e.code === "QUOTA_EXCEEDED") {
        toast({
          title: "保存失败：存储空间不足",
          description: "请删除一些旧的简历，或导出为 JSON 后清理存储。",
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

  return (
    <main className="min-h-screen bg-background">
      <ResumeBuilder
        initialData={initialData}
        template={useExample ? "example" : "default"}
        onBack={() => router.push("/")}
        onSave={(d) => handleSave(d)}
      />
    </main>
  )
}
