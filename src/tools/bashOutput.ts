import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 前台命令的输出收集器：**两条流分别记账**，触顶后**溢出落盘**。
 *
 * stdout / stderr 各有独立预算：原实现共用一个上限且判断在追加前，命令失败刷满 stdout
 * 后 stderr 的报错会被 100% 丢弃。分别记账让 stderr 额度不被 stdout 占用（stdout 上限
 * 从 10MB 降到 9MB，用 1MB 换「错误信息永远拿得到」）。对外仍是一份按到达顺序合并的文本。
 *
 * 任一条流首次触顶时把已收集内容冲进文件、后续 chunk 全部写入；内存仍封顶，文件是完整
 * 输出。落盘尽力而为：目录不可写/磁盘满时静默降级为纯丢弃并如实报告，绝不让磁盘问题
 * 把命令变成失败，且降级后不重试。
 *
 * chunk 原样存为 Buffer，只在 snapshot() 时统一解码：逐块 toString 会在多字节字符边界
 * 切开、产生不可逆的 U+FFFD。写文件用原始 Buffer，与命令输出逐字节一致。预算按字节计
 * （UTF-16 字符数会低估中文）。snapshot() 结果按 dirty 缓存，close() 后释放 Buffer 只留解码结果。
 */

/** stdout 与 stderr 的内存预算合计（字节）。 */
const TOTAL_BUDGET = 10 * 1024 * 1024;
/**
 * 每条流的**保底额**：另一条流再怎么刷也吃不掉这部分。
 *
 * 两个方向都要保底，不是只保 stderr：
 * - 保 stderr，防「大量 stdout + 尾部几行报错」——错误信息被日志洪水冲掉（已实测过的 bug）。
 * - 保 stdout，防反向情形「stderr 洪水」——不少构建工具（cargo / tsc / python logging 默认）
 *   把全部输出写 stderr，不保底则正常产物一个字节都留不下。
 */
const PER_STREAM_RESERVE = 1 * 1024 * 1024;
/**
 * 保底之外的**共享池**，两条流先到先得。
 *
 * 为什么需要它：原实现是硬切分（stdout 9MB / stderr 1MB），于是「全部输出走 stderr」的命令
 * 只能留 1MB，而 9MB 的 stdout 额度整场空转——这与「stderr 被 stdout 冲掉」是同一类缺陷的
 * 反向，当时没意识到。加共享池后同一场景可留 1MB 保底 + 8MB 共享 = 9MB。
 *
 * 与外部成熟实现的差别在**时机**不在思想：有的实现在两条流都收完后再分配（stdout 先保底 1/3，
 * stderr 按实际长度取，stderr 没用完的额度回补 stdout），因此能精确回补；我们是流式收集，append
 * 时无法预知后面还有多少字节，做不到后验回补，只能「保底 + 先到先得」。代价是先刷的那条流会
 * 占掉更多共享池——可接受，因为保底额已保证另一条流不会归零。
 */
const SHARED_BUDGET = TOTAL_BUDGET - PER_STREAM_RESERVE * 2;

/** 溢出文件保留个数上限：写新文件前把最旧的删到这个数以内，防止无限堆积。 */
const MAX_OVERFLOW_FILES = 20;
/** 溢出文件所在目录（相对 cwd），与 journal/ workflows/ 同址，已在 gitignore。 */
const OVERFLOW_SUBDIR = join('.step-code', 'tool-output');

export interface OutputCollectorOptions {
  /** stdout 保底额（字节）。默认 1MB；保底之外还可从共享池取。 */
  stdoutReserve?: number;
  /** stderr 保底额（字节）。默认 1MB；保底之外还可从共享池取。 */
  stderrReserve?: number;
  /** 两条流共享的额外预算（字节）。默认 8MB，先到先得。 */
  sharedBudget?: number;
  /** 溢出落盘的基准目录（通常是 cwd）。传 null 关闭落盘（测试与不可写环境）。 */
  cwd?: string | null;
  /** 覆盖时间戳来源，仅测试用（保证文件名可预期）。 */
  now?: () => Date;
}

