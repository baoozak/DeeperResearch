import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, Download, ChevronDown, ChevronUp, Globe } from 'lucide-react';
import mermaid from 'mermaid';
import { useEffect, useRef, useState } from 'react';

// 初始化深度定制的赛博暗色系主题
mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  securityLevel: 'loose',
  themeVariables: {
    fontFamily: 'Inter, system-ui, Avenir, Helvetica, Arial, sans-serif',
    primaryColor: 'rgba(79, 70, 229, 0.15)', // 透明靛蓝背景
    primaryTextColor: '#828282ff', // 文字
    primaryBorderColor: '#4f46e5', // 主色边框
    lineColor: '#818cf8', // 稍微提亮的线条
    secondaryColor: 'rgba(16, 185, 129, 0.1)', // 辅色用暗翡翠绿
    tertiaryColor: 'rgba(244, 63, 94, 0.1)', // 三级色用暗玫瑰红
    noteBkgColor: '#27272a', 
    noteTextColor: '#e4e4e7',
    noteBorderColor: '#3f3f46',
    background: 'transparent', // 设定透明背景更好地融入卡片
    clusterBkg: 'rgba(99, 102, 241, 0.03)',
    clusterBorder: 'rgba(99, 102, 241, 0.2)',
    // 节点默认边框曲率
  }
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
  events?: Array<{timestamp: string, phase: string, message: string}>;
  liveSources?: Array<{title: string, url: string, snippet: string}>;
  phase?: string;
}

export function ResultDisplay({ draft, topic, events, liveSources, phase }: ResultDisplayProps) {
  const [showThinking, setShowThinking] = useState(true);

  // 当报告生成完毕时，自动折叠思考过程；如果重新开始研究，则自动展开
  useEffect(() => {
    if (draft || phase === 'done') {
      setShowThinking(false);
    } else if (!draft && phase !== 'done') {
      setShowThinking(true);
    }
  }, [draft, phase]);

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
        
        {/* 顶部思考区域（无论是否有 draft 都会显示，生成后默认折叠） */}
        {(events?.length ? true : liveSources?.length ? true : !draft) && (
          <div className="thinking-container" style={{ margin: '0 auto 2rem auto', maxWidth: '800px', display: 'flex', flexDirection: 'column', gap: '1.5rem', background: 'rgba(0,0,0,0.2)', padding: '1.5rem', borderRadius: 'var(--radius-lg)', border: '1px solid var(--panel-border)' }}>
            <div 
              style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '1.05rem', color: 'var(--text-main)', cursor: 'pointer', userSelect: 'none', width: 'fit-content' }}
              onClick={() => setShowThinking(!showThinking)}
            >
              {!draft && <div className="animate-pulse-slow" style={{ width: '10px', height: '10px', background: 'var(--secondary)', borderRadius: '50%', boxShadow: '0 0 8px var(--secondary)' }}></div>}
              <span style={{ fontWeight: 600 }}>显示思考与检索过程</span>
              {showThinking ? <ChevronUp size={18} color="var(--text-muted)" /> : <ChevronDown size={18} color="var(--text-muted)" />}
            </div>

            {showThinking && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', borderLeft: '2px solid rgba(255, 255, 255, 0.05)', paddingLeft: '1.5rem', marginLeft: '0.25rem' }}>
                {events?.map((evt, idx) => (
                  <div key={idx} style={{ position: 'relative' }}>
                    <div style={{ position: 'absolute', left: '-1.89rem', top: '0.5rem', width: '11px', height: '11px', borderRadius: '50%', background: 'var(--bg-panel)', border: '2px solid var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} />
                    <p style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: '1.6' }}>
                      {evt.message}
                    </p>
                  </div>
                ))}
                
                {(!events || events.length === 0) && (
                   <p style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: '1.6' }}>
                      正在初始化执行环境，准备展开深度检索...
                   </p>
                )}

                {liveSources && liveSources.length > 0 && (
                  <div style={{ marginTop: '1rem', paddingTop: '1.5rem', borderTop: '1px dashed var(--panel-border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--secondary)', fontSize: '0.9rem', marginBottom: '1rem', fontWeight: 500 }}>
                      <Globe size={14} />
                      <span>Researching websites... ({liveSources.length})</span>
                    </div>
                    
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
                      {liveSources.slice().reverse().slice(0, 15).map((src, idx) => {
                        let domain = 'web';
                        try {
                           domain = new URL(src.url).hostname;
                        } catch(e) {}
                        return (
                          <a 
                            key={idx}
                            href={src.url} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '0.5rem',
                              padding: '0.4rem 0.8rem',
                              background: 'rgba(255, 255, 255, 0.05)',
                              border: '1px solid rgba(255,255,255,0.1)',
                              borderRadius: '20px',
                              fontSize: '0.8rem',
                              color: 'var(--text-main)',
                              textDecoration: 'none',
                              maxWidth: '260px',
                              transition: 'all 0.2s',
                              animation: 'fadeInUp 0.3s ease-out'
                            }}
                            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--secondary)'; e.currentTarget.style.background = 'rgba(99, 102, 241, 0.1)'; }}
                            onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                           <img 
                             src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`} 
                             alt="" 
                             style={{ width: '14px', height: '14px', borderRadius: '2px', filter: 'grayscale(0.5)' }} 
                             onError={(e) => { e.currentTarget.style.display = 'none'; }} 
                           />
                           <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                             {src.title || domain}
                           </span>
                          </a>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {draft && (
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
        )}
      </div>

    </div>
  );
}
