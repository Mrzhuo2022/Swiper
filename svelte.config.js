import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  // vitePreprocess 让 <script lang="ts"> / <style lang="..."> 之类语法可用
  preprocess: vitePreprocess(),
};
