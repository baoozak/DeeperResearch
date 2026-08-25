import { useEffect, useState } from 'react';
import { GitCompareArrows, History, Play, RefreshCw, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  fetchResearchHistory,
  fetchResearchVersion,
  fetchResearchVersions,
  type ResearchHistoryItem,
  type ResearchVersion,
  type ResearchVersionSummary,
} from '../api/research';

interface ResearchHistoryProps {
  isOpen: boolean;
  onClose: () => void;
  onResume: (researchId: string, version: number) => void;
  onResynthesize: (researchId: string, version: number) => void;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
}

export function ResearchHistory({ isOpen, onClose, onResume, onResynthesize }: ResearchHistoryProps) {
  const [items, setItems] = useState<ResearchHistoryItem[]>([]);
  const [versions, setVersions] = useState<Record<string, ResearchVersionSummary[]>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Array<{ researchId: string; version: number }>>([]);
  const [comparison, setComparison] = useState<[ResearchVersion, ResearchVersion] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    fetchResearchHistory()
      .then(setItems)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '读取研究历史失败'))
  }, [isOpen]);

  if (!isOpen) return null;

  const loadVersions = async (researchId: string) => {
    if (versions[researchId]) {
      setExpandedId(expandedId === researchId ? null : researchId);
      return;
    }
    try {
      const result = await fetchResearchVersions(researchId);
      setVersions((current) => ({ ...current, [researchId]: result }));
      setExpandedId(researchId);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : '读取版本失败');
    }
  };

  const toggleCompare = (researchId: string, version: number) => {
    setSelected((current) => {
      const exists = current.some((item) => item.researchId === researchId && item.version === version);
      if (exists) return current.filter((item) => !(item.researchId === researchId && item.version === version));
      if (current.length >= 2) return [...current.slice(1), { researchId, version }];
      return [...current, { researchId, version }];
    });
  };

  const compareSelected = async () => {
    if (selected.length !== 2) return;
    try {
      const [left, right] = await Promise.all(selected.map((item) => fetchResearchVersion(item.researchId, item.version)));
      setComparison([left, right]);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : '读取报告版本失败');
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(2, 6, 23, 0.78)', padding: '4vh 4vw', overflowY: 'auto' }}>
      <section className="glass-panel" style={{ maxWidth: '1100px', minHeight: '80vh', margin: '0 auto', padding: '1.5rem', position: 'relative' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--panel-border)', paddingBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <History size={20} color="var(--secondary)" />
            <h2 style={{ margin: 0, fontSize: '1.25rem' }}>研究历史与版本</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="关闭历史记录" aria-label="关闭历史记录"><X size={18} /></button>
        </header>

        {error && <p style={{ color: 'var(--accent)', margin: '1rem 0' }}>{error}</p>}
        {items.length === 0 && !error && <p style={{ color: 'var(--text-muted)' }}>还没有保存的研究记录。</p>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}>
          {items.map((item) => {
            const itemVersions = versions[item.id] || [];
            return (
              <div key={item.id} style={{ border: '1px solid var(--panel-border)', borderRadius: '8px', padding: '1rem' }}>
                <button onClick={() => loadVersions(item.id)} style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, color: 'inherit', cursor: 'pointer', padding: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'baseline' }}>
                    <strong>{item.topic}</strong>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{formatDate(item.updated_at)}</span>
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '0.35rem' }}>
                    {item.status} · {item.latest_version ? `当前 v${item.latest_version.version}，${item.latest_version.kind}` : '尚未生成版本'}
                  </div>
                </button>

                {expandedId === item.id && (
                  <div style={{ marginTop: '1rem', paddingTop: '0.75rem', borderTop: '1px dashed var(--panel-border)', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                    {itemVersions.map((version) => {
                      const isSelected = selected.some((entry) => entry.researchId === item.id && entry.version === version.version);
                      const hasReport = version.kind === 'report' || version.kind === 'resynthesis' || Boolean(version.report_preview);
                      return (
                        <div key={version.version} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 0' }}>
                          <span style={{ minWidth: '90px', color: 'var(--secondary)', fontWeight: 600 }}>v{version.version} · {version.kind}</span>
                          <span style={{ flex: 1, minWidth: '180px', color: 'var(--text-muted)', fontSize: '0.82rem' }}>{formatDate(version.created_at)} · {version.plan.length} 个计划 · {version.sources.length} 个来源</span>
                          <button className="icon-button" onClick={() => toggleCompare(item.id, version.version)} title="选择版本进行对比" aria-label="选择版本进行对比" disabled={!hasReport} style={{ color: isSelected ? 'var(--secondary)' : undefined }}><GitCompareArrows size={16} /></button>
                          <button className="icon-button" onClick={() => onResume(item.id, version.version)} title="从此版本继续执行" aria-label="从此版本继续执行"><Play size={16} /></button>
                          <button className="icon-button" onClick={() => onResynthesize(item.id, version.version)} title="基于此版本重新综合" aria-label="基于此版本重新综合" disabled={!hasReport}><RefreshCw size={16} /></button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.25rem' }}>
          <button className="btn-primary" onClick={compareSelected} disabled={selected.length !== 2}><GitCompareArrows size={16} /> 对比选中的两个版本 ({selected.length}/2)</button>
        </div>

        {comparison && (
          <div style={{ marginTop: '1.5rem', borderTop: '1px solid var(--panel-border)', paddingTop: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>报告对比：v{comparison[0].version} 与 v{comparison[1].version}</h3>
              <button className="icon-button" onClick={() => setComparison(null)} title="关闭对比" aria-label="关闭对比"><X size={16} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem', marginTop: '1rem' }}>
              {comparison.map((version) => (
                <article key={version.id} style={{ minWidth: 0, maxHeight: '50vh', overflowY: 'auto', padding: '1rem', border: '1px solid var(--panel-border)', borderRadius: '6px' }}>
                  <h4 style={{ marginTop: 0 }}>v{version.version} · {version.kind}</h4>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{version.report || '该版本尚未生成报告。'}</ReactMarkdown>
                </article>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
