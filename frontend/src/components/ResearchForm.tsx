import { useState, useRef, useEffect } from 'react';
import { Search, Settings2, Globe, Shield, Paperclip, X, FileText, Loader2 } from 'lucide-react';
import { uploadFile } from '../api/research';

interface ResearchFormProps {
  onSubmit: (topic: string, requirements: string, searchEngine: string, uploadedContext: string) => void;
  isLoading: boolean;
}

export function ResearchForm({ onSubmit, isLoading }: ResearchFormProps) {
  const [topic, setTopic] = useState('');
  const [requirements, setRequirements] = useState('');
  const [showRequirements, setShowRequirements] = useState(false);
  const [searchEngine, setSearchEngine] = useState<'domestic' | 'international'>('domestic');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const reqTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 文件上传状态
  const [uploadedContext, setUploadedContext] = useState('');
  const [uploadedFileName, setUploadedFileName] = useState('');
  const [uploadCharCount, setUploadCharCount] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);

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
      onSubmit(topic.trim(), requirements.trim(), searchEngine, uploadedContext);
    }
  };

  const handleFileUpload = async (file: File) => {
    setUploadError('');
    setIsUploading(true);

    try {
      const result = await uploadFile(file);
      setUploadedContext(result.markdown);
      setUploadedFileName(result.filename);
      setUploadCharCount(result.char_count);
      // 上传文件后自动展开详细要求面板
      setShowRequirements(true);
    } catch (err: any) {
      setUploadError(err.message || '文件上传失败');
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileUpload(file);
    // 重置 input 以允许重新上传同一文件
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileUpload(file);
  };

  const handleRemoveFile = () => {
    setUploadedContext('');
    setUploadedFileName('');
    setUploadCharCount(0);
    setUploadError('');
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

        {/* 搜索引擎选择 */}
        <div style={{
          display: 'flex',
          gap: '0.5rem',
          flexWrap: 'wrap',
        }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.5rem 0.85rem',
              borderRadius: '8px',
              border: `1px solid ${searchEngine === 'domestic' ? 'var(--primary)' : 'var(--panel-border)'}`,
              background: searchEngine === 'domestic' ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              fontSize: '0.85rem',
              color: searchEngine === 'domestic' ? 'var(--text-main)' : 'var(--text-muted)',
              transition: 'all 0.2s ease',
              userSelect: 'none',
              flex: '1 1 0',
              minWidth: '130px',
            }}
          >
            <input
              type="radio"
              name="searchEngine"
              value="domestic"
              checked={searchEngine === 'domestic'}
              onChange={() => setSearchEngine('domestic')}
              disabled={isLoading}
              style={{ display: 'none' }}
            />
            <Shield size={14} style={{ color: searchEngine === 'domestic' ? 'var(--primary)' : 'var(--text-muted)', flexShrink: 0 }} />
            <span>国内搜索</span>
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.5rem 0.85rem',
              borderRadius: '8px',
              border: `1px solid ${searchEngine === 'international' ? 'var(--secondary)' : 'var(--panel-border)'}`,
              background: searchEngine === 'international' ? 'rgba(6, 182, 212, 0.15)' : 'transparent',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              fontSize: '0.85rem',
              color: searchEngine === 'international' ? 'var(--text-main)' : 'var(--text-muted)',
              transition: 'all 0.2s ease',
              userSelect: 'none',
              flex: '1 1 0',
              minWidth: '130px',
            }}
          >
            <input
              type="radio"
              name="searchEngine"
              value="international"
              checked={searchEngine === 'international'}
              onChange={() => setSearchEngine('international')}
              disabled={isLoading}
              style={{ display: 'none' }}
            />
            <Globe size={14} style={{ color: searchEngine === 'international' ? 'var(--secondary)' : 'var(--text-muted)', flexShrink: 0 }} />
            <span style={{ whiteSpace: 'nowrap' }}>国际搜索</span>
          </label>
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
            {(requirements || uploadedFileName) && !showRequirements && (
              <span style={{
                background: 'var(--primary)',
                color: 'white',
                borderRadius: '10px',
                padding: '0 6px',
                fontSize: '0.7rem',
                lineHeight: '1.6',
              }}>{uploadedFileName ? '已上传文件' : '已填写'}</span>
            )}
          </button>

          <div style={{
            maxHeight: showRequirements ? '500px' : '0',
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

            {/* 文件上传区域 */}
            <div
              onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleDrop}
              style={{
                marginTop: '0.5rem',
                border: `1.5px dashed ${isDragOver ? 'var(--primary)' : 'var(--panel-border)'}`,
                borderRadius: '8px',
                padding: '0.75rem',
                background: isDragOver ? 'rgba(99, 102, 241, 0.08)' : 'transparent',
                transition: 'all 0.2s ease',
              }}
            >
              {/* 已上传文件展示 */}
              {uploadedFileName ? (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  justifyContent: 'space-between',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                    <FileText size={16} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-main)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {uploadedFileName}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                      {uploadCharCount.toLocaleString()} 字符
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleRemoveFile}
                    disabled={isLoading}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--text-muted)',
                      padding: '2px',
                      display: 'flex',
                      flexShrink: 0,
                    }}
                    title="移除文件"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : isUploading ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '0.25rem' }}>
                  <Loader2 size={16} className="animate-spin" style={{ color: 'var(--primary)' }} />
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>正在转换文件...</span>
                </div>
              ) : (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.4rem',
                    cursor: isLoading ? 'not-allowed' : 'pointer',
                    padding: '0.25rem',
                  }}
                >
                  <Paperclip size={14} style={{ color: 'var(--text-muted)' }} />
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    上传参考文件 (PDF / Word / Excel / PPT / Markdown 等)
                  </span>
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.txt,.csv,.json,.xml,.html,.htm,.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.epub,.jpg,.jpeg,.png,.gif,.bmp,.wav,.mp3"
                onChange={handleFileSelect}
                style={{ display: 'none' }}
                disabled={isLoading || isUploading}
              />
            </div>

            {/* 上传错误提示 */}
            {uploadError && (
              <div style={{
                marginTop: '0.5rem',
                fontSize: '0.8rem',
                color: '#ef4444',
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem',
              }}>
                ⚠️ {uploadError}
              </div>
            )}
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
