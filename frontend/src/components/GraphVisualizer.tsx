import { Brain, Search, FileText, ArrowRight, Radar } from 'lucide-react';

interface GraphVisualizerProps {
  phase: string;
  events: Array<{timestamp: string, phase: string, message: string}>;
  subTasks: string[];
}

export function GraphVisualizer({ phase, events, subTasks }: GraphVisualizerProps) {
  const isComplete = phase === 'done';


  const getPhaseStatus = (p: string) => {
    const phases = ['triage', 'planning', 'searching', 'synthesizing', 'done'];
    const currentIndex = phases.indexOf(phase === 'initializing' ? 'triage' : phase);
    const targetIndex = phases.indexOf(p);
    
    if (targetIndex < currentIndex) return 'completed';
    if (targetIndex === currentIndex) return 'active';
    return 'pending';
  };

  const PhaseIndicator = ({ id, label, icon: Icon }: any) => {
    const status = getPhaseStatus(id);
    const isActive = status === 'active';
    const isCompleted = status === 'completed' || isComplete;
    
    return (
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        gap: '0.75rem',
        opacity: status === 'pending' ? 0.4 : 1,
        transition: 'all 0.3s ease'
      }}>
        <div style={{
          width: '36px', height: '36px',
          borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: isActive ? 'var(--primary-light)' : isCompleted ? 'rgba(6, 182, 212, 0.2)' : 'rgba(255, 255, 255, 0.1)',
          border: `1px solid ${isActive ? 'var(--primary)' : isCompleted ? 'var(--secondary)' : 'var(--panel-border)'}`,
          color: isActive ? 'var(--primary)' : isCompleted ? 'var(--secondary)' : 'var(--text-muted)'
        }} className={isActive && !isComplete ? 'animate-pulse-slow' : ''}>
          <Icon size={18} />
        </div>
        <div>
          <div style={{ fontSize: '0.9rem', fontWeight: 600, color: isActive ? 'var(--text-main)' : 'var(--text-muted)' }}>
            {label}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {status === 'completed' ? '已完成' : status === 'active' ? '进行中' : '等待中'}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="glass-panel" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <h2 style={{ fontSize: '1.25rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Brain size={20} className="text-secondary" />
        智能体执行雷达图
      </h2>
      
      {/* Node Status */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <PhaseIndicator id="triage" label="Triage Scout (哨兵侦察员)" icon={Radar} />
        <PhaseIndicator id="planning" label="Orchestrator (主控规划师)" icon={Brain} />
        <PhaseIndicator id="searching" label="Search Agents (自纠错搜索智能体)" icon={Search} />
        <PhaseIndicator id="synthesizing" label="Synthesizer (综合撰稿人)" icon={FileText} />
      </div>
      
      {/* Dynamic Subtasks during search */}
      {subTasks.length > 0 && (
        <div style={{ 
          background: 'rgba(0,0,0,0.2)', 
          borderRadius: 'var(--radius-md)', 
          padding: '1rem',
          border: '1px solid var(--panel-border)'
        }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.75rem', color: 'var(--text-muted)' }}>
            并发搜索子任务 ({subTasks.length})
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {subTasks.map((task, idx) => (
              <li key={idx} style={{ 
                fontSize: '0.85rem', 
                display: 'flex', 
                alignItems: 'flex-start', 
                gap: '0.5rem',
                color: 'var(--text-main)'
              }}>
                <ArrowRight size={14} style={{ marginTop: '0.2rem', flexShrink: 0, color: 'var(--secondary)' }} />
                <span>{task}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Event Logs */}
      <div style={{ 
        flex: 1, 
        background: '#05050f', 
        borderRadius: 'var(--radius-md)', 
        padding: '1rem', 
        fontFamily: 'JetBrains Mono',
        fontSize: '0.8rem',
        overflowY: 'auto',
        maxHeight: '200px',
        border: '1px solid var(--panel-border)'
      }}>
        {events.map((evt, idx) => (
          <div key={idx} style={{ marginBottom: '0.5rem', opacity: 0.8 }}>
            <span style={{ color: 'var(--text-muted)' }}>[{new Date(evt.timestamp).toLocaleTimeString()}]</span>
            <span style={{ color: 'var(--primary)', marginLeft: '0.5rem' }}>[{evt.phase}]</span>
            <span style={{ marginLeft: '0.5rem' }}>{evt.message}</span>
          </div>
        ))}
        {events.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>等待执行...</div>
        )}
      </div>
    </div>
  );
}
