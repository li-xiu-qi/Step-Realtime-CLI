/**
 * ResultRenderer 注册表 — 按工具名匹配渲染策略。
 *
 * 设计来源：Kimi Code 的 @/tui/components/messages/tool-renderers/。
 * 每条工具结果在进入渲染管线前先查表，决定：
 *   - collapsed 状态展示几行
 *   - 超过阈值是否 offload 到文件
 *   - 是否用摘要（chip 只显示统计，body 为空）
 */

// ─── 常量 ───────────────────────────────────────────────────────────────────

/** 工具结果预览默认行数（匹配 Kimi Code 的 RESULT_PREVIEW_LINES）。 */
export const RESULT_PREVIEW_LINES = 3;

/** 错误结果预览行数（比普通多 1 行以便看清错误栈首行）。 */
export const ERROR_PREVIEW_LINES = 3;

/** diff 预览行数。200 行触发 OOM 风险，降到 40。 */
export const DIFF_MAX_LINES = 40;

/** 超过此字符数的结果写文件 offload（4KB）。 */
export const MAX_INLINE_CHARS = 4096;

/** 超过此字符数的结果强制 offload（64KB），即使渲染器类型是 full。 */
export const MAX_RESULT_CHARS = 65536;

// ─── 渲染策略类型 ────────────────────────────────────────────────────────

/** 渲染策略：body 渲染方式。 */
export type BodyMode =
  | 'summary'   // body 为空，芯片只显示统计信息（grep/glob 等）
  | 'truncated' // 裁剪到 N 行，超出部分折叠提示（默认）
  | 'full';     // 完整展示（diff、错谋栈）

export interface ToolRenderer {
  /** 折叠状态下的 body 渲染模式。 */
  bodyMode: BodyMode;
  /** 摘要文本（bodyMode = 'summary' 时使用，或 truncated/full 时额外加一行摘要）。 */
  summary?: string;
  /** 是否总是 offload（无视内容大小，适合元数据类工具）。 */
  forceOffload?: boolean;
}

// ─── 工具分类 ─────────────────────────────────────────────────────────────

/** 匹配集合。 */
const SUMMARY_TOOLS = new Set([
  'grep', 'glob', 'web_search', 'web_fetch', 'ls', 'find',
]);

const ALWAYS_OFFLOAD = new Set([
  'web_fetch', // 抓到的网页正文可能非常大
]);

// ─── 注册表 ─────────────────────────────────────────────────────────────────

export function getToolRenderer(toolName: string): ToolRenderer {
  if (SUMMARY_TOOLS.has(toolName)) {
    return { bodyMode: 'summary', summary: '' };
  }
  if (ALWAYS_OFFLOAD.has(toolName)) {
    return { bodyMode: 'truncated', forceOffload: true };
  }
  return { bodyMode: 'truncated' };
}

/** 是否为摘要型工具（渲染 body 为空，只显示统计）。 */
export function isSummaryTool(toolName: string): boolean {
  return SUMMARY_TOOLS.has(toolName);
}

/** 工具结果是否需要强制 offload 到文件。 */
export function shouldForceOffload(toolName: string): boolean {
  return ALWAYS_OFFLOAD.has(toolName);
}

// ─── 摘要计算 ────────────────────────────────────────────────────────────

/**
 * 从工具结果中提取摘要行。
 * 默认返回结果的第 1 行（通常是最关键的信息）。
 * grep/glob 提取前 N 个命中路径。
 */
export function summarizeResult(toolName: string, result: string): string {
  if (result.length === 0) return '（空结果）';
  const firstLine = result.split('\n').find((l) => l.trim().length > 0);
  if (!firstLine) return '（空结果）';

  // grep / glob：提取前 N 行作为路径/文本采样
  if (SUMMARY_TOOLS.has(toolName)) {
    const lines = result.split('\n').filter((l) => l.trim().length > 0);
    const samples = lines.slice(0, 3);
    if (lines.length > 3) {
      return `${samples.join(', ')}, +${lines.length - 3} more`;
    }
    return samples.join(', ');
  }

  // 其他工具：取首行，超长截断
  const trimmed = firstLine.trim();
  if (trimmed.length > 80) return trimmed.slice(0, 77) + '…';
  return trimmed;
}

/**
 * 从完整输出中萃取行数 + 字符数摘要。
 * 供折叠 hint 行使用：`↳ N 行 / M 字符（Ctrl+O 查看）`
 */
export function outputStats(result: string): { lines: number; chars: number } {
  const lines = result.split('\n');
  return { lines: lines.length, chars: result.length };
}
