/// <reference types="svelte" />
/// <reference types="vite/client" />

// 让 Svelte 能 import .svelte 文件
declare module "*.svelte" {
  import type { ComponentType } from "svelte";
  const component: ComponentType;
  export default component;
}

// vite define 注入的版本号（来自 package.json）
declare const __APP_VERSION__: string;
