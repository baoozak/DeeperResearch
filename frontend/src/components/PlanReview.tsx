import { useState, useEffect } from 'react';
import { CheckCircle2, ListChecks, MessageSquare, Trash2, Plus } from 'lucide-react';

interface PlanReviewProps {
  subTasks: string[];
  reasoning: string;
  topic: string;
  onApprove: (tasks: string[]) => void;
  onReject: (feedback: string) => void;
  isLoading: boolean;
}

export function PlanReview({ subTasks, reasoning, topic, onApprove, onReject, isLoading }: PlanReviewProps) {
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [editableTasks, setEditableTasks] = useState<string[]>([...subTasks]);

  useEffect(() => {
    setEditableTasks([...subTasks]);
  }, [subTasks]);

  const handleReject = () => {
    if (showFeedback && feedback.trim()) {
      onReject(feedback.trim());
      setFeedback('');
      setShowFeedback(false);
    } else {
      setShowFeedback(true);
    }
  };

  const handleTaskChange = (index: number, val: string) => {
    const newTasks = [...editableTasks];
    newTasks[index] = val;
    setEditableTasks(newTasks);
  };

  const handleTaskDelete = (index: number) => {
    const newTasks = [...editableTasks];
    newTasks.splice(index, 1);
    setEditableTasks(newTasks);
  };

  const handleTaskAdd = () => {
    setEditableTasks([...editableTasks, ""]);
  };

  return (
    <div className="glass-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{
        padding: '1.5rem',
        borderBottom: '1px solid var(--panel-border)',
      }}>
        <h2 style={{ fontSize: '1.5rem', margin: 0, color: 'white', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <ListChecks size={24} style={{ color: 'var(--primary)' }} />
          调研方案审批（可直接编辑）
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.5rem' }}>
          课题: {topic}
        </p>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '2rem' }}>
        {/* 规划思路 */}
        {reasoning && (
          <div style={{
            background: 'rgba(99, 102, 241, 0.1)',
            border: '1px solid rgba(99, 102, 241, 0.3)',
            borderRadius: 'var(--radius-md)',
            padding: '1rem',
            marginBottom: '1.5rem',
            fontSize: '0.9rem',
            color: 'var(--text-muted)',
            lineHeight: '1.6',
          }}>
            <strong style={{ color: 'var(--primary)' }}>🧠 AI 规划思路:</strong> {reasoning}
          </div>
        )}

        {/* 子任务列表 */}
        <h3 style={{ fontSize: '1.1rem', marginBottom: '1rem', color: 'var(--secondary)' }}>
          拟定子任务 ({editableTasks.length} 项)
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {editableTasks.map((task, idx) => (
            <div
              key={idx}
              style={{
                display: 'flex',
                gap: '0.75rem',
                padding: '0.75rem',
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid var(--panel-border)',
                borderRadius: 'var(--radius-md)',
                alignItems: 'flex-start',
                transition: 'all 0.2s',
              }}
              className="task-card"
            >
               {/* 仅保留序号 */}
              <div style={{ 
                background: 'var(--primary)', 
                color: 'white', 
                borderRadius: '50%', 
                width: '24px', 
                height: '24px', 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center', 
                fontSize: '0.75rem', 
                fontWeight: 600,
                marginTop: '0.4rem',
                flexShrink: 0
              }}>
                {idx + 1}
              </div>

              {/* 中间输入框 */}
              <textarea
                value={task}
                onChange={(e) => handleTaskChange(idx, e.target.value)}
                disabled={isLoading}
                placeholder="在此输入子任务内容..."
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-main)',
                  fontSize: '0.95rem',
                  lineHeight: '1.5',
                  resize: 'none',
                  outline: 'none',
                  minHeight: '60px',
                  fontFamily: 'inherit',
                  marginTop: '0.2rem',
                }}
              />

              {/* 右侧删除按钮 */}
              <button
                onClick={() => handleTaskDelete(idx)}
                disabled={isLoading || editableTasks.length <= 1}
                title="删除该任务"
                style={{
                  background: 'none',
                  border: 'none',
                  color: editableTasks.length <= 1 ? 'transparent' : 'rgba(244, 63, 94, 0.7)',
                  cursor: editableTasks.length <= 1 ? 'default' : 'pointer',
                  padding: '0.4rem',
                  marginTop: '0.2rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {editableTasks.length > 1 && <Trash2 size={16} />}
              </button>
            </div>
          ))}

          {/* 添加按钮 */}
          <button
            onClick={handleTaskAdd}
            disabled={isLoading}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              padding: '0.75rem',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px dashed var(--panel-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-muted)',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              fontSize: '0.9rem',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => { if(!isLoading) { e.currentTarget.style.color = 'var(--text-main)'; e.currentTarget.style.borderColor = 'var(--text-muted)'; } }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--panel-border)'; }}
          >
            <Plus size={16} /> 新增研究子任务
          </button>
        </div>

        {/* 仍保留重生成的反馈口，以防用户想要推倒重来 */}
        <div style={{ marginTop: '2.5rem', paddingTop: '1.5rem', borderTop: '1px dashed var(--panel-border)' }}>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            提示：你可以直接在上方编辑具体任务。如果你对整体方向完全不满意，也可以在下方输入要求让 AI 重新规划：
          </p>
          {showFeedback ? (
            <div>
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="例如：去掉商业分析方面的子任务，增加一个关于技术架构对比的..."
                className="input-glass"
                style={{
                  resize: 'none',
                  minHeight: '80px',
                  lineHeight: '1.4',
                  fontSize: '0.9rem',
                  marginBottom: '1rem'
                }}
                disabled={isLoading}
                autoFocus
              />
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                 <button 
                   onClick={() => setShowFeedback(false)}
                   style={{ background: 'none', border: '1px solid var(--panel-border)', color: 'var(--text-muted)', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }}
                 >取消</button>
                 <button 
                   onClick={handleReject}
                   disabled={!feedback.trim() || isLoading}
                   style={{ background: 'rgba(244, 63, 94, 0.2)', border: '1px solid rgba(244, 63, 94, 0.5)', color: '#f43f5e', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }}
                 >发送指令，让 AI 重新生成</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowFeedback(true)}
              disabled={isLoading}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                background: 'none',
                border: '1px dashed var(--panel-border)',
                color: 'var(--text-muted)',
                padding: '0.6rem 1rem',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.85rem',
                cursor: 'pointer',
              }}
            >
              <MessageSquare size={14} /> 呼叫 AI 重新规划编排...
            </button>
          )}
        </div>
      </div>

      {/* Footer: 确认按钮  */}
      <div style={{
        padding: '1.5rem',
        borderTop: '1px solid var(--panel-border)',
        display: 'flex',
        gap: '0.75rem',
        justifyContent: 'flex-end',
      }}>
        <button
          onClick={() => onApprove(editableTasks.filter(t => t.trim() !== ''))}
          disabled={isLoading || editableTasks.filter(t => t.trim() !== '').length === 0}
          className="btn-primary"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            opacity: isLoading ? 0.5 : 1,
            padding: '0.8rem 1.5rem',
            fontSize: '1rem',
          }}
        >
          {isLoading ? (
            <div className="animate-spin" style={{ width: '16px', height: '16px', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%' }} />
          ) : (
            <CheckCircle2 size={18} />
          )}
          同意上面 {editableTasks.filter(t => t.trim() !== '').length} 个任务，开始深度执行
        </button>
      </div>
    </div>
  );
}
