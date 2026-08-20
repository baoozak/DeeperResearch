import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, Download, ChevronDown, ChevronUp, Globe, RefreshCw, Check, X, FolderSync } from 'lucide-react';
import mermaid from 'mermaid';
import React, { useEffect, useRef, useState } from 'react';
import { API_BASE_URL, type SourceRecord } from '../api/research';

// ── Mermaid 暗色主题初始化 ──────────────────────────────
// 使用 base 主题 + 全面覆盖 themeVariables，彻底接管所有节点的颜色
const DARK_NODE_BG = '#0f172a';       // 节点背景 — 极深海军蓝
const DARK_NODE_BORDER = '#4f46e5';   // 节点边框 — 靛蓝色
const LIGHT_TEXT = '#e2e8f0';         // 节点文字 — 高对比度亮灰
const LINE_COLOR = '#6366f1';         // 连线颜色 — 靛蓝
const LABEL_BG = '#1e1b4b';          // 标签背景 — 深紫

mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  securityLevel: 'loose',
  themeVariables: {
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    fontSize: '14px',
    // 全局背景
    darkMode: true,
    background: 'transparent',
    mainBkg: DARK_NODE_BG,
    // 节点样式 — 覆盖所有 0~8 号色阶
    primaryColor: DARK_NODE_BG,
    primaryBorderColor: DARK_NODE_BORDER,
    primaryTextColor: LIGHT_TEXT,
    secondaryColor: DARK_NODE_BG,
    secondaryBorderColor: '#6366f1',
    secondaryTextColor: LIGHT_TEXT,
    tertiaryColor: DARK_NODE_BG,
    tertiaryBorderColor: '#818cf8',
    tertiaryTextColor: LIGHT_TEXT,
    // 连线
    lineColor: LINE_COLOR,
    // 文字
    textColor: LIGHT_TEXT,
    // 标签
    edgeLabelBackground: LABEL_BG,
    // 节点颜色 (0-8 全覆盖以拦截所有 classDef 变体)
    nodeBorder: DARK_NODE_BORDER,
    clusterBkg: 'rgba(15,23,42,0.6)',
    clusterBorder: '#334155',
    titleColor: '#f1f5f9',
    // 其他常见类型的节点覆盖
    noteTextColor: LIGHT_TEXT,
    noteBkgColor: DARK_NODE_BG,
    noteBorderColor: DARK_NODE_BORDER,
    // 类图
    classText: LIGHT_TEXT,
    // 状态图
    labelColor: LIGHT_TEXT,
    altBackground: DARK_NODE_BG,
  }
});

/**
 * 清洗 Mermaid 源码中所有 AI 自定义的颜色指令。
 * 目标：不管模型产出了什么 `style` / `classDef` / `fill` 声明，
 * 全部替换为统一的暗色方案，仅保留 stroke 的色相（但也降饱和度）。
 */
function sanitizeMermaidSource(raw: string): string {
  return raw
    // 1. 完整删除所有 classDef 行（它们通常定义亮色节点类）
    .replace(/^\s*classDef\s+.+$/gm, '')
    // 2. 完整删除所有 class 指令行（将节点绑定到 classDef）
    .replace(/^\s*class\s+\S+\s+\S+\s*$/gm, '')
    // 3. 删除 style 指令行中的颜色定义（style NodeId fill:#xxx,stroke:#yyy...）
    .replace(/^\s*style\s+\S+\s+.+$/gm, '')
    // 4. 兜底：将内联 fill 参数全部改为暗色（处理 :::  或 ::: 语法）
    .replace(/fill\s*:\s*#[0-9a-fA-F]{3,8}/g, `fill:${DARK_NODE_BG}`)
    .replace(/fill\s*:\s*rgb[a]?\([^)]+\)/g, `fill:${DARK_NODE_BG}`)
    .replace(/fill\s*:\s*[a-zA-Z]+(?=[,;\s\n])/g, `fill:${DARK_NODE_BG}`);
}

/**
 * 渲染后的终极保障：直接遍历 SVG DOM，
 * 强制修正所有节点图形和文字的内联 style 属性。
 * 这是最高优先级的覆盖，不受 CSS specificity 和 !important 限制。
 */