export interface OutputSnapshot {
  /** 按到达顺序合并的文本（受各自预算限制）。 */
  text: string;
  /** stdout 因超预算被丢出内存的字节数。 */
  droppedStdout: number;
  /** stderr 因超预算被丢出内存的字节数。 */
  droppedStderr: number;
  /** 溢出文件路径；未触顶或落盘失败时为 null。 */
  overflowPath: string | null;
  /** 已写入溢出文件的字节数。 */
  overflowBytes: number;
}

export interface OutputCollector {
  append(chunk: Buffer, stream: 'stdout' | 'stderr'): void;
  snapshot(): OutputSnapshot;
  /** 关闭溢出文件句柄。可重复调用。 */
  close(): void;
}

/** 目录内 `bash-*.log` 超过上限时，按 mtime 从旧到新删到上限以内。失败静默忽略。 */
function pruneOverflowDir(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((n) => n.startsWith('bash-') && n.endsWith('.log'))
      .map((n) => {
        const p = join(dir, n);
        try {
          return { p, t: statSync(p).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { p: string; t: number } => x !== null)
      .sort((a, b) => a.t - b.t);
    for (const f of files.slice(0, Math.max(0, files.length - (MAX_OVERFLOW_FILES - 1)))) {
      try {
        unlinkSync(f.p);
      } catch {
        // 被占用或已删除：跳过，清理不是关键路径
      }
    }
  } catch {
    // 目录还不存在等情况：交给后续 mkdirSync
  }
}

function timestampName(now: Date, seq: number): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const stamp =
    `${String(now.getFullYear())}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `bash-${stamp}-${String(process.pid)}-${String(seq)}.log`;
}

let seqCounter = 0;

/**
 * 建收集器。`cwd` 为 null 时完全不碰磁盘（此时触顶等价于旧的纯丢弃行为，
 * 但仍如实计数）。
 */
export function createOutputCollector(opts: OutputCollectorOptions = {}): OutputCollector {
  const stdoutReserve = opts.stdoutReserve ?? PER_STREAM_RESERVE;
  const stderrReserve = opts.stderrReserve ?? PER_STREAM_RESERVE;
  const sharedBudget = opts.sharedBudget ?? SHARED_BUDGET;
  const cwd = opts.cwd === undefined ? process.cwd() : opts.cwd;
  const nowFn = opts.now ?? ((): Date => new Date());

  /** 内存保留的原始块（仅预算内的）。close() 后释放，解码结果留在 cachedText。 */
  let chunks: Buffer[] = [];
  /** snapshot() 的解码缓存；null = 有新数据待重算。 */
  let cachedText: string | null = null;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  /** 共享池剩余额度（两条流先到先得）。 */
  let sharedLeft = sharedBudget;
  /** 统一解码：一次性拼接全部字节再解码，chunk 边界不会切碎多字节字符。 */
  const decode = (): string => (cachedText ??= Buffer.concat(chunks).toString('utf8'));
  let droppedStdout = 0;
  let droppedStderr = 0;

  let fd: number | null = null;
  let overflowPath: string | null = null;
  let overflowBytes = 0;
  /** 落盘已被判定不可用（失败过一次）：不再重试。 */
  let overflowDisabled = cwd === null;

  /** 首次触顶时开文件并把已收集内容冲进去。失败则永久降级。 */
  const ensureOverflowFile = (): void => {
    if (fd !== null || overflowDisabled || cwd === null) return;
    try {
      const dir = join(cwd, OVERFLOW_SUBDIR);
      pruneOverflowDir(dir);
      mkdirSync(dir, { recursive: true });
      seqCounter += 1;
      const p = join(dir, timestampName(nowFn(), seqCounter));
      const handle = openSync(p, 'a');
      // 先把内存里已有的部分写入，文件才是「完整输出」而不是「触顶后的尾巴」。
      // 用原始字节而非解码后的文本：解码是有损的（边界替换字符），落盘不该继承这个损失。
      const head = Buffer.concat(chunks);
      if (head.length > 0) {
        writeSync(handle, head);
        overflowBytes += head.length;
      }
      fd = handle;
      overflowPath = p;
    } catch {
      overflowDisabled = true;
      fd = null;
      overflowPath = null;
    }
  };

  const writeOverflow = (chunk: Buffer): void => {
    if (fd === null) return;
    try {
      writeSync(fd, chunk);
      overflowBytes += chunk.length;
    } catch {
      // 写失败（磁盘满等）：关掉并永久降级，已写入的部分仍然可用
      try {
        closeSync(fd);
      } catch {
        // 句柄已失效，忽略
      }
      fd = null;
      overflowDisabled = true;
    }
  };

  return {
    append(chunk, stream) {
      const isErr = stream === 'stderr';
      const used = isErr ? stderrBytes : stdoutBytes;
      const reserve = isErr ? stderrReserve : stdoutReserve;
      // 先花自己的保底额，保底用尽再从共享池借。共享池也空了才算触顶。
      // 注意这里判的是「这条流还有没有额度」，不是「总量有没有超」——保底额的意义
      // 正是让另一条流刷爆时本流仍有空间。
      const overBudget = used >= reserve && sharedLeft <= 0;

      // 任一流首次触顶即开始落盘，此后所有 chunk 都进文件（含仍在预算内的另一条流）
      if (overBudget) ensureOverflowFile();
      if (fd !== null) writeOverflow(chunk);

      if (overBudget) {
        if (isErr) droppedStderr += chunk.length;
        else droppedStdout += chunk.length;
        return;
      }
      // 记账：超出保底的部分从共享池扣。整块收下（不切半块），共享池允许透支到 0 为止，
      // 因此实际保留量可能略超标称预算一个 chunk——换取「不在 chunk 中间切断」。
      const beyondReserve = Math.max(0, used + chunk.length - reserve);
      const alreadyBorrowed = Math.max(0, used - reserve);
      sharedLeft -= beyondReserve - alreadyBorrowed;
      chunks.push(chunk);
      cachedText = null;
      if (isErr) stderrBytes += chunk.length;
      else stdoutBytes += chunk.length;
    },
    snapshot() {
      return { text: decode(), droppedStdout, droppedStderr, overflowPath, overflowBytes };
    },
    close() {
      // 先固化解码结果再释放字节：close() 之后 snapshot() 仍要能拿到完整文本
      decode();
      chunks = [];
      if (fd === null) return;
      try {
        closeSync(fd);
      } catch {
        // 已关闭或句柄失效，忽略
      }
      fd = null;
    },
  };
}

/**
 * 把丢弃与落盘情况渲染成给模型看的提示行（不含展示截断那一段，由调用方拼）。
 *
 * 两条原则：
 * 1. **报真实总量**，不报残值。内存里保留的长度触顶后就不再增长，拿它当「共 N 字符」
 *    会把 50MB 说成 10MB——那比不给数字更坏，因为它看起来精确。
 * 2. **给可执行的下一步**，且优先给不会撑爆自己上下文的那一步：有子 agent 可用时
 *    建议委派去筛（大输出留在子上下文里），没有才建议自己分页读。
 */
export function renderOutputNotes(snap: OutputSnapshot, opts: { canDelegate: boolean }): string[] {
  const notes: string[] = [];
  const droppedTotal = snap.droppedStdout + snap.droppedStderr;
  if (droppedTotal === 0) return notes;

  const kb = (n: number): string => `${String(Math.round(n / 1024))} KB`;
  const parts: string[] = [];
  if (snap.droppedStdout > 0) parts.push(`stdout ${kb(snap.droppedStdout)}`);
  if (snap.droppedStderr > 0) parts.push(`stderr ${kb(snap.droppedStderr)}`);

  if (snap.overflowPath !== null) {
    // 有落盘：内存里少的那部分文件里有，给出取用路径
    const next = opts.canDelegate
      ? `完整输出已存到 ${snap.overflowPath}（约 ${kb(snap.overflowBytes)}）。` +
        `需要它的内容时优先派子 agent 去读并只回结论，避免把整份日志拉进当前上下文；` +
        `自己看就用 read_file 配 offset/limit 分页，或用 grep 在该文件里搜关键行。`
      : `完整输出已存到 ${snap.overflowPath}（约 ${kb(snap.overflowBytes)}），` +
        `用 read_file 配 offset/limit 分页读，或用 grep 在该文件里搜关键行。`;
    notes.push(`超出内存收集上限的 ${parts.join(' + ')} 未包含在上面的正文里；${next}`);
  } else {
    notes.push(
      `另有 ${parts.join(' + ')} 输出因超过内存收集上限被丢弃且未能落盘，不可恢复——` +
        `需要完整输出请把命令的输出重定向到文件，再用 read_file 分页读`,
    );
  }
  return notes;
}
