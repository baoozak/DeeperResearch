// API types and SSE handler
export interface ResearchResponse {
  topic: string;
  draft: string;
  sources: Array<{title: string, url: string, snippet: string}>;
  revision_count: number;
  phase_events: Array<{timestamp: string, phase: string, message: string}>;
}

export interface StreamEvent {
  type: 'phase' | 'event' | 'sub_tasks' | 'search_result' | 'result' | 'error' | 'plan_ready';
  data: any;
}

/**
 * 通用 SSE 流式请求处理器
 */
function _streamSSE(
  url: string,
  body: Record<string, any>,
  onEvent: (event: StreamEvent) => void,
  onComplete: () => void,
  onError: (error: Error) => void
) {
  const abortController = new AbortController();

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: abortController.signal
  }).then(async response => {
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    if (!response.body) {
      throw new Error("No response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        onComplete();
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEventStr = '';
      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEventStr = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
          const dataStr = line.substring(5).trim();
          if (dataStr) {
            try {
              const data = JSON.parse(dataStr);
              onEvent({ type: currentEventStr as any, data });
            } catch (e) {
              console.error("Failed to parse SSE data", dataStr, e);
            }
          }
        }
      }
    }
  }).catch(error => {
    if (error.name !== 'AbortError') {
      onError(error);
    }
  });

  return () => abortController.abort();
}

/**
 * 规划阶段: 哨兵预搜 + 规划师拆解 → 等待用户审批
 */
export function streamPlan(
  topic: string,
  requirements: string,
  feedback: string,
  previousPlan: string[],
  onEvent: (event: StreamEvent) => void,
  onComplete: () => void,
  onError: (error: Error) => void
) {
  return _streamSSE(
    'http://localhost:8000/api/research/plan',
    { topic, requirements, feedback, previous_plan: previousPlan },
    onEvent, onComplete, onError
  );
}

/**
 * 执行阶段: 并发搜索 + 综合撰稿 (用户审批通过后调用)
 */
export function streamExecute(
  topic: string,
  subTasks: string[],
  requirements: string,
  triageContext: string,
  onEvent: (event: StreamEvent) => void,
  onComplete: () => void,
  onError: (error: Error) => void
) {
  return _streamSSE(
    'http://localhost:8000/api/research/execute',
    { topic, sub_tasks: subTasks, requirements, triage_context: triageContext },
    onEvent, onComplete, onError
  );
}

/**
 * 旧版一体化流式接口 (保留向后兼容)
 */
export function streamResearch(
  topic: string,
  requirements: string,
  onEvent: (event: StreamEvent) => void,
  onComplete: () => void,
  onError: (error: Error) => void
) {
  return _streamSSE(
    'http://localhost:8000/api/research/stream',
    { topic, requirements },
    onEvent, onComplete, onError
  );
}
