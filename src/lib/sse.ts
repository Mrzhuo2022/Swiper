/**
 * SSE (Server-Sent Events) 流解析器。
 *
 * 按 `\n\n` 分块缓冲，对每个 `data: <json>` 行回调。
 * 处理跨 chunk 的边界（DESIGN §9 风险对策）。
 */

type DataCallback = (jsonStr: string) => void;

export async function parseSSEStream(
  body: ReadableStream<Uint8Array>,
  onData: DataCallback,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        handleEvent(rawEvent, onData);
      }
    }
    // 处理流末尾可能残留的最后一个事件
    if (buffer.trim()) {
      handleEvent(buffer, onData);
    }
  } finally {
    reader.releaseLock();
  }
}

function handleEvent(rawEvent: string, onData: DataCallback): void {
  for (const line of rawEvent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") continue;
    if (payload) onData(payload);
  }
}
