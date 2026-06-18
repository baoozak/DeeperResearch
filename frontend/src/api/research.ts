// API types and SSE handler
export interface ResearchResponse {
  topic: string;
  draft: string;
  sources: Array<{title: string, url: string, snippet: string}>;
  revision_count: number;
  phase_events: Array<{timestamp: string, phase: string, message: string}>;
}

export interface StreamEvent {
  type: 'phase' | 'event' | 'sub_tasks' | 'search_result' | 'result' | 'error' | 'plan_ready' | 'new_source';
  data: any;
}

export interface UploadResult {
  filename: string;
  markdown: string;
  char_count: number;
  truncated: boolean;
}

/**
 * 辅助函数：从 localStorage 中读取用户的自定义 API Key 等配置，并构建透传 Headers
 */
function _buildConfigHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const saved = localStorage.getItem('deeper_research_settings');
  if (saved) {
    try {
      const settings = JSON.parse(saved);
      if (settings.llm_api_key) headers['x-llm-api-key'] = settings.llm_api_key;
      if (settings.llm_base_url) headers['x-llm-base-url'] = settings.llm_base_url;
      if (settings.llm_model) headers['x-llm-model'] = settings.llm_model;
      if (settings.anysearch_api_key) headers['x-anysearch-api-key'] = settings.anysearch_api_key;
      
      // 注入三个研究参数
      if (settings.max_sub_tasks) headers['x-max-sub-tasks'] = String(settings.max_sub_tasks);
      if (settings.max_search_results) headers['x-max-search-results'] = String(settings.max_search_results);
      if (settings.max_search_review_retries !== undefined) headers['x-max-search-review-retries'] = String(settings.max_search_review_retries);
    } catch (e) {
      console.error("解析本地设置失败:", e);
    }
  }
  return headers;
}


/**
 * 文件上传: 将各种格式文件转换为 Markdown
 */
export async function uploadFile(file: File): Promise<UploadResult> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('http://localhost:8000/api/upload', {
    method: 'POST',
    headers: _buildConfigHeaders(), // 透传 API Key，供可能用到的多模态处理
    body: formData,
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({ detail: '上传失败' }));
    throw new Error(detail.detail || `上传失败: ${response.status}`);
  }

  return response.json();
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

  const headers = {
    'Content-Type': 'application/json',
    ..._buildConfigHeaders() // 注入用户本地大模型与检索 API 配置
  };

  fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body),
    signal: abortController.signal
  })
.then(async response => {
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    if (!response.body) {
      throw new Error("No response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEventStr = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        onComplete();
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let lines = buffer.split('\n');
      buffer = lines.pop() || '';

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
  searchEngine: string,
  uploadedContext: string,
  onEvent: (event: StreamEvent) => void,
  onComplete: () => void,
  onError: (error: Error) => void
) {
  return _streamSSE(
    'http://localhost:8000/api/research/plan',
    { topic, requirements, feedback, previous_plan: previousPlan, search_engine: searchEngine, uploaded_context: uploadedContext },
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
  searchEngine: string,
  uploadedContext: string,
  onEvent: (event: StreamEvent) => void,
  onComplete: () => void,
  onError: (error: Error) => void
) {
  return _streamSSE(
    'http://localhost:8000/api/research/execute',
    { topic, sub_tasks: subTasks, requirements, triage_context: triageContext, search_engine: searchEngine, uploaded_context: uploadedContext },
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
