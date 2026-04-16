import { useState, useRef, useEffect } from 'react';
import { Search, Settings2 } from 'lucide-react';

interface ResearchFormProps {
  onSubmit: (topic: string, requirements: string) => void;
  isLoading: boolean;
}

export function ResearchForm({ onSubmit, isLoading }: ResearchFormProps) {
  const [topic, setTopic] = useState('');
  const [requirements, setRequirements] = useState('');
  const [showRequirements, setShowRequirements] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const reqTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [topic]);

  useEffect(() => {
    if (reqTextareaRef.current) {
      reqTextareaRef.current.style.height = 'auto';
      reqTextareaRef.current.style.height = `${reqTextareaRef.current.scrollHeight}px`;
    }
  }, [requirements]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (topic.trim() && !isLoading) {
      onSubmit(topic.trim(), requirements.trim());
    }
  };

  return (
    <div className="glass-panel" style={{ padding: '1.5rem' }}>
      <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Search size={20} className="text-primary" />
        新建研究目标
      </h2>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div>
          <textarea
            ref={textareaRef}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="例如：OpenAI Sora 长视频生成的技术原理与缺陷分析..."
            className="input-glass"
            style={{ 
              resize: 'none', 
              minHeight: '52px', 
              lineHeight: '1.4', 
              overflow: 'hidden' 
            }}
            disabled={isLoading}
            required
          />
        </div>

        {/* 详细要求折叠面板 */}
        <div>
          <button
            type="button"
            onClick={() => setShowRequirements(!showRequirements)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              fontSize: '0.85rem',
              padding: '0.25rem 0',
              transition: 'color 0.2s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--primary)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
          >
            <Settings2 size={14} />
            {showRequirements ? '收起详细要求' : '添加详细要求 (可选)'}
            {requirements && !showRequirements && (
              <span style={{
                background: 'var(--primary)',
                color: 'white',
                borderRadius: '10px',
                padding: '0 6px',
                fontSize: '0.7rem',
                lineHeight: '1.6',
              }}>已填写</span>
            )}
          </button>

          <div style={{
            maxHeight: showRequirements ? '300px' : '0',
            overflow: 'hidden',
            transition: 'max-height 0.3s ease, opacity 0.3s ease',
            opacity: showRequirements ? 1 : 0,
          }}>
            <textarea
              ref={reqTextareaRef}
              value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
              placeholder="例如：重点分析技术架构，用学术风格撰写，多用数据表格对比，不需要商业分析..."
              className="input-glass"
              style={{
                resize: 'none',
                minHeight: '68px',
                lineHeight: '1.4',
                overflow: 'hidden',
                marginTop: '0.5rem',
                fontSize: '0.9rem',
              }}
              disabled={isLoading}
            />
          </div>
        </div>

        <button 
          type="submit" 
          className="btn-primary" 
          disabled={isLoading || !topic.trim()}
          style={{ alignSelf: 'flex-start' }}
        >
          {isLoading ? (
            <>
              <div className="animate-spin" style={{ width: '16px', height: '16px', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%' }} />
              研究中...
            </>
          ) : (
            '开始深度研究'
          )}
        </button>
      </form>
    </div>
  );
}
