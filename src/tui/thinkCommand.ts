import {
  DEFAULT_THINKING_LEVELS,
  isThinkingLevelName,
  PROVIDER_PRESETS,
  THINKING_LEVEL_NAMES,
  THINKING_TEXT_MARGIN,
  type ThinkingConfig,
  type ThinkingLevelName,
} from '../config/config.js';
import type { ThinkingParam } from '../provider/types.js';

/**
 * /think 命令的纯函数层：参数解析、覆盖 → 请求参数投影、状态栏标签、门控判定。
 * 全部无副作用，便于单测；App 只负责把这些结果接到 state 与 pushItem 上。
 *
 * 会话级覆盖（ThinkOverride）三态：
 * - undefined：跟随 config 的 default_level（恒有值，缺省 medium）；
 * - 'off'：本会话不再发送 thinking 字段（请求级传 null 抑制）；
 * - 'low' | 'medium' | 'high'：档位名，直接作为服务端 effort 值。
 */
export type ThinkOverride = string;

/** /think 参数解析结果。 */
export type ThinkArgResult =
  | { kind: 'show' }
  | { kind: 'set'; override: ThinkOverride }
  | { kind: 'invalid'; name: string };

/**
 * 解析 /think 参数：空参 → show；'off' → 会话级关闭；命中三档之一 → 切换档位；
 * 其余 → invalid（调用方列出可用档位报错）。
 *
 * 不再需要传档位表：合法档位固定为 low|medium|high，不由配置决定。
 */
export function parseThinkArgs(args: string): ThinkArgResult {
  const arg = args.trim();
  if (arg === '') return { kind: 'show' };
  if (arg === 'off') return { kind: 'set', override: 'off' };
  if (isThinkingLevelName(arg)) return { kind: 'set', override: arg };
  return { kind: 'invalid', name: arg };
}

/**
 * 会话覆盖 → 传给 runAgent / provider.stream 的 thinking 参数（三态：
 * undefined 用构造默认 / 对象覆盖 / null 本次抑制）。
 *
 * 返回对象同时带 level 与 budgetTokens：阶跃三协议只认档位名，原生 Anthropic 只认数字。
 * **必须带 level**——曾经这里只返回 budgetTokens，让 provider 反推档位；反推阈值硬编码，
 * 用户改 levels 数字就会静默错档。而且 TS 结构类型不会报错，这类丢字段的问题
 * 编译期抓不到，只能靠这里的契约把两份都填满。
 */
export function thinkStreamParam(
  override: ThinkOverride | undefined,
  levels: Record<ThinkingLevelName, number>,
): ThinkingParam | null | undefined {
  if (override === undefined) return undefined;
  if (override === 'off') return null;
  if (!isThinkingLevelName(override)) return undefined;
  return { level: override, budgetTokens: levels[override] };
}

/**
 * 状态栏档位标签：off 覆盖 → 'off'；档位覆盖 → 档位名；
 * 无覆盖且 [thinking] 启用 → config 的 default_level（恒有值）；未启用 → undefined（不显示）。
 * default_level 仅在 enabled 时展示：未启用时构造默认不带 thinking 参数，展示了是撒谎。
 */
export function thinkStatusLabel(
  override: ThinkOverride | undefined,
  thinkingCfg?: ThinkingConfig,
): string | undefined {
  if (override === 'off') return 'off';
  if (override !== undefined) return override;
  return thinkingCfg?.enabled === true ? thinkingCfg.defaultLevel : undefined;
}

/**
 * /think 门控：当前渠道允许下发思考控制字段时才可用。
 *
 * 不按协议放行：阶跃三个接口都有思考强度参数（名字/层级不同，见 stepEffortParam），
 * 旧实现只放行 anthropic 会让 openai / openai_responses 渠道的 /think 被拒，而 provider
 * 工厂其实已在下发 effort——UI 与底层自相矛盾。现口径与工厂一致：sendThinking || enabled，不看协议。
 */
export function thinkingAvailable(providerName: string, thinkingCfg?: ThinkingConfig): boolean {
  const preset = PROVIDER_PRESETS[providerName];
  return preset !== undefined && (preset.sendThinking || thinkingCfg?.enabled === true);
}

/** 取当前生效的档位表（config 缺省时回落内置默认表，防御手工构造的配置对象）。 */
export function thinkLevelsOf(thinkingCfg?: ThinkingConfig): Record<ThinkingLevelName, number> {
  return thinkingCfg?.levels ?? DEFAULT_THINKING_LEVELS;
}

/** 可选档位名列表（弹层与报错提示共用，避免各处硬编码三个字符串）。 */
export const THINK_CHOICES: readonly ThinkingLevelName[] = THINKING_LEVEL_NAMES;

/**
 * 切档安全判定：档位对应的 budget 是否给正文留出 {@link THINKING_TEXT_MARGIN} 余量。
 *
 * 该判定保留，但依据已变：阶跃三接口不收 levels 数字，原依据「budget_tokens 占掉
 * max_tokens」不成立。但结论仍成立——high 档本身会让思考吃满 max_tokens 导致正文零输出，
 * 「切高档 + max_tokens 偏小」确实危险，警告该给。levels 数字的角色降级为档位思考量的
 * 估算刻度（不精确但单调性对得上，够排序风险）。off/undefined 恒安全；deficit 为正表示欠缺余量。
 */
export function thinkBudgetSafety(
  override: ThinkOverride | undefined,
  levels: Record<ThinkingLevelName, number>,
  maxTokens: number,
): { safe: boolean; deficit: number; budget: number } {
  const param = thinkStreamParam(override, levels);
  if (param === undefined || param === null || param.budgetTokens === undefined) {
    return { safe: true, deficit: 0, budget: 0 };
  }
  const budget = param.budgetTokens;
  const margin = maxTokens - budget;
  return { safe: margin >= THINKING_TEXT_MARGIN, deficit: Math.max(0, THINKING_TEXT_MARGIN - margin), budget };
}