function forceRecolorSvg(container: HTMLElement): void {
  const svg = container.querySelector('svg');
  if (!svg) return;

  // 强制修正所有节点的图形元素（rect / polygon / circle / ellipse / path）
  const shapeSelectors = [
    'g.node rect', 'g.node polygon', 'g.node circle',
    'g.node ellipse', 'g.node path',
    '.node rect', '.node polygon', '.node circle',
    '.node ellipse', '.node path',
  ];
  svg.querySelectorAll(shapeSelectors.join(',')).forEach((el) => {
    const htmlEl = el as HTMLElement;
    htmlEl.style.fill = DARK_NODE_BG;
    htmlEl.style.fillOpacity = '0.95';
    htmlEl.style.stroke = DARK_NODE_BORDER;
    htmlEl.style.strokeWidth = '2px';
    // 同时清除 SVG 属性层级的 fill（比 CSS 优先级更高）
    el.setAttribute('fill', DARK_NODE_BG);
    el.setAttribute('stroke', DARK_NODE_BORDER);
  });

  // 强制修正所有节点内的文字
  svg.querySelectorAll('g.node text, .node text').forEach((el) => {
    const htmlEl = el as HTMLElement;
    htmlEl.style.fill = LIGHT_TEXT;
    htmlEl.style.fontWeight = '500';
    el.setAttribute('fill', LIGHT_TEXT);
  });

  // 强制修正标题文字
  svg.querySelectorAll('text.titleText, .title, text[class*="title"]').forEach((el) => {
    const htmlEl = el as HTMLElement;
    htmlEl.style.fill = '#f1f5f9';
    htmlEl.style.fontWeight = '600';
    el.setAttribute('fill', '#f1f5f9');
  });

  // 修正边标签的背景和文字
  svg.querySelectorAll('.edgeLabel rect').forEach((el) => {
    const htmlEl = el as HTMLElement;
    htmlEl.style.fill = LABEL_BG;
    htmlEl.style.opacity = '0.95';
    el.setAttribute('fill', LABEL_BG);
  });
  svg.querySelectorAll('.edgeLabel span, .edgeLabel text').forEach((el) => {
    const htmlEl = el as HTMLElement;
    htmlEl.style.color = '#cbd5e1';
    htmlEl.style.fill = '#cbd5e1';
    htmlEl.style.fontWeight = '500';
  });

  // 修正连线颜色
  svg.querySelectorAll('.edgePath path, .flowchart-link').forEach((el) => {
    const htmlEl = el as HTMLElement;
    htmlEl.style.stroke = 'rgba(99,102,241,0.45)';
    el.setAttribute('stroke', 'rgba(99,102,241,0.45)');
  });

  // 修正箭头颜色
  svg.querySelectorAll('marker path').forEach((el) => {
    const htmlEl = el as HTMLElement;
    htmlEl.style.fill = LINE_COLOR;
    el.setAttribute('fill', LINE_COLOR);
  });
}

