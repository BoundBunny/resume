// Flat ESLint config for Next.js + ESLint 9
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const config = [
  // 构建产物与依赖不参与检查
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  // Next.js + React rules (Core Web Vitals)
  ...nextCoreWebVitals,
  // TypeScript recommended rules
  ...nextTypescript,
  {
    rules: {
      // JSX 文案中直接使用中文引号与双引号，无需转义
      "react/no-unescaped-entities": "off",
    },
  },
];

export default config;
