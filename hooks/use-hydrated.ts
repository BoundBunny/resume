"use client"

import { useSyncExternalStore } from "react"

const subscribe = () => () => {}

/**
 * 服务端渲染与客户端首帧（水合）返回 false，水合完成后返回 true。
 * 用于把只能在浏览器中得到的初始数据推迟到水合之后再渲染，避免服务端与客户端标记不一致。
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  )
}