const Mermaid = ({ chart }: { chart: string }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    const renderChart = async () => {
      if (containerRef.current && chart) {
        try {
          mermaid.mermaidAPI.reset();
          const id = `mermaid-${Math.random().toString(36).substring(7)}`;
          
          // 第一层防御：清洗源码中的自定义颜色
          const cleanChart = sanitizeMermaidSource(chart);

          const { svg } = await mermaid.render(id, cleanChart);
          containerRef.current.innerHTML = svg;

          // 第三层防御：直接操作 DOM，强制统一颜色（最高优先级）
          forceRecolorSvg(containerRef.current);
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

  return (
    <div className="mermaid-graph-wrapper" style={{ 
      display: 'flex', 
      flexDirection: 'column', 
      alignItems: 'center', 
      margin: '1.5rem auto', 
      overflowX: 'auto', 
      width: '100%', 
      maxWidth: '720px', 
      background: 'rgba(255, 255, 255, 0.015)', 
      border: '1px solid rgba(255, 255, 255, 0.06)',
      borderRadius: '8px',
      padding: '1.25rem',
      boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)'
    }}>
      {/* 第二层防御：CSS !important 兜底（处理动态添加的元素） */}
      <style>{`
        pre:has(.mermaid-graph-wrapper),
        pre:has(svg[id^="mermaid-"]) {
          background: transparent !important;
          border: none !important;
          padding: 0 !important;
          margin: 0 !important;
          box-shadow: none !important;
        }
        svg[id^="mermaid-"] g.node rect,
        svg[id^="mermaid-"] g.node polygon,
        svg[id^="mermaid-"] g.node circle,
        svg[id^="mermaid-"] g.node ellipse,
        svg[id^="mermaid-"] g.node path,
        svg[id^="mermaid-"] .node rect,
        svg[id^="mermaid-"] .node polygon,
        svg[id^="mermaid-"] .node circle,
        svg[id^="mermaid-"] .node ellipse,
        svg[id^="mermaid-"] .node path {
          fill: ${DARK_NODE_BG} !important;
          fill-opacity: 0.95 !important;
          stroke: ${DARK_NODE_BORDER} !important;
          stroke-width: 2px !important;
        }
        svg[id^="mermaid-"] g.node text,
        svg[id^="mermaid-"] .node text {
          fill: ${LIGHT_TEXT} !important;
          font-weight: 500 !important;
        }
        svg[id^="mermaid-"] text.titleText,
        svg[id^="mermaid-"] .title {
          fill: #f1f5f9 !important;
          font-weight: 600 !important;
          font-size: 1.1rem !important;
        }
        svg[id^="mermaid-"] .edgeLabel rect {
          fill: ${LABEL_BG} !important;
          opacity: 0.95 !important;
        }
        svg[id^="mermaid-"] .edgeLabel span {
          color: #cbd5e1 !important;
          font-weight: 500 !important;
        }
      `}</style>
      <div ref={containerRef} style={{ width: '100%', display: 'flex', justifyContent: 'center' }} />
    </div>
  );
};

interface ResultDisplayProps {
  draft: string;
  topic: string;
  sources: SourceRecord[];
  events?: Array<{timestamp: string, phase: string, message: string}>;
  liveSources?: SourceRecord[];
  phase?: string;
}

/**
 * 清理 LLM 生成的 Markdown 中残留的 HTML 标签。
 * 主要移除: <a id="xxx"></a>、<a name="xxx"></a> 等锚点标签，
 * 以及其他可能干扰渲染的内联 HTML。
 */
function cleanMarkdown(raw: string): string {
  return raw
    // 移除锚点标签: <a id="xxx"></a> 或 <a name="xxx"></a> (自闭合或成对)
    .replace(/<a\s+(?:id|name)=["'][^"']*["']\s*\/?>\s*(?:<\/a>)?/gi, '')
    // 移除空的 <a></a> 标签
    .replace(/<a>\s*<\/a>/gi, '');
}

export function ResultDisplay({ draft, topic, sources, events, liveSources, phase }: ResultDisplayProps) {
  const [showThinking, setShowThinking] = useState(true);
  const [obsidianVaultPath, setObsidianVaultPath] = useState<string>('');
  const [toast, setToast] = useState<{ type: 'loading' | 'success' | 'error'; message: string } | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  // 清理后的报告内容
  const cleanedDraft = draft ? cleanMarkdown(draft) : '';

  // 从 LocalStorage 加载库路径
  const loadObsidianPath = () => {
    try {
      const saved = localStorage.getItem('deeper_research_settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        setObsidianVaultPath(parsed.obsidian_vault_path || '');
      } else {
        setObsidianVaultPath('');
      }
    } catch (e) {
      console.error("加载 Obsidian 路径失败:", e);
    }
  };

  useEffect(() => {
    loadObsidianPath();

    const handleSettingsChanged = () => {
      loadObsidianPath();
    };

    window.addEventListener('deeper_research_settings_changed', handleSettingsChanged);
    window.addEventListener('storage', handleSettingsChanged);

    return () => {
      window.removeEventListener('deeper_research_settings_changed', handleSettingsChanged);
      window.removeEventListener('storage', handleSettingsChanged);
    };
  }, []);

  // 当报告生成完毕时，自动折叠思考过程；如果重新开始研究，则自动展开
  useEffect(() => {
    if (draft || phase === 'done') {
      setShowThinking(false);
    } else if (!draft && phase !== 'done') {
      setShowThinking(true);
    }
  }, [draft, phase]);

  if (!cleanedDraft && !topic) {
    return (
      <div className="glass-panel" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', flexDirection: 'column', gap: '1rem' }}>
        <FileText size={48} opacity={0.2} />
        <p>你的深度研究报告将会展示在这里。</p>
      </div>
    );
  }

  const handleDownload = () => {
    if (!cleanedDraft) return;
    
    let content = cleanedDraft;

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

  const handleSyncToObsidian = async () => {
    if (!cleanedDraft || !obsidianVaultPath || isSyncing) return;

    setIsSyncing(true);
    setToast({ type: 'loading', message: '正在通过 MCP 写入本地目录...' });

    try {
      const response = await fetch(`${API_BASE_URL}/api/research/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          obsidian_vault_path: obsidianVaultPath,
          topic: topic || '未命名研究报告',
          draft: cleanedDraft,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: '未知请求错误' }));
        throw new Error(errorData.detail || `HTTP 错误 ${response.status}`);
      }

      await response.json();
      setToast({ type: 'success', message: '已成功归档到本地 DeeperResearch 目录！' });

      setTimeout(() => {
        setToast(null);
      }, 3500);
    } catch (error: any) {
      console.error("同步失败:", error);
      setToast({ type: 'error', message: `归档失败: ${error.message || '网络或服务器异常'}` });
      setTimeout(() => {
        setToast(null);
      }, 4000);
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div className="glass-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      {/* 全局自定义动画与图表自适应样式注入 */}
      <style>{`
        @keyframes spin-custom {
          to { transform: rotate(360deg); }
        }
        .animate-spin-custom {
          animation: spin-custom 1s linear infinite;
        }
        @keyframes toastSlideIn {
          from {
            transform: translateY(-20px) scale(0.95);
            opacity: 0;
          }
          to {
            transform: translateY(0) scale(1);
            opacity: 1;
          }
        }
        .toast-slide-in {
          animation: toastSlideIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
        
        /* 强力自适应与最大宽度限制，防止小图被过度拉伸 */
        svg[id^="mermaid-"] {
          max-width: min(100%, 650px) !important;
          height: auto !important;
          margin: 0 auto;
        }
        .markdown-body img {
          max-width: 100% !important;
          height: auto !important;
          border-radius: 8px;
          border: 1px solid var(--panel-border);
          margin: 1.25rem 0;
        }
        .markdown-body pre {
          max-width: 100% !important;
          overflow-x: auto !important;
        }
      `}</style>

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
          {/* 同步到本地目录按钮 */}
          {cleanedDraft && obsidianVaultPath && (
            <button 
              onClick={handleSyncToObsidian}
              disabled={isSyncing}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                background: isSyncing ? 'rgba(99, 102, 241, 0.15)' : 'rgba(255,255,255,0.05)',
                border: isSyncing ? '1px solid var(--primary)' : '1px solid var(--panel-border)',
                color: isSyncing ? 'var(--primary)' : 'var(--text-main)',
                padding: '0.4rem 0.8rem',
                borderRadius: '6px',
                fontSize: '0.85rem',
                cursor: isSyncing ? 'not-allowed' : 'pointer',
                transition: 'all 0.2s',
                opacity: isSyncing ? 0.8 : 1,
              }}
              onMouseEnter={(e) => {
                if (!isSyncing) {
                  e.currentTarget.style.borderColor = 'var(--primary)';
                  e.currentTarget.style.background = 'rgba(99, 102, 241, 0.08)';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                }
              }}
              onMouseLeave={(e) => {
                if (!isSyncing) {
                  e.currentTarget.style.borderColor = 'var(--panel-border)';
                  e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                  e.currentTarget.style.transform = 'translateY(0)';
                }
              }}
              title="同步到本地目录 (如 Obsidian/Typora)"
            >
              <FolderSync size={16} className={isSyncing ? 'animate-spin-custom' : ''} />
              <span>{isSyncing ? '正在归档...' : '一键归档到目录'}</span>
            </button>
          )}

          {cleanedDraft && (
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
                transition: 'border-color 0.2s, transform 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--primary)';
                e.currentTarget.style.transform = 'translateY(-1px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--panel-border)';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
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
        {(events?.length ? true : liveSources?.length ? true : !cleanedDraft) && (
          <div className="thinking-container" style={{ margin: '0 auto 2rem auto', maxWidth: '800px', display: 'flex', flexDirection: 'column', gap: '1.5rem', background: 'rgba(0,0,0,0.2)', padding: '1.5rem', borderRadius: 'var(--radius-lg)', border: '1px solid var(--panel-border)' }}>
            <div 
              style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '1.05rem', color: 'var(--text-main)', cursor: 'pointer', userSelect: 'none', width: 'fit-content' }}
              onClick={() => setShowThinking(!showThinking)}
            >
              {!cleanedDraft && <div className="animate-pulse-slow" style={{ width: '10px', height: '10px', background: 'var(--secondary)', borderRadius: '50%', boxShadow: '0 0 8px var(--secondary)' }}></div>}
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

        {cleanedDraft && (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // 强力修复法则：重写 pre 渲染器。如果子元素包含 Mermaid 流程图（无论是原始 className 还是已替换的 Mermaid 组件），彻底抹去预设的灰色盒子背景与边框！
              pre(props: any) {
                const { children, ...rest } = props;
                const isMermaid = React.Children.toArray(children).some(
                  (child: any) => 
                    child?.props?.className?.includes('mermaid') || 
                    child?.type === Mermaid || 
                    child?.type?.name === 'Mermaid'
                );
                
                if (isMermaid) {
                  return <div style={{ background: 'transparent', border: 'none', padding: 0, margin: 0 }}>{children}</div>;
                }
                return <pre {...rest}>{children}</pre>;
              },
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
            {cleanedDraft}
          </ReactMarkdown>
        )}

        {sources.length > 0 && (
          <details style={{ maxWidth: '800px', margin: '2rem auto 0', borderTop: '1px solid var(--panel-border)', paddingTop: '1rem' }}>
            <summary style={{ cursor: 'pointer', color: 'var(--secondary)', fontWeight: 600 }}>
              来源证据 ({sources.length})
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem', marginTop: '1rem' }}>
              {sources.map((source, index) => (
                <div key={`${source.url}-${index}`} style={{ padding: '0.8rem 0', borderBottom: '1px dashed var(--panel-border)' }}>
                  <a href={source.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-main)' }}>
                    {source.title || source.url}
                  </a>
                  <span style={{ marginLeft: '0.6rem', fontSize: '0.75rem', color: source.verified ? 'var(--secondary)' : 'var(--text-muted)' }}>
                    {source.verified ? '搜索结果' : '模型补充引用，需核验'}
                  </span>
                  {(source.evidence || source.snippet) && (
                    <p style={{ margin: '0.35rem 0 0', color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: 1.5 }}>
                      {source.evidence || source.snippet}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* 浮动精致 Toast */}
      {toast && (
        <div 
          className="toast-slide-in"
          style={{
            position: 'absolute',
            top: '1.5rem',
            right: '1.5rem',
            background: 'rgba(15, 23, 42, 0.85)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: toast.type === 'success' 
              ? '1px solid rgba(34, 197, 94, 0.4)' 
              : toast.type === 'error' 
                ? '1px solid rgba(239, 68, 68, 0.4)' 
                : '1px solid rgba(99, 102, 241, 0.4)',
            padding: '0.75rem 1.25rem',
            borderRadius: '8px',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.5)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
            color: '#f8fafc',
            fontSize: '0.9rem',
          }}
        >
          {toast.type === 'loading' && <RefreshCw size={16} className="animate-spin-custom" style={{ color: 'var(--primary)' }} />}
          {toast.type === 'success' && <Check size={16} style={{ color: '#22c55e' }} />}
          {toast.type === 'error' && <X size={16} style={{ color: '#ef4444' }} />}
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}
