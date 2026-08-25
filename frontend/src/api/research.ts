// API types and SSE handler
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

export interface SourceRecord {
  title: string;
  url: string;
  snippet: string;
  evidence?: string;
  rank?: number | null;
  retrieved_at?: string;
  verified?: boolean;
  source_kind?: string;
}

export interface ResearchResponse {
  topic: string;
  draft: string;
  sources: SourceRecord[];
  phase_events: Array<{timestamp: string, phase: string, message: string}>;
  research_id?: string;
  version?: number;
}

export interface ResearchVersionSummary {
  id: number;
  research_id: string;
  version: number;
  kind: 'plan' | 'replan' | 'report' | 'resynthesis' | string;
  topic: string;
  plan: string[];
  sources: SourceRecord[];
  parent_version: number | null;
  created_at: string;
  report_preview?: string;
}

export interface ResearchVersion extends ResearchVersionSummary {
  report: string;
  research_results: Array<{ sub_task: string; content: string; source_count?: number }>;
  parameters: Record<string, unknown>;
}

export interface ResearchHistoryItem {
  id: string;
  topic: string;
  status: string;
  phase: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  latest_version: {
    version: number;
    kind: string;
    plan_count: number;
    source_count: number;
    has_report: boolean;
    created_at: string;
  } | null;
}

export type StreamEvent =
  | { type: 'phase'; data: { phase: string; message?: string; node?: string; research_id?: string } }
  | { type: 'event'; data: { timestamp: string; phase: string; message: string } }
  | { type: 'sub_tasks'; data: { sub_tasks: string[] } }
  | { type: 'search_result'; data: { sub_task: string; source_count: number } }
  | { type: 'result'; data: { topic: string; draft: string; sources: SourceRecord[]; version?: number; sub_tasks?: string[] } }
  | { type: 'error'; data: { message: string } }
  | { type: 'plan_ready'; data: { research_id: string; version?: number; sub_tasks: string[]; triage_context?: string; reasoning?: string } }
  | { type: 'new_source'; data: SourceRecord };

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

  const response = await fetch(`${API_BASE_URL}/api/upload`, {
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
  body: Record<string, unknown>,
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

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEventStr = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
          const dataStr = line.substring(5).trim();
          if (dataStr) {
            try {
              const data: unknown = JSON.parse(dataStr);
              onEvent({ type: currentEventStr as StreamEvent['type'], data } as StreamEvent);
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
  researchId: string | null,
  onEvent: (event: StreamEvent) => void,
  onComplete: () => void,
  onError: (error: Error) => void
) {
  return _streamSSE(
    `${API_BASE_URL}/api/research/plan`,
    { topic, requirements, feedback, previous_plan: previousPlan, search_engine: searchEngine, uploaded_context: uploadedContext, research_id: researchId },
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
  researchId: string | null,
  onEvent: (event: StreamEvent) => void,
  onComplete: () => void,
  onError: (error: Error) => void
) {
  return _streamSSE(
    `${API_BASE_URL}/api/research/execute`,
    { topic, sub_tasks: subTasks, requirements, triage_context: triageContext, search_engine: searchEngine, uploaded_context: uploadedContext, research_id: researchId },
    onEvent, onComplete, onError
  );
}

/** 从历史版本继续执行，复用已保存的研究计划。 */
export function streamResume(
  researchId: string,
  version: number | null,
  onEvent: (event: StreamEvent) => void,
  onComplete: () => void,
  onError: (error: Error) => void
) {
  return _streamSSE(
    `${API_BASE_URL}/api/research/${encodeURIComponent(researchId)}/resume`,
    { version },
    onEvent,
    onComplete,
    onError
  );
}

/** 基于保存的检索资料重新综合，不重复联网搜索。 */
export function streamResynthesize(
  researchId: string,
  version: number | null,
  requirements: string | null,
  onEvent: (event: StreamEvent) => void,
  onComplete: () => void,
  onError: (error: Error) => void
) {
  return _streamSSE(
    `${API_BASE_URL}/api/research/${encodeURIComponent(researchId)}/resynthesize`,
    { version, requirements },
    onEvent,
    onComplete,
    onError
  );
}

export async function fetchResearchHistory(limit = 50): Promise<ResearchHistoryItem[]> {
  const response = await fetch(`${API_BASE_URL}/api/research/history?limit=${limit}`);
  if (!response.ok) throw new Error(`读取研究历史失败: ${response.status}`);
  const data = await response.json() as { items: ResearchHistoryItem[] };
  return data.items;
}

export async function fetchResearchVersions(researchId: string): Promise<ResearchVersionSummary[]> {
  const response = await fetch(`${API_BASE_URL}/api/research/${encodeURIComponent(researchId)}/versions`);
  if (!response.ok) throw new Error(`读取研究版本失败: ${response.status}`);
  const data = await response.json() as { items: ResearchVersionSummary[] };
  return data.items;
}

export async function fetchResearchVersion(researchId: string, version: number): Promise<ResearchVersion> {
  const response = await fetch(`${API_BASE_URL}/api/research/${encodeURIComponent(researchId)}/versions/${version}`);
  if (!response.ok) throw new Error(`读取研究版本详情失败: ${response.status}`);
  return await response.json() as ResearchVersion;
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
    `${API_BASE_URL}/api/research/stream`,
    { topic, requirements },
    onEvent, onComplete, onError
  );
}
