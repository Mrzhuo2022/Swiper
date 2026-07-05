/**
 * 本地历史记录（基于 tauri-plugin-store）。
 *
 * 存两类记录：
 * - quick: 划词动作的结果（翻译/总结/润色/解释，单次）
 * - chat : Chatbox 对话的完整消息列表
 *
 * 最近 N 条，超出自动裁剪。纯本地，不联网。
 */
import { LazyStore } from "@tauri-apps/plugin-store";
import { genTimeId } from "./utils";
import type { ChatMessage } from "$services/translate/types";

const STORE_FILE = "history.json";
const MAX_QUICK = 200;
const MAX_CHATS = 50;

/** 单条划词结果记录。 */
export interface QuickRecord {
  id: string;
  ts: number;
  action: string;
  source: string;
  target: string;
}

/** 单个对话会话。 */
export interface ChatRecord {
  id: string;
  ts: number;
  title: string;
  messages: ChatMessage[];
}

let store: LazyStore | null = null;
function db(): LazyStore {
  if (!store) store = new LazyStore(STORE_FILE);
  return store;
}

// ---------- 划词结果 ----------
export async function addQuick(rec: Omit<QuickRecord, "id" | "ts">): Promise<void> {
  const list = (await db().get<QuickRecord[]>("quick")) ?? [];
  list.unshift({ ...rec, id: genTimeId(), ts: Date.now() });
  await db().set("quick", list.slice(0, MAX_QUICK));
  await db().save();
}

export async function getQuick(): Promise<QuickRecord[]> {
  return (await db().get<QuickRecord[]>("quick")) ?? [];
}

export async function clearQuick(): Promise<void> {
  await db().set("quick", []);
  await db().save();
}

// ---------- 对话 ----------
export async function saveChat(rec: Omit<ChatRecord, "id" | "ts"> & { id?: string }): Promise<string> {
  const list = (await db().get<ChatRecord[]>("chats")) ?? [];
  if (rec.id) {
    const idx = list.findIndex((c) => c.id === rec.id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...rec, ts: Date.now() };
      await db().set("chats", list);
      await db().save();
      return rec.id;
    }
  }
  const id = rec.id ?? genTimeId();
  list.unshift({ ...rec, id, ts: Date.now() });
  await db().set("chats", list.slice(0, MAX_CHATS));
  await db().save();
  return id;
}

export async function getChats(): Promise<ChatRecord[]> {
  return (await db().get<ChatRecord[]>("chats")) ?? [];
}

export async function deleteChat(id: string): Promise<void> {
  const list = (await db().get<ChatRecord[]>("chats")) ?? [];
  await db().set("chats", list.filter((c) => c.id !== id));
  await db().save();
}

export async function clearChats(): Promise<void> {
  await db().set("chats", []);
  await db().save();
}
