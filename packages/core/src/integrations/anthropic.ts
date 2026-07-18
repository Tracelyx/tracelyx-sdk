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
  stream?: boolean;
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

export interface StreamBlock {
  type: string;
  [key: string]: unknown;
}

export interface StreamState {
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  blocks: StreamBlock[];
  partialJson: Record<number, string>;
  sawStop: boolean;
}

interface RawStreamEvent {
  type?: string;
  index?: number;
  message?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  content_block?: { type?: string; [key: string]: unknown };
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string };
  usage?: { output_tokens?: number };
}

export function newStreamState(): StreamState {
  return { blocks: [], partialJson: {}, sawStop: false };
}

export function accumulateStreamEvent(state: StreamState, event: RawStreamEvent): void {
  switch (event?.type) {
    case 'message_start':
      state.inputTokens = event.message?.usage?.input_tokens;
      if (event.message?.usage?.output_tokens !== undefined) {
        state.outputTokens = event.message.usage.output_tokens;
      }
      state.model = event.message?.model;
      break;
    case 'content_block_start':
      if (typeof event.index === 'number' && event.content_block) {
        state.blocks[event.index] = { ...event.content_block } as StreamBlock;
      }
      break;
    case 'content_block_delta': {
      if (typeof event.index !== 'number') break;
      const block = state.blocks[event.index];
      const delta = event.delta;
      if (!block || !delta) break;
      if (delta.type === 'text_delta') block.text = ((block.text as string) ?? '') + (delta.text ?? '');
      else if (delta.type === 'input_json_delta')
        state.partialJson[event.index] = (state.partialJson[event.index] ?? '') + (delta.partial_json ?? '');
      else if (delta.type === 'thinking_delta') block.thinking = ((block.thinking as string) ?? '') + (delta.thinking ?? '');
      else if (delta.type === 'signature_delta') block.signature = delta.signature;
      break;
    }
    case 'content_block_stop': {
      if (typeof event.index !== 'number') break;
      const raw = state.partialJson[event.index];
      const block = state.blocks[event.index];
      if (raw !== undefined && block) {
        try {
          block.input = JSON.parse(raw);
        } catch {
          /* keep partial JSON as-is on parse failure */
        }
      }
      break;
    }
    case 'message_delta':
      if (event.usage?.output_tokens !== undefined) state.outputTokens = event.usage.output_tokens;
      break;
    case 'message_stop':
      state.sawStop = true;
      break;
  }
}

function traceStream<S extends object>(
  stream: S,
  onDone: (state: StreamState, error: unknown) => void,
): S {
  const streamAsAny = stream as unknown as {
    [Symbol.asyncIterator]: () => AsyncIterableIterator<unknown>;
  };
  const getOriginalIterator = streamAsAny[Symbol.asyncIterator].bind(stream);
  streamAsAny[Symbol.asyncIterator] = async function* (): AsyncGenerator<unknown> {
    const state = newStreamState();
    let caught: unknown = null;
    try {
      // for-await propagates .return() to the upstream iterator when the consumer
      // breaks early, so an early break also closes the underlying HTTP read
      // (matches the SDK's native behavior — do not fight it).
      for await (const event of getOriginalIterator() as AsyncIterable<unknown>) {
        accumulateStreamEvent(state, event as never);
        yield event;
      }
    } catch (error) {
      caught = error;
      throw error;
    } finally {
      onDone(state, caught);
    }
  };
  return stream;
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

    const recordError = (error: unknown): void => {
      attributes['error.type'] = classifyError(error);
      if (error instanceof Error) {
        attributes['error.message'] = error.message;
        attributes['error.stack'] = error.stack;
        attributes['error.name'] = error.name;
      }
    };

    const emit = (fields: {
      status: 'ok' | 'error';
      endTime: number;
      outputPayload?: string;
      llmModel?: string;
      promptTokens?: number;
      completionTokens?: number;
    }): void => {
      const span: SpanPayload = {
        id: spanId,
        traceId,
        parentSpanId,
        name: 'anthropic.messages.create',
        kind: 'llm_call',
        startTime,
        endTime: fields.endTime,
        durationMs: fields.endTime - startTime,
        status: fields.status,
        attributes,
        tenantId: ctx?.tenantId,
        inputPayload: JSON.stringify(params.messages),
        outputPayload: fields.outputPayload,
        llmModel: fields.llmModel ?? params.model,
        promptTokens: fields.promptTokens,
        completionTokens: fields.completionTokens,
      };
      tracelyxClient.recordSpan(span);
    };

    // ── Streaming branch ──────────────────────────────────────────────
    if (params.stream === true) {
      attributes['llm.stream'] = true;
      let stream: AnthropicResponse;
      try {
        stream = await originalCreate(params);
      } catch (error) {
        recordError(error);
        emit({ status: 'error', endTime: Date.now() });
        throw error;
      }
      return traceStream(stream as unknown as object, (state, error) => {
        const content = state.blocks.filter(Boolean);
        const toolUse = content.find(
          (b): b is StreamBlock & { name: string } =>
            b.type === 'tool_use' && typeof b['name'] === 'string',
        );
        if (toolUse) attributes['llm.tool_call_name'] = toolUse['name'];
        attributes['llm.prompt_tokens'] = state.inputTokens;
        attributes['llm.completion_tokens'] = state.outputTokens;
        if (!state.sawStop) attributes['llm.stream_incomplete'] = true;

        let status: 'ok' | 'error' = 'ok';
        if (error) {
          status = 'error';
          recordError(error);
        }
        emit({
          status,
          endTime: Date.now(),
          outputPayload: JSON.stringify(content),
          llmModel: state.model ?? params.model,
          promptTokens: state.inputTokens,
          completionTokens: state.outputTokens,
        });
      }) as unknown as AnthropicResponse;
    }

    // ── Non-streaming branch (unchanged behavior) ─────────────────────
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
      recordError(error);
      throw error;
    } finally {
      emit({
        status,
        endTime: Date.now(),
        outputPayload:
          response?.content !== undefined ? JSON.stringify(response.content) : undefined,
        llmModel: params.model,
        promptTokens: response?.usage?.input_tokens,
        completionTokens: response?.usage?.output_tokens,
      });
    }
  }

  client.messages.create = patchedCreate as unknown as AnthropicMessages['create'];
  client.messages[INSTRUMENTED] = true;

  return client;
}
