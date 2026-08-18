/**
 * thinking 流死循环检测（纯函数，无 IO）。
 *
 * 思考型模型在难任务上可能在 thinking 阶段陷入周期性重复，直到 max_tokens 耗尽、正文零输出。
 * 内置的预算耗尽降档只在终点介入，本模块在流式中途检测，让恢复手段提前触发。
 *
 * 只比对流末尾与更早内容，避开代码/列表在中部的合理重复：
 * - 长重复：末尾 WINDOW 块在更早内容出现 ≥ REPEAT_THRESHOLD 次，且末尾 N 个连续窗口全部命中。
 * - 短周期：末尾存在周期 < MIN_PERIOD 的精确复读（如「的的的的」）。
 *
 * 每次 ingest 只扫尾部窗口（O(1) 摊销），宁漏不误报——误报触发「中止思考」会打断正常推理。
 */

/** 检测窗口大小（字符）。取 50：小于常见列表项/代码行的重复单元，大于大多数标点抖动。 */
const WINDOW = 50;
/** 一个窗口在更早内容中出现 ≥ 该次数，计为「重复」。1 次出现 = 初次，≥2 次出现 = 开始重复。 */
const REPEAT_THRESHOLD = 3;
/** 末尾连续命中窗口数 ≥ 该值，判定为「循环进行中」。2 个窗口 = 至少 100 字符仍在重复。 */
const CONSECUTIVE_TAIL_HITS = 2;
/** 短周期循环的最小重复次数：末尾周期 p 的单元重复 ≥ 该次数才判定。 */
const SHORT_PERIOD_MIN_REPEATS = 8;
/** 短周期的最大周期长度：超过即交给长重复路径。 */
const SHORT_PERIOD_MAX = 12;
/** 触发检测的最小流长度：思考太短不可能成循环，避免开头误判。 */
const MIN_CHARS = 400;

export interface ThinkingLoopVerdict {
  /** 是否判定为死循环。 */
  looping: boolean;
  /** 命中的重复单元预览（截断），供提示文案展示。 */
  sample?: string;
  /** 重复次数（长重复路径的命中次数，或短周期路径的重复单元数）。 */
  repeats?: number;
}

/**
 * 思考流死循环检测器。每次 thinking_delta 到来时 ingest 增量文本，
 * 返回当前判定（只在状态翻转时由调用方消费，避免每帧都触发提示）。
 */
export function createThinkingLoopDetector(): {
  ingest: (delta: string) => ThinkingLoopVerdict;
  /** 当前累积的思考文本（供注入诱导时截取上下文）。 */
  text: () => string;
  reset: () => void;
} {
  let buf = '';
  let fired = false;

  function detect(): ThinkingLoopVerdict {
    if (buf.length < MIN_CHARS) return { looping: false };

    // --- 短周期循环（逐字复读）：末尾周期 p ∈ [1, SHORT_PERIOD_MAX] 的精确循环 ---
    for (let p = 1; p <= SHORT_PERIOD_MAX; p++) {
      if (buf.length < p * SHORT_PERIOD_MIN_REPEATS) break;
      const tail = buf.slice(-p * SHORT_PERIOD_MIN_REPEATS);
      const unit = tail.slice(0, p);
      let ok = true;
      for (let i = p; i < tail.length; i += p) {
        if (tail.slice(i, i + p) !== unit) {
          ok = false;
          break;
        }
      }
      if (ok) {
        return { looping: true, sample: unit, repeats: SHORT_PERIOD_MIN_REPEATS };
      }
    }

    // --- 长重复（段落级）：末尾连续 CONSECUTIVE_TAIL_HITS 个窗口各自在更早内容中重复 ---
    // 从尾向前取窗口，步长 WINDOW/2（重叠采样，避免窗口对齐恰好错过重复单元）。
    let consecutive = 0;
    let sample: string | undefined;
    let maxRepeats = 0;
    for (let end = buf.length; end - WINDOW >= MIN_CHARS / 2 && consecutive < CONSECUTIVE_TAIL_HITS; end -= Math.floor(WINDOW / 2)) {
      const win = buf.slice(end - WINDOW, end);
      // 该窗口在「更早内容」（去掉末尾本身）中的出现次数
      const earlier = buf.slice(0, end - WINDOW);
      let count = 0;
      let idx = earlier.indexOf(win);
      while (idx !== -1) {
        count++;
        idx = earlier.indexOf(win, idx + 1);
        if (count >= REPEAT_THRESHOLD) break;
      }
      maxRepeats = Math.max(maxRepeats, count);
      if (count >= REPEAT_THRESHOLD) {
        consecutive++;
        sample = sample ?? win;
      } else {
        break; // 末尾窗口不再重复 → 循环已停，不算进行中
      }
    }
    if (consecutive >= CONSECUTIVE_TAIL_HITS) {
      return { looping: true, sample, repeats: maxRepeats };
    }
    return { looping: false };
  }

  return {
    ingest(delta: string): ThinkingLoopVerdict {
      buf += delta;
      if (fired) return { looping: false }; // 已触发过，本回合不再重复触发
      const v = detect();
      if (v.looping) fired = true;
      return v;
    },
    text: () => buf,
    reset: () => {
      buf = '';
      fired = false;
    },
  };
}
