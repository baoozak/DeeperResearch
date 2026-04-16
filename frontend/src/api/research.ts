// API types and SSE handler
export interface ResearchResponse {
  topic: string;
  draft: string;
  sources: Array<{title: string, url: string, snippet: string}>;
  revision_count: number;
  phase_events: Array<{timestamp: string, phase: string, message: string}>;
}

export interface StreamEvent {
  type: 'phase' | 'event' | 'sub_tasks' | 'search_result' | 'result' | 'error';
  data: any;
}

/**
 * Connect to SSE endpoint and stream research events
 */
export function streamResearch(
  topic: string,
  requirements: string,
  onEvent: (event: StreamEvent) => void,
  onComplete: () => void,
  onError: (error: Error) => void
) {
  const abortController = new AbortController();
  
  fetch('http://localhost:8000/api/research/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ topic, requirements }),
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
      buffer = lines.pop() || ''; // keep the last partial line in buffer

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
