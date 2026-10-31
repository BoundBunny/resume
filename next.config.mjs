/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  devIndicators: false,
  // 无头浏览器相关依赖不参与打包，保证 Chromium 二进制与 puppeteer 在 Serverless 环境可被直接加载
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
}

export default nextConfig
