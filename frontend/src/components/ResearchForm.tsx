import { useState, useRef, useEffect } from 'react';
import { Search } from 'lucide-react';

interface ResearchFormProps {
  onSubmit: (topic: string) => void;
  isLoading: boolean;
}

export function ResearchForm({ onSubmit, isLoading }: ResearchFormProps) {
  const [topic, setTopic] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'; // Reset height
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`; // Set to scrollHeight
    }
  }, [topic]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (topic.trim() && !isLoading) {
      onSubmit(topic.trim());
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
