import type { ToolResult } from '../tools/types.js';

/**
 * 工具结果的统一长度上限（兜底层）。
 *
 * 工具返回值会同时落到事件流、TUI items、模型 history 三处，超大文本会在堆上留多份副本。
 * 各工具自有入口上限（如 web_fetch 的 MAX_INLINE_CHARS）是主约束；这里是兜底，覆盖新增工具、
 * 外部 MCP、hook 改写等不经各工具自查的路径。
 *
 * 截断保头尾挖中间：头部多留结构信息，尾部多保留结论；默认值（400k）设宽于 web_fetch 单条
 * 上限，只拦异常体量，不干扰各工具自己的语义化截断。
 */

/** 工具结果文本的兜底上限（字符数）。`0` 表示不限制。 */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 400_000;

/** 头部保留占比：头 60% / 尾 40%——头部的结构信息通常比尾部密度低，多留一些。 */
const HEAD_RATIO = 0.6;

/**
 * 中间截断：保留头尾，中间替换为标记（含被省略的字符数，让模型知道丢了多少）。
 * 未超限时原样返回同一引用（不复制字符串）。
 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const marker = (omitted: number): string =>
    `\n\n[... ${String(omitted)} characters omitted by the tool-result size cap ` +
    `(total ${String(text.length)}). Re-run with a narrower scope ` +
    `(offset/limit, more specific path or keyword) to see the middle part. ...]\n\n`;
  // 标记本身占预算：先按空标记估算切点，再用真实标记长度收敛一次即可（标记长度只依赖位数）
  const budget = Math.max(0, maxChars - marker(text.length).length);
  const headLen = Math.floor(budget * HEAD_RATIO);
  const tailLen = budget - headLen;
  const omitted = text.length - headLen - tailLen;
  // 预算被标记吃光（maxChars 配得极小）时退化为纯头部截断，避免产出比原文更长的结果
  if (budget <= 0) return text.slice(0, maxChars);
  return text.slice(0, headLen) + marker(omitted) + text.slice(text.length - tailLen);
}

/**
 * 对工具结果施加兜底上限。未超限时返回原对象（同一引用），超限时返回替换了 `content` 的浅拷贝。
 *
 * 只处理 `content` 文本：`images` 有自己的字节预算（readMedia 侧），`cause` 是内部元数据不进 wire。
 */
export function capToolResult(result: ToolResult, maxChars: number = DEFAULT_MAX_TOOL_RESULT_CHARS): ToolResult {
  if (maxChars <= 0 || result.content.length <= maxChars) return result;
  return { ...result, content: truncateMiddle(result.content, maxChars) };
}
