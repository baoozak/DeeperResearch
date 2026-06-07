import { useState, useRef, useEffect } from 'react';
import { Brain, AlertCircle, Settings } from 'lucide-react';
import { ResearchForm } from './components/ResearchForm';
import { GraphVisualizer } from './components/GraphVisualizer';
import { ResultDisplay } from './components/ResultDisplay';
import { PlanReview } from './components/PlanReview';
import { streamPlan, streamExecute, type StreamEvent } from './api/research';
import { SettingsModal } from './components/SettingsModal';

function App() {
  const [topic, setTopic] = useState('');
  const [requirements, setRequirements] = useState('');
  const [searchEngine, setSearchEngine] = useState('domestic');
  const [uploadedContext, setUploadedContext] = useState('');
  const [isResearching, setIsResearching] = useState(false);
  const [error, setError] = useState('');

  // 设置面板状态
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isForceSettings, setIsForceSettings] = useState(false);

  // 初始化时强校验是否已配置密钥
  useEffect(() => {
    const checkSettings = async () => {
      const saved = localStorage.getItem('deeper_research_settings');
      let needsConfig = true;
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (parsed.llm_api_key && parsed.anysearch_api_key) {
            needsConfig = false;
          }
        } catch (e) {}
      }


      if (needsConfig) {
        // 本地没填，去后端查询是否已配有全局 Key (.env)
        try {
          const res = await fetch('http://localhost:8000/health');
          if (res.ok) {
            const data = await res.json();
            if (data.has_global_key === false) {
              // 后端没配且本地也没配，强制弹出
              setIsForceSettings(true);
              setIsSettingsOpen(true);
            }
          }
        } catch (err) {
          console.error("检查健康状态失败，默认弹出设置:", err);
          setIsForceSettings(true);
          setIsSettingsOpen(true);
        }
      }
    };
    checkSettings();
  }, []);


  // Graph State
  const [phase, setPhase] = useState('idle');
  const [events, setEvents] = useState<Array<{timestamp: string, phase: string, message: string}>>([]);
  const [subTasks, setSubTasks] = useState<string[]>([]);

  // Plan Review State (Human-in-the-Loop)
  const [planReady, setPlanReady] = useState(false);
  const [planReasoning, setPlanReasoning] = useState('');
  const [triageContext, setTriageContext] = useState('');

  // Result State
  const [draft, setDraft] = useState('');
  const [sources, setSources] = useState<Array<{title: string, url: string, snippet: string}>>([]);
  const [liveSources, setLiveSources] = useState<Array<{title: string, url: string, snippet: string}>>([]);

  const abortStreamRef = useRef<(() => void) | null>(null);

  // ===== Phase 1: 规划阶段 =====
  const handleStartResearch = (newTopic: string, newRequirements: string = '', newSearchEngine: string = 'domestic', newUploadedContext: string = '') => {
    // Reset state
    setTopic(newTopic);
    setRequirements(newRequirements);
    setSearchEngine(newSearchEngine);
    setUploadedContext(newUploadedContext);
    setIsResearching(true);
    setError('');
    setPhase('initializing');
    setEvents([]);
    setSubTasks([]);
    setDraft('');
    setSources([]);
    setLiveSources([]);
    setPlanReady(false);
    setPlanReasoning('');
    setTriageContext('');

    if (abortStreamRef.current) {
      abortStreamRef.current();
    }

    const abortStream = streamPlan(
      newTopic,
      newRequirements,
      '', // 首次无 feedback
      [], // 首次无 previous_plan
      newSearchEngine,
      newUploadedContext,
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
          case 'new_source':
            setLiveSources(prev => {
              if (prev.some(s => s.url === event.data.url)) return prev;
              return [...prev, event.data];
            });
            break;
          case 'sub_tasks':
            setSubTasks(event.data.sub_tasks);
            break;
          case 'plan_ready':
            setSubTasks(event.data.sub_tasks);
            setTriageContext(event.data.triage_context || '');
            setPlanReasoning(event.data.reasoning || '');
            setPlanReady(true);
            break;
          case 'error':
            setError(event.data.message);
            setIsResearching(false);
            break;
        }
      },
      () => {
        setIsResearching(false);
      },
      (err: Error) => {
        console.error("Plan stream error:", err);
        setError("连接错误: " + err.message);
        setIsResearching(false);
      }
    );

    abortStreamRef.current = abortStream;
  };

  // ===== Phase 2: 用户同意 → 执行搜索+撰稿 =====
  const handleApprovePlan = (approvedTasks: string[]) => {
    setPlanReady(false);
    setIsResearching(true);
    setPhase('searching');
    setSubTasks(approvedTasks); // 更新左侧界面展示的任务
    setLiveSources([]);

    if (abortStreamRef.current) {
      abortStreamRef.current();
    }

    const abortStream = streamExecute(
      topic,
      approvedTasks, // 这里带入用户改过的任务列表
      requirements,
      triageContext,
      searchEngine,
      uploadedContext,
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
          case 'search_result':
            setEvents(prev => [...prev, {
              timestamp: new Date().toISOString(),
              phase: 'searching',
              message: `✅ 任务汇总: ${event.data.sub_task} (提炼了 ${event.data.source_count} 个信息源)`
            }]);
            break;
          case 'new_source':
            setLiveSources(prev => {
              // 排重
              if (prev.some(s => s.url === event.data.url)) return prev;
              return [...prev, event.data];
            });
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
        console.error("Execute stream error:", err);
        setError("连接错误: " + err.message);
        setIsResearching(false);
      }
    );

    abortStreamRef.current = abortStream;
  };

  // ===== 用户不同意 → 携带反馈重规划 =====
  const handleRejectPlan = (feedback: string) => {
    setPlanReady(false);
    setIsResearching(true);
    setPhase('planning');

    // 保存当前子任务作为 previous_plan
    const previousPlan = [...subTasks];

    if (abortStreamRef.current) {
      abortStreamRef.current();
    }

    const abortStream = streamPlan(
      topic,
      requirements,
      feedback,
      previousPlan,
      searchEngine,
      uploadedContext,
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
          case 'plan_ready':
            setSubTasks(event.data.sub_tasks);
            setPlanReasoning(event.data.reasoning || '');
            setPlanReady(true);
            break;
          case 'error':
            setError(event.data.message);
            setIsResearching(false);
            break;
        }
      },
      () => {
        setIsResearching(false);
      },
      (err: Error) => {
        console.error("Replan stream error:", err);
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

  // 判断右侧面板应该显示什么
  const renderRightPanel = () => {
    // 审批阶段：显示调研方案审批
    if (planReady && phase === 'plan_review') {
      return (
        <PlanReview
          subTasks={subTasks}
          reasoning={planReasoning}
          topic={topic}
          onApprove={handleApprovePlan}
          onReject={handleRejectPlan}
          isLoading={isResearching}
        />
      );
    }
    // 其他阶段：显示报告
    return (
      <ResultDisplay
        topic={topic}
        draft={draft}
        sources={sources}
        events={events}
        liveSources={liveSources}
        phase={phase}
      />
    );
  };

  return (
    <div className="app-container">
      {/* Header */}
      <header className="header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--primary-light)', color: 'var(--primary)', width: '48px', height: '48px', borderRadius: 'var(--radius-md)' }}>
            <Brain size={28} />
          </div>
          <div>
            <h1 className="header-title">DeeperResearch</h1>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', margin: 0 }}>多智能体 AI 研究系统</p>
          </div>
        </div>

        {/* 顶部设置按钮 */}
        <button
          onClick={() => {
            setIsForceSettings(false);
            setIsSettingsOpen(true);
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            background: 'rgba(255, 255, 255, 0.05)',
            border: '1px solid var(--panel-border)',
            color: 'var(--text-main)',
            padding: '0.55rem 0.9rem',
            borderRadius: '8px',
            fontSize: '0.88rem',
            cursor: 'pointer',
            fontWeight: 500,
            transition: 'all 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--primary)';
            e.currentTarget.style.background = 'rgba(99, 102, 241, 0.08)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--panel-border)';
            e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
          }}
        >
          <Settings size={16} />
          <span>研究设置</span>
        </button>
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

        {/* Right Panel: Plan Review or Report */}
        <div className="right-panel">
          {renderRightPanel()}
        </div>
      </main>

      <SettingsModal 
        isOpen={isSettingsOpen} 
        onClose={() => setIsSettingsOpen(false)} 
        isForce={isForceSettings} 
      />

    </div>
  );
}

export default App;
