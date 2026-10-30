import Anthropic from '@anthropic-ai/sdk';
import type { RemoteProvider, TransformRequest, TransformVariant } from './types.js';

export interface ClaudeProviderOptions {
  apiKey: string;
  /** Defaults to Claude Opus 5.5. */
  model?: string;
  /**
   * Opus 5.5 defaults to `medium` effort. Rewriting one sentence does not need
   * that much deliberation, and this tier is in front of a waiting user, so the
   * default here is `low`.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Call the API straight from the page. Convenient for a local build, but it
   * ships the key to the browser — a deployed build should point `baseURL` at a
   * proxy that holds the key server-side instead.
   */
  allowBrowser?: boolean;
  baseURL?: string;
}

const SYSTEM = `You rewrite short passages of a user's own writing inside a writing editor.

Rules:
- Preserve the writer's meaning, claims, and facts exactly. Never add information.
- Keep the writer's voice. You are editing their sentence, not replacing it with yours.
- Match the surrounding context's register and tense.
- Return the rewritten span only, with no quotation marks and no preamble.
- Keep leading and trailing punctuation consistent with the original span.
- Give 2 or 3 genuinely different options, best first. If only one good rewrite exists, give one.
- Each note is at most 8 words and says what changed, not why it is better.`;

/** Instruction per transform kind, appended to the span and its context. */
function instructionFor(request: TransformRequest): string {
  switch (request.kind) {
    case 'rewrite':
      return 'Rewrite this to be clearer and easier to read.';
    case 'shorten':
      return 'Say this in noticeably fewer words without losing anything.';
    case 'expand':
      return 'Expand this with the detail a reader would need, without inventing facts.';
    case 'paraphrase':
      return 'Rephrase this with different wording and the same meaning.';
    case 'tone':
      return `Rewrite this so it reads as ${request.tone ?? 'neutral'}.`;
    case 'simplify':
      return 'Rewrite this in plainer words, at roughly an eighth-grade reading level.';
    case 'custom':
      return request.instruction ?? 'Improve this.';
  }
}

const VARIANTS_SCHEMA = {
  type: 'object',
  properties: {
    variants: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['text', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['variants'],
  additionalProperties: false,
} as const;

/**
 * Tier 3. Only runs when the user asks for a rewrite, never on a timer, so its
 * latency never lands in the typing path.
 */
export class ClaudeProvider implements RemoteProvider {
  readonly name = 'Claude';
  private readonly client: Anthropic | undefined;
  private readonly model: string;
  private readonly effort: NonNullable<ClaudeProviderOptions['effort']>;

  constructor(options: ClaudeProviderOptions) {
    this.model = options.model ?? 'claude-opus-5-5';
    this.effort = options.effort ?? 'low';
    this.client = options.apiKey
      ? new Anthropic({
          apiKey: options.apiKey,
          baseURL: options.baseURL,
          dangerouslyAllowBrowser: options.allowBrowser ?? false,
        })
      : undefined;
  }

  isConfigured(): boolean {
    return this.client !== undefined;
  }

  async transform(request: TransformRequest, signal?: AbortSignal): Promise<TransformVariant[]> {
    if (!this.client) throw new Error('Claude provider has no API key configured');

    const prompt = [
      request.context && request.context !== request.text
        ? `Surrounding paragraph, for context only:\n${request.context}`
        : undefined,
      `Span to rewrite:\n${request.text}`,
      instructionFor(request),
    ]
      .filter((part): part is string => part !== undefined)
      .join('\n\n');

    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 2000,
        system: SYSTEM,
        output_config: {
          effort: this.effort,
          format: { type: 'json_schema', schema: VARIANTS_SCHEMA },
        },
        messages: [{ role: 'user', content: prompt }],
      },
      { signal },
    );

    if (response.stop_reason === 'refusal') {
      throw new Error('Claude declined to rewrite this passage');
    }

    const text = response.content.find((block) => block.type === 'text');
    if (!text || text.type !== 'text') return [];

    const parsed = JSON.parse(text.text) as { variants: TransformVariant[] };
    return parsed.variants.filter((variant) => variant.text.trim().length > 0);
  }
}
