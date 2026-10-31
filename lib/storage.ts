"use client"

import { importFromMagicyanFile, validateResumeData } from "@/lib/utils"
import type { ResumeData, StoredResume } from "@/types/resume"
import { LOCAL_STORAGE_KEY } from "@/types/resume"

export type StorageErrorCode =
  | "UNAVAILABLE"
  | "PARSE_ERROR"
  | "QUOTA_EXCEEDED"
  | "UNKNOWN"

export class StorageError extends Error {
  code: StorageErrorCode
  constructor(message: string, code: StorageErrorCode = "UNKNOWN") {
    super(message)
    this.code = code
    this.name = "StorageError"
  }
}

function ensureClient() {
  if (typeof window === "undefined") {
    throw new StorageError("只能在浏览器环境中访问本地存储", "UNAVAILABLE")
  }
}

function readAll(): StoredResume[] {
  ensureClient()
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as StoredResume[]
    if (!Array.isArray(parsed)) return []
    return parsed
  } catch {
    throw new StorageError("读取本地存储失败，数据格式错误", "PARSE_ERROR")
  }
}

function writeAll(list: StoredResume[]) {
  ensureClient()
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(list))
  } catch (e: unknown) {
    // Safari throws DOMException with code 22, Firefox: 1014, Chrome name: QuotaExceededError
    const isQuota = (() => {
      if (typeof e === "object" && e !== null) {
        const maybe: { name?: unknown; code?: unknown } = e as Record<string, unknown>
        const name = typeof maybe.name === "string" ? maybe.name : undefined
        const code = typeof maybe.code === "number" ? maybe.code : undefined
        return name === "QuotaExceededError" || code === 22 || code === 1014
      }
      return false
    })()
    if (isQuota) {
      throw new StorageError("存储容量已满", "QUOTA_EXCEEDED")
    }
    throw new StorageError("写入本地存储失败", "UNKNOWN")
  }
}

export function getAllResumes(): StoredResume[] {
  return readAll()
}

export function getResumeById(id: string): StoredResume | null {
  return readAll().find((r) => r.id === id) || null
}

/** 供 useState 惰性初始化使用：服务端或读取失败时返回 null，不抛错 */
export function tryGetResumeById(id: string): StoredResume | null {
  if (typeof window === "undefined") return null
  try {
    return getResumeById(id)
  } catch {
    return null
  }
}

/** 用户中心预加载新建简历数据时使用的 sessionStorage 键 */
export const NEW_RESUME_PREFETCH_KEY = "new-edit-initial-data"

/**
 * 新建页的初始数据：优先克隆指定条目，其次使用用户中心预加载的数据。
 * 仅在浏览器中读取；服务端返回 undefined。
 */
export function readNewResumeInitialData(cloneId: string | null): ResumeData | undefined {
  if (typeof window === "undefined") return undefined
  if (cloneId) {
    const entry = tryGetResumeById(cloneId)
    if (entry) return { ...entry.resumeData }
  }
  try {
    const raw = window.sessionStorage.getItem(NEW_RESUME_PREFETCH_KEY)
    if (raw) return JSON.parse(raw) as ResumeData
  } catch {
    /* ignore */
  }
  return undefined
}

export function upsertResume(entry: StoredResume): StoredResume {
  const list = readAll()
  const idx = list.findIndex((r) => r.id === entry.id)
  if (idx >= 0) list[idx] = entry
  else list.unshift(entry)
  writeAll(list)
  return entry
}

export function deleteResumes(ids: string[]): void {
  const set = new Set(ids)
  const next = readAll().filter((r) => !set.has(r.id))
  writeAll(next)
}

export function createEntryFromData(data: ResumeData): StoredResume {
  const now = new Date().toISOString()
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  // Ensure timestamps in data align with entry
  const normalized: ResumeData = {
    ...data,
    createdAt: data.createdAt || now,
    updatedAt: now,
  }

  const { isValid, errors } = validateResumeData(normalized)
  if (!isValid) {
    throw new StorageError(`简历数据校验失败：${errors.join("；")}`)
  }

  const entry: StoredResume = {
    id,
    createdAt: now,
    updatedAt: now,
    resumeData: normalized,
  }
  upsertResume(entry)
  return entry
}

export function updateEntryData(id: string, data: ResumeData): StoredResume {
  const list = readAll()
  const idx = list.findIndex((r) => r.id === id)
  if (idx < 0) throw new StorageError("未找到对应的简历条目")

  const now = new Date().toISOString()
  const merged: ResumeData = {
    ...data,
    createdAt: list[idx].resumeData.createdAt || list[idx].createdAt,
    updatedAt: now,
  }

  const { isValid, errors } = validateResumeData(merged)
  if (!isValid) {
    throw new StorageError(`简历数据校验失败：${errors.join("；")}`)
  }

  const updated: StoredResume = {
    ...list[idx],
    updatedAt: now,
    resumeData: merged,
  }
  list[idx] = updated
  writeAll(list)
  return updated
}

async function loadTemplateFrom(path: string): Promise<ResumeData | null> {
  try {
    const res = await fetch(path)
    if (!res.ok) return null
    const content = await res.text()
    const data = importFromMagicyanFile(content)
    return data
  } catch {
    return null
  }
}

export function loadDefaultTemplate(): Promise<ResumeData | null> {
  return loadTemplateFrom("/template.json")
}

export function loadExampleTemplate(): Promise<ResumeData | null> {
  return loadTemplateFrom("/example.json")
}
