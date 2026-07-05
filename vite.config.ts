import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "path";
import pkg from "./package.json";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [svelte()],
  // 把 package.json 的版本号注入为全局常量，前端用 __APP_VERSION__ 引用（避免硬编码漂移）
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // Tauri 要求使用确定的产物路径，且开发时监听固定端口。
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 不监听 Rust 侧变化，避免触发前端 HMR 重载
      ignored: ["**/src-tauri/**"],
    },
  },
  // 产物输出到 src-tauri 拾取的固定目录
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows"
        ? "chrome105"
        : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  resolve: {
    alias: {
      $lib: resolve("./src/lib"),
      $components: resolve("./src/components"),
      $services: resolve("./src/services"),
      $windows: resolve("./src/windows"),
    },
  },
});
