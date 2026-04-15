import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, Link as LinkIcon, Download } from 'lucide-react';
import mermaid from 'mermaid';
import { useEffect, useRef } from 'react';

// 初始化主题为深色
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
});

const Mermaid = ({ chart }: { chart: string }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    const renderChart = async () => {
      if (containerRef.current && chart) {
        try {
          mermaid.mermaidAPI.reset();
          const id = `mermaid-${Math.random().toString(36).substring(7)}`;
          const { svg } = await mermaid.render(id, chart);
          containerRef.current.innerHTML = svg;
        } catch (error) {
          console.error("Mermaid 解析失败:", error);
          if (containerRef.current) {
            containerRef.current.innerHTML = `<div style="color: #f43f5e; background: rgba(0,0,0,0.2); padding: 1rem; border-radius: 8px; border: 1px solid rgba(244, 63, 94, 0.3); font-size: 0.8rem;">图表渲染错误，可能由于模型输出了不稳定的 Mermaid 语法。你可以点击下载按钮查看原始 Markdown。</div>`;
          }
        }
      }
    };
    renderChart();
  }, [chart]);

  return <div ref={containerRef} style={{ display: 'flex', justifyContent: 'center', margin: '1.5rem 0', overflowX: 'auto' }} />;
};

interface ResultDisplayProps {
  draft: string;
  topic: string;
  sources: Array<{title: string, url: string, snippet: string}>;
}

export function ResultDisplay({ draft, topic, sources }: ResultDisplayProps) {
  if (!draft && !topic) {
    return (
      <div className="glass-panel" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', flexDirection: 'column', gap: '1rem' }}>
        <FileText size={48} opacity={0.2} />
        <p>你的深度研究报告将会展示在这里。</p>
      </div>
    );
  }

  const handleDownload = () => {
    if (!draft) return;
    
    let content = draft;
    if (sources && sources.length > 0) {
      content += '\n\n---\n\n### 来源汇总\n';
      sources.forEach((s) => {
        content += `- [${s.title}](${s.url})\n`;
      });
    }

    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    
    // 生成安全的文件名
    const safeTopic = topic ? topic.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').substring(0, 30) : '研究报告';
    link.download = `深度研究记录-${safeTopic}.md`;
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="glass-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ 
        padding: '1.5rem', 
        borderBottom: '1px solid var(--panel-border)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline'
      }}>
        <h2 style={{ fontSize: '1.5rem', margin: 0, color: 'white' }}>{topic || '研究报告草稿'}</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {draft && (
            <button 
              onClick={handleDownload}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid var(--panel-border)',
                color: 'var(--text-main)',
                padding: '0.4rem 0.8rem',
                borderRadius: '6px',
                fontSize: '0.85rem',
                cursor: 'pointer',
                transition: 'border-color 0.2s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--primary)')}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--panel-border)')}
              title="下载为 Markdown 文件"
            >
              <Download size={16} />
              <span>下载报告</span>
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '2rem' }} className="markdown-body">
        {draft ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code(props: any) {
                const { children, className, node, ...rest } = props;
                const match = /language-(\w+)/.exec(className || '');
                if (match && match[1] === 'mermaid') {
                  return <Mermaid chart={String(children).replace(/\n$/, '')} />;
                }
                return (
                  <code className={className} {...rest}>
                    {children}
                  </code>
                );
              }
            }}
          >
            {draft}
          </ReactMarkdown>
        ) : (
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', color: 'var(--text-muted)', fontStyle: 'italic' }}>
            <div className="animate-pulse-slow" style={{ width: '8px', height: '8px', background: 'var(--primary)', borderRadius: '50%' }}></div>
            正在撰写报告中...
          </div>
        )}
      </div>

      {/* Sources Footer */}
      {sources && sources.length > 0 && (
        <div style={{ 
          padding: '1.5rem', 
          borderTop: '1px solid var(--panel-border)',
          background: 'rgba(0,0,0,0.2)',
          borderBottomLeftRadius: 'var(--radius-lg)',
          borderBottomRightRadius: 'var(--radius-lg)',
        }}>
          <h3 style={{ fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <LinkIcon size={16} className="text-secondary" />
            数据来源 ({sources.length})
          </h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {sources.map((s, idx) => (
              <a 
                key={idx} 
                href={s.url} 
                target="_blank" 
                rel="noreferrer"
                style={{
                  fontSize: '0.8rem',
                  padding: '0.3rem 0.6rem',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid var(--panel-border)',
                  borderRadius: '4px',
                  color: 'var(--text-main)',
                  textDecoration: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  maxWidth: '300px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
                title={s.title}
              >
                {new URL(s.url).hostname.replace('www.', '')}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
