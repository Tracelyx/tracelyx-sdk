export { TracelyxClient } from './client.js';
export { Trace, Span, getActiveContext, runWithContext, parseTraceparent } from './tracer.js';
export type {
  TracelyxClientOptions,
  StartTraceOptions,
  TraceSpanOptions,
  SpanPayload,
  TracePayload,
  SpanKind,
  SpanStatus,
} from './types.js';
export { instrumentAnthropic } from './integrations/anthropic.js';
export { instrumentLangGraph } from './integrations/langgraph.js';
export { instrumentOpenAIAgents } from './integrations/openai-agents.js';
export { OtlpExporter, type OtlpOptions } from './otlp.js';
export { classifyError } from './errors.js';
export type { ErrorType } from './errors.js';
