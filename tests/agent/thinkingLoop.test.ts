import { describe, expect, it } from 'vitest';
import { createThinkingLoopDetector } from '../../src/agent/thinkingLoop.js';

/** 用同一单元重复 N 次构造文本。 */
function repeat(unit: string, n: number): string {
  return unit.repeat(n);
}

describe('thinking 流死循环检测器', () => {
  it('短周期逐字复读（「的」×N）→ 判定循环', () => {
    const d = createThinkingLoopDetector();
    // 同一 16 字符短语重复 20 次（320 字符），短周期路径（p=16 > SHORT_PERIOD_MAX=12，
    // 走长重复路径：末尾 50 字符窗口在更早内容中出现 ≥3 次且连续 2 个窗口命中）
    // 在 MIN_CHARS=100 下会命中——这确实是循环，不是正常推理。
    let v = d.ingest(repeat('让我先思考一下这个问题的背景。', 20));
    expect(v.looping).toBe(true);
    // 触发后 fired 一次性守卫阻止重复触发（另一用例覆盖）
  });

  it('段落级周期重复（同一段话反复输出）→ 判定循环', () => {
    const d = createThinkingLoopDetector();
    const para = '首先我需要分析这个问题的核心矛盾，它涉及到多个层面的因素，需要逐一排查确认。',
      // 同一段话重复多遍（模拟模型反复「重新整理思路」）
      v = d.ingest(repeat(para, 12));
    expect(v.looping).toBe(true);
    expect(v.sample).toBeDefined();
  });

  it('正常推理文本（无重复）→ 不判定', () => {
    const d = createThinkingLoopDetector();
    // 构造足够长但不重复的推理文本
    let text = '';
    for (let i = 0; i < 40; i++) {
      text += `第${i}步分析：因素${i}与因素${i + 1}的关系需要考察，因为${i * 7}和${i * 13}的比值影响了结论${i}的成立条件。`;
    }
    const v = d.ingest(text);
    expect(v.looping).toBe(false);
  });

  it('列表/枚举式重复（结构相同内容不同）→ 不判定（避免代码/清单场景误报）', () => {
    const d = createThinkingLoopDetector();
    // 列表每项模板相同但内容不同，是合理重复而非死循环
    let text = '';
    for (let i = 0; i < 30; i++) {
      text += `${i + 1}. 选项${i + 1}的评估结果是${i % 2 === 0 ? '通过' : '不通过'}，理由是指标${i}的读数为${i * 3}。\n`;
    }
    const v = d.ingest(text);
    expect(v.looping).toBe(false);
  });

  it('触发后不再重复触发（fired 一次性）', () => {
    const d = createThinkingLoopDetector();
    d.ingest(repeat('的', 500));
    const v1 = d.ingest(repeat('的', 100));
    // 已 fired，后续 ingest 返回不触发
    expect(v1.looping).toBe(false);
  });

  it('短文本不触发（MIN_CHARS 门槛）', () => {
    const d = createThinkingLoopDetector();
    const v = d.ingest(repeat('的', 50)); // 远小于 MIN_CHARS=400
    expect(v.looping).toBe(false);
  });

  it('reset 后可重新检测', () => {
    const d = createThinkingLoopDetector();
    d.ingest(repeat('的', 500));
    d.reset();
    expect(d.text()).toBe('');
    const v = d.ingest('正常内容');
    expect(v.looping).toBe(false);
  });
});
