import { closeSync, openSync, readSync } from 'node:fs';

/**
 * 大文件的流式逐行扫描，供 `grep` 在不整文件读入的前提下搜索任意大小的文件。
 *
 * 流式无需处理正则跨块边界：grep 匹配逐行进行，正则不带 m/s flag、`.` 不匹配换行，
 * 模式不可能跨行。只要交给匹配的是完整一行，流式与「全量读入再 split」语义等价。
 *
 * 边界须与 split('\n') 逐字一致（等价性是正确性标准）：`'a\n'` 产出 2 行（末尾空串）、
 * `''` 产出 1 行空串、CRLF 的 `\r` 保留。实现上每遇 0x0A 产出一行、结束后无条件再产出
 * 一次残段；少了那次产出会让 `'a\n'` 少一行（静默差异）。
 *
 * 单行长度上限防 minified JS / 单行 JSON 把整行聚进内存：超过 maxLineBytes 只保留前这么
 * 多字节参与匹配，其余丢弃并上报 truncatedLineBytes。截断按字节切，可能切开多字节字符
 * 产生一个替换字符，仅影响该行。
 */

/** 单行参与匹配的最大字节数。超出部分丢弃并上报，防超长单行把内存优势吃掉。 */
export const MAX_LINE_BYTES = 1024 * 1024;
/** 每次 readSync 的块大小。 */
const STREAM_CHUNK_BYTES = 64 * 1024;
/** 二进制嗅探读取的头部字节数。 */
const SNIFF_BYTES = 8 * 1024;

export interface ScanOptions {
  /** 单行上限（字节）。默认 1MB。 */
  maxLineBytes?: number;
  /** 块大小（字节）。默认 64KB，仅测试需要调小。 */
  chunkBytes?: number;
}

export interface ScanResult {
  /** 是否因 `onLine` 返回 false 而提前停止（早停必须真的停，否则大文件会白扫到底）。 */
  stopped: boolean;
  /** 扫描过的行数。 */
  lines: number;
  /** 被截断的最长那一行的**真实**字节数；0 表示没有任何行被截断。 */
  truncatedLineBytes: number;
}

/**
 * 逐行扫描文件。`onLine` 返回 false 立即停止扫描。
 *
 * 行号从 1 开始。返回的 `truncatedLineBytes` 是真实字节数而非截断后的长度——
 * 报残值会让调用方误判损失大小。
 */
export function scanLinesStreaming(
  file: string,
  onLine: (line: string, lineNo: number) => boolean,
  opts: ScanOptions = {},
): ScanResult {
  const maxLineBytes = opts.maxLineBytes ?? MAX_LINE_BYTES;
  const chunkBytes = opts.chunkBytes ?? STREAM_CHUNK_BYTES;
  const res: ScanResult = { stopped: false, lines: 0, truncatedLineBytes: 0 };

  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkBytes);
    /** 当前行已收集的片段（受 maxLineBytes 限制）。 */
    let pending: Buffer[] = [];
    let pendingLen = 0;
    /** 当前行的真实字节数（不受限制，用于如实上报截断量）。 */
    let curLineBytes = 0;

    const appendSeg = (b: Buffer, from: number, to: number): void => {
      const len = to - from;
      if (len <= 0) return;
      curLineBytes += len;
      const room = maxLineBytes - pendingLen;
      if (room <= 0) return; // 本行已满：继续累计真实字节数，但不再进内存
      const take = Math.min(len, room);
      // 必须复制：buf 会在下一次 readSync 被覆写，留引用会读到后续数据
      pending.push(Buffer.from(b.subarray(from, from + take)));
      pendingLen += take;
    };

    const emit = (): boolean => {
      res.lines += 1;
      if (curLineBytes > maxLineBytes) {
        res.truncatedLineBytes = Math.max(res.truncatedLineBytes, curLineBytes);
      }
      const line =
        pending.length === 0
          ? ''
          : pending.length === 1
            ? pending[0]!.toString('utf8')
            : Buffer.concat(pending).toString('utf8');
      pending = [];
      pendingLen = 0;
      curLineBytes = 0;
      return onLine(line, res.lines);
    };

    let bytesRead: number;
    while ((bytesRead = readSync(fd, buf, 0, chunkBytes, null)) > 0) {
      let start = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] !== 0x0a) continue;
        appendSeg(buf, start, i);
        start = i + 1;
        if (!emit()) {
          res.stopped = true;
          return res;
        }
      }
      appendSeg(buf, start, bytesRead);
    }
    // 与 split('\n') 对齐：末尾残段无条件产出一次（'a\n' 是 2 行，'' 是 1 行空串）
    if (!emit()) res.stopped = true;
    return res;
  } finally {
    closeSync(fd);
  }
}

/**
 * 按头部采样判断是否为二进制（含 NUL 即认定）。
 *
 * 小文件路径用的是「整文件查 NUL」，流式路径没有整文件，只能采样。代价如实记：
 * NUL 出现在 `SNIFF_BYTES` 之后时会漏判，该文件会被当文本搜索——最坏结果是若干乱码行
 * 进入匹配结果，不影响其它文件的正确性。外部实现同样采样（有一家取 4096 字节）。
 */
export function looksBinaryByHead(file: string, sniffBytes = SNIFF_BYTES): boolean {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.allocUnsafe(sniffBytes);
    const n = readSync(fd, head, 0, sniffBytes, 0);
    for (let i = 0; i < n; i++) if (head[i] === 0) return true;
    return false;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}
