import { useState, useRef, useEffect } from 'react';
import { Brain, AlertCircle } from 'lucide-react';
import { ResearchForm } from './components/ResearchForm';
import { GraphVisualizer } from './components/GraphVisualizer';
import { ResultDisplay } from './components/ResultDisplay';
import { streamResearch, type StreamEvent } from './api/research';

function App() {
  const [topic, setTopic] = useState('');
  const [isResearching, setIsResearching] = useState(false);
  const [error, setError] = useState('');
  
  // Graph State
  const [phase, setPhase] = useState('idle');
  const [events, setEvents] = useState<Array<{timestamp: string, phase: string, message: string}>>([]);
  const [subTasks, setSubTasks] = useState<string[]>([]);
  
  // Result State
  const [draft, setDraft] = useState('');
  const [sources, setSources] = useState<Array<{title: string, url: string, snippet: string}>>([]);

  const abortStreamRef = useRef<(() => void) | null>(null);

  const handleStartResearch = (newTopic: string) => {
    // Reset state
    setTopic(newTopic);
    setIsResearching(true);
    setError('');
    setPhase('initializing');
    setEvents([]);
    setSubTasks([]);
    setDraft('');
    setSources([]);

    // Cancel any existing stream
    if (abortStreamRef.current) {
      abortStreamRef.current();
    }

    const abortStream = streamResearch(
      newTopic,
      (event: StreamEvent) => {
        switch (event.type) {
          case 'phase':
            setPhase(event.data.phase);
            if (event.data.message) {
              setEvents(prev => [...prev, {
                timestamp: new Date().toISOString(),
                phase: event.data.phase,
                message: event.data.message
              }]);
            }
            break;
            
          case 'event':
            setEvents(prev => [...prev, event.data]);
            break;
            
          case 'sub_tasks':
            setSubTasks(event.data.sub_tasks);
            break;
            
          case 'result':
            setDraft(event.data.draft);
            setSources(event.data.sources || []);
            break;
            
          case 'error':
            setError(event.data.message);
            setIsResearching(false);
            break;
        }
      },
      () => {
        setIsResearching(false);
        setPhase('done');
      },
      (err: Error) => {
        console.error("Stream error:", err);
        setError("连接错误: " + err.message);
        setIsResearching(false);
      }
    );

    abortStreamRef.current = abortStream;
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortStreamRef.current) {
        abortStreamRef.current();
      }
    };
  }, []);

  // 初始化时从本地存储恢复上一次的研究结果
  useEffect(() => {
    const saved = localStorage.getItem('langraph_last_research');
    if (saved) {
      try {
        const data = JSON.parse(saved);
        setTopic(data.topic || '');
        setDraft(data.draft || '');
        setSources(data.sources || []);
        setSubTasks(data.subTasks || []);
        setEvents(data.events || []);
        if (data.draft) setPhase('done');
      } catch (e) {
        console.error("Failed to restore research:", e);
      }
    }
  }, []);

  // 当研究完成且报告生成时，自动保存整个状态到浏览器缓存
  useEffect(() => {
    if (phase === 'done' && draft && topic) {
      localStorage.setItem('langraph_last_research', JSON.stringify({
        topic,
        draft,
        sources,
        subTasks,
        events
      }));
    }
  }, [phase, draft, topic, sources, subTasks, events]);

  return (
    <div className="app-container">
      {/* Header */}
      <header className="header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--primary-light)', color: 'var(--primary)', width: '48px', height: '48px', borderRadius: 'var(--radius-md)' }}>
          <Brain size={28} />
        </div>
        <div>
          <h1 className="header-title">DeeperResearch</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', margin: 0 }}>多智能体 AI 研究系统</p>
        </div>
      </header>

      {/* Main Layout */}
      <main className="main-content">
        {/* Left Panel: Form & State Visualizer */}
        <div className="left-panel">
          <ResearchForm onSubmit={handleStartResearch} isLoading={isResearching} />
          
          {error && (
            <div style={{ padding: '1rem', background: 'rgba(244, 63, 94, 0.1)', border: '1px solid var(--accent)', borderRadius: 'var(--radius-md)', color: 'var(--accent)', display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <AlertCircle size={20} style={{ flexShrink: 0 }} />
              <div style={{ fontSize: '0.9rem' }}>{error}</div>
            </div>
          )}

          {(isResearching || phase !== 'idle') && (
            <GraphVisualizer phase={phase} events={events} subTasks={subTasks} />
          )}
        </div>

        {/* Right Panel: Markdown Report & Sources */}
        <div className="right-panel">
          <ResultDisplay 
            topic={topic}
            draft={draft}
            sources={sources}
          />
        </div>
      </main>
    </div>
  );
}

export default App;
