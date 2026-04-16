import { useState } from 'react';
import { CheckCircle2, XCircle, ListChecks, MessageSquare } from 'lucide-react';

interface PlanReviewProps {
  subTasks: string[];
  reasoning: string;
  topic: string;
  onApprove: () => void;
  onReject: (feedback: string) => void;
  isLoading: boolean;
}

export function PlanReview({ subTasks, reasoning, topic, onApprove, onReject, isLoading }: PlanReviewProps) {
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);

  const handleReject = () => {
    if (showFeedback && feedback.trim()) {
      onReject(feedback.trim());
      setFeedback('');
      setShowFeedback(false);
    } else {
      setShowFeedback(true);
    }
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
          调研方案审批
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
            <strong style={{ color: 'var(--primary)' }}>🧠 规划思路:</strong> {reasoning}
          </div>
        )}

        {/* 子任务列表 */}
        <h3 style={{ fontSize: '1.1rem', marginBottom: '1rem', color: 'var(--secondary)' }}>
          拟定子任务 ({subTasks.length})
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {subTasks.map((task, idx) => (
            <div
              key={idx}
              style={{
                display: 'flex',
                gap: '0.75rem',
                padding: '1rem',
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid var(--panel-border)',
                borderRadius: 'var(--radius-md)',
                alignItems: 'flex-start',
                transition: 'border-color 0.2s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--primary)')}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--panel-border)')}
            >
              <span style={{
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
                flexShrink: 0,
              }}>
                {idx + 1}
              </span>
              <span style={{ fontSize: '0.95rem', lineHeight: '1.5', color: 'var(--text-main)' }}>
                {task}
              </span>
            </div>
          ))}
        </div>

        {/* 反馈输入区 */}
        {showFeedback && (
          <div style={{ marginTop: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              <MessageSquare size={14} />
              请说明你的修改意见:
            </div>
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
              }}
              disabled={isLoading}
              autoFocus
            />
          </div>
        )}
      </div>

      {/* Footer: 按钮  */}
      <div style={{
        padding: '1.5rem',
        borderTop: '1px solid var(--panel-border)',
        display: 'flex',
        gap: '0.75rem',
        justifyContent: 'flex-end',
      }}>
        <button
          onClick={handleReject}
          disabled={isLoading || (showFeedback && !feedback.trim())}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            background: 'rgba(244, 63, 94, 0.1)',
            border: '1px solid rgba(244, 63, 94, 0.4)',
            color: '#f43f5e',
            padding: '0.6rem 1.2rem',
            borderRadius: 'var(--radius-md)',
            fontSize: '0.9rem',
            cursor: 'pointer',
            transition: 'all 0.2s',
            fontWeight: 500,
            opacity: isLoading ? 0.5 : 1,
          }}
        >
          {isLoading ? (
            <div className="animate-spin" style={{ width: '14px', height: '14px', border: '2px solid rgba(244,63,94,0.3)', borderTopColor: '#f43f5e', borderRadius: '50%' }} />
          ) : (
            <XCircle size={16} />
          )}
          {showFeedback ? '提交修改意见' : '不满意，修改'}
        </button>
        <button
          onClick={onApprove}
          disabled={isLoading}
          className="btn-primary"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            opacity: isLoading ? 0.5 : 1,
          }}
        >
          {isLoading ? (
            <div className="animate-spin" style={{ width: '14px', height: '14px', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%' }} />
          ) : (
            <CheckCircle2 size={16} />
          )}
          同意，开始调研
        </button>
      </div>
    </div>
  );
}
