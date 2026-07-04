import { createHash, randomUUID } from 'crypto';
import { getActiveContext } from '../tracer.js';
import { classifyError } from '../errors.js';
import type { TracelyxClient } from '../client.js';
import type { SpanPayload } from '../types.js';

const INSTRUMENTED = Symbol('tracelyx.instrumented');

interface MessageParam {
  role: string;
  content: string | unknown[];
}

interface ToolDefinition {
  name: string;
  [key: string]: unknown;
}

interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

interface CreateParams {
  model: string;
  messages: MessageParam[];
  system?: string | Array<{ type?: string; text?: string }>;
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDefinition[];
  [key: string]: unknown;
}

interface UsageData {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicResponse {
  content?: ContentBlock[];
  usage?: UsageData;
  [key: string]: unknown;
}

interface AnthropicMessages {
  create(params: CreateParams): Promise<AnthropicResponse>;
  [key: string | symbol]: unknown;
}

interface AnthropicLike {
  messages: AnthropicMessages;
}

function hashSystemPrompt(system: CreateParams['system']): string {
  const text = Array.isArray(system)
    ? system.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('')
    : (system ?? '');
  return createHash('md5').update(text).digest('hex');
}

export function instrumentAnthropic<T extends AnthropicLike>(
  client: T,
  tracelyxClient: TracelyxClient,
): T {
  if (client.messages[INSTRUMENTED]) return client;

  const originalCreate = client.messages.create.bind(client.messages);

  async function patchedCreate(params: CreateParams): Promise<AnthropicResponse> {
    const ctx = getActiveContext();
    const spanId = randomUUID();
    const traceId = ctx?.traceId ?? randomUUID();
    const parentSpanId = ctx?.spanId ?? null;
    const startTime = Date.now();

    const attributes: Record<string, unknown> = {
      'llm.model': params.model,
      'llm.temperature': params.temperature,
      'llm.system_prompt_hash': hashSystemPrompt(params.system),
    };

    if (params.tools && params.tools.length > 0) {
      attributes['agent.declared_tools'] = params.tools.map((t) => t.name);
    }

    let response: AnthropicResponse | undefined;
    let status: 'ok' | 'error' = 'ok';

    try {
      response = await originalCreate(params);
      attributes['llm.prompt_tokens'] = response.usage?.input_tokens;
      attributes['llm.completion_tokens'] = response.usage?.output_tokens;

      const toolUseBlock = response.content?.find(
        (block): block is ContentBlock & { name: string } =>
          block.type === 'tool_use' && typeof block['name'] === 'string',
      );
      if (toolUseBlock) {
        attributes['llm.tool_call_name'] = toolUseBlock['name'];
      }

      return response;
    } catch (error) {
      status = 'error';
      attributes['error.type'] = classifyError(error);
      if (error instanceof Error) {
        attributes['error.message'] = error.message;
        attributes['error.stack'] = error.stack;
        attributes['error.name'] = error.name;
      }
      throw error;
    } finally {
      const endTime = Date.now();
      const span: SpanPayload = {
        id: spanId,
        traceId,
        parentSpanId,
        name: 'anthropic.messages.create',
        kind: 'llm_call',
        startTime,
        endTime,
        durationMs: endTime - startTime,
        status,
        attributes,
        tenantId: ctx?.tenantId,
        inputPayload: JSON.stringify(params.messages),
        outputPayload: response?.content !== undefined ? JSON.stringify(response.content) : undefined,
        llmModel: params.model,
        promptTokens: response?.usage?.input_tokens,
        completionTokens: response?.usage?.output_tokens,
      };
      tracelyxClient.recordSpan(span);
    }
  }

  client.messages.create = patchedCreate as unknown as AnthropicMessages['create'];
  client.messages[INSTRUMENTED] = true;

  return client;
}
