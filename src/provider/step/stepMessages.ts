import Anthropic from '@anthropic-ai/sdk';
import { buildSystemBlocks, prepareMessages, withToolCacheControl } from '../prepare.js';
import type { ChatProvider, ThinkingParam } from '../types.js';
import { stepEffortParam } from './stepCommon.js';

/** {@link StepMessagesProvider} 构造参数。 */
export interface StepMessagesProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  /**
   * 是否允许发送思考控制字段。默认 false。
   * 为 true 时也仅是开关打开：实际发不发还看 thinking 参数是否给出（见 stream）。
   */
  sendThinking?: boolean;
  /** 思考强度，由工厂从 [thinking] 配置注入；本类只用其中的 level（档位名直接作 effort 值）。 */
  thinking?: ThinkingParam;
  /**
   * 是否注入 cache_control。默认 false——Step 全通道实测不兼容该字段。
   * 与 AnthropicMessagesProvider 的默认值（true）相反，因为那个类要服务 Anthropic 官方。
   */
  sendCacheControl?: boolean;
}

/**
 * 阶跃星辰 Messages 接口（`/v1/messages`）专用 provider。
 *
 * 不复用 AnthropicMessagesProvider：Step Messages 声明兼容，但思考控制参数不兼容——
 * 官方 `thinking.budget_tokens` 在 Step 上接受但静默无效，Step 要的是 effort。
 * 这类「静默无效」无法靠报错发现，只能显式适配，故单独成类。
 * 只发 effort，绝不同发 thinking（实测同发比单发更差）。effort 落点见 {@link stepEffortParam}。
 *
 * 与官方类的差异：sendCacheControl 默认 false（Step 不兼容）；max_tokens 必填（不发返回 400）。
 */
export class StepMessagesProvider implements ChatProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  readonly maxTokens: number;
  private readonly sendThinking: boolean;
  private readonly thinking?: ThinkingParam;
  private readonly sendCacheControl: boolean;

  constructor(options: StepMessagesProviderOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey, baseURL: options.baseUrl });
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.sendThinking = options.sendThinking ?? false;
    this.thinking = options.thinking;
    this.sendCacheControl = options.sendCacheControl ?? false;
  }

  /**
   * 发起一次流式补全。
   *
   * thinking 参数沿用三态语义（与 ChatProvider 接口一致）：undefined 用构造默认、
   * 对象本次覆盖、null 本次强制不发。档位名由 {@link stepEffortParam} 落成
   * `output_config.effort` 字段。
   *
   * 档位缺失（level 为 undefined）时不发 effort。这条路径现在很难走到：配置层的
   * default_level 恒有值（缺省 medium）。之所以保留，是因为「不发 effort」在语义上
   * 不等于任何一档——实测它等于跑最高思考量，不能拿它当某一档的同义写法。
   */
  stream(params: {
    system: string;
    tools: Anthropic.Tool[];
    messages: Anthropic.MessageParam[];
    signal?: AbortSignal;
    model?: string;
    thinking?: ThinkingParam | null;
  }): ReturnType<Anthropic['messages']['stream']> {
    const body: Anthropic.MessageStreamParams = {
      model: params.model ?? this.model,
      // Step Messages 的 max_tokens 为必填，缺省会 400，故无条件发送。
      max_tokens: this.maxTokens,
      system: buildSystemBlocks(params.system, this.sendCacheControl),
      tools: withToolCacheControl(params.tools, this.sendCacheControl),
      messages: prepareMessages(params.messages, this.sendCacheControl),
    };

    const thinking = params.thinking === undefined ? this.thinking : params.thinking;
    if (this.sendThinking && thinking !== null && thinking !== undefined) {
      // 档位名直接作为 effort 值；level 为 undefined 时 stepEffortParam 返回空对象，不发字段。
      Object.assign(body, stepEffortParam('messages', thinking.level));
    }

    return this.client.messages.stream(
      body,
      params.signal !== undefined ? { signal: params.signal } : undefined,
    );
  }
}
