import React, { useState, useEffect } from 'react';
import { Settings, Eye, EyeOff, Check, X, ShieldAlert, Key, Globe, Cpu, ChevronRight, ChevronDown, Sliders, FolderOpen } from 'lucide-react';


interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  // 是否是强制弹窗（无法关闭，直到配好）
  isForce?: boolean;
}

export interface UserSettings {
  llm_provider: string;
  llm_api_key: string;
  llm_base_url: string;
  llm_model: string;
  anysearch_api_key: string;
  max_sub_tasks: number;
  max_search_results: number;
  max_search_review_retries: number;
  obsidian_vault_path?: string;
}

const PROVIDER_PRESETS: Record<string, { name: string; baseUrl: string; defaultModel: string; models: string[] }> = {
  deepseek: {
    name: 'DeepSeek 官方 API',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  dashscope: {
    name: '阿里百炼 (DashScope)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3.6-flash',
    models: ['qwen3.6-flash', 'qwen3.6-plus', 'qwen3.7-plus'],
  },
  custom: {
    name: '自定义 OpenAI 兼容接口',
    baseUrl: '',
    defaultModel: '',
    models: [],
  }
};

type ProviderKey = keyof typeof PROVIDER_PRESETS;
type ProviderConfig = { apiKey: string; baseUrl: string; model: string };
const isProviderKey = (value: string): value is ProviderKey => value in PROVIDER_PRESETS;


export function SettingsModal({ isOpen, onClose, isForce = false }: SettingsModalProps) {
  const [provider, setProvider] = useState<ProviderKey>('deepseek');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [anysearchKey, setAnysearchKey] = useState('');
  const [obsidianVaultPath, setObsidianVaultPath] = useState('');
  
  // 各供应商的历史配置字典，支持独立记忆 Key/URL/Model
  const [providerConfigs, setProviderConfigs] = useState<Record<ProviderKey, ProviderConfig>>({
    deepseek: { apiKey: '', baseUrl: PROVIDER_PRESETS.deepseek.baseUrl, model: PROVIDER_PRESETS.deepseek.defaultModel },
    dashscope: { apiKey: '', baseUrl: PROVIDER_PRESETS.dashscope.baseUrl, model: PROVIDER_PRESETS.dashscope.defaultModel },
    custom: { apiKey: '', baseUrl: '', model: '' }
  });

  // 更新当前指定供应商的参数缓存
  const updateProviderConfig = (prov: ProviderKey, fields: Partial<ProviderConfig>) => {
    setProviderConfigs(prev => ({
      ...prev,
      [prov]: { ...prev[prov], ...fields }
    }));
  };

  // 研究控制参数
  const [maxSubTasks, setMaxSubTasks] = useState(5);
  const [maxSearchResults, setMaxSearchResults] = useState(5);
  const [maxSearchReviewRetries, setMaxSearchReviewRetries] = useState(2);
  const [showAdvanced, setShowAdvanced] = useState(false); // 折叠面板开关
  
  const [showApiKey, setShowApiKey] = useState(false);
  const [showAnysearchKey, setShowAnysearchKey] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // 初始化时加载配置
  useEffect(() => {
    const saved = localStorage.getItem('deeper_research_settings');
    const savedConfigs = localStorage.getItem('deeper_research_provider_configs');
    
    let initialConfigs: Record<ProviderKey, ProviderConfig> = {
      deepseek: { apiKey: '', baseUrl: PROVIDER_PRESETS.deepseek.baseUrl, model: PROVIDER_PRESETS.deepseek.defaultModel },
      dashscope: { apiKey: '', baseUrl: PROVIDER_PRESETS.dashscope.baseUrl, model: PROVIDER_PRESETS.dashscope.defaultModel },
      custom: { apiKey: '', baseUrl: '', model: '' }
    };

    if (savedConfigs) {
      try {
        initialConfigs = { ...initialConfigs, ...JSON.parse(savedConfigs) };
        setProviderConfigs(initialConfigs);
      } catch (e) {
        console.error("加载多供应商历史配置失败:", e);
      }
    }

    if (saved) {
      try {
        const parsed: UserSettings = JSON.parse(saved);
        const currentProvider = isProviderKey(parsed.llm_provider) ? parsed.llm_provider : 'deepseek';
        setProvider(currentProvider);
        
        const activeKey = parsed.llm_api_key || '';
        const activeBaseUrl = parsed.llm_base_url || '';
        const activeModel = parsed.llm_model || '';

        setApiKey(activeKey);
        setBaseUrl(activeBaseUrl);
        setModel(activeModel);
        setAnysearchKey(parsed.anysearch_api_key || '');
        setObsidianVaultPath(parsed.obsidian_vault_path || '');
        
        setMaxSubTasks(parsed.max_sub_tasks !== undefined ? parsed.max_sub_tasks : 5);
        setMaxSearchResults(parsed.max_search_results !== undefined ? parsed.max_search_results : 5);
        setMaxSearchReviewRetries(parsed.max_search_review_retries !== undefined ? parsed.max_search_review_retries : 2);

        // 同步至 configs 暂存结构
        if (activeKey || activeBaseUrl || activeModel) {
          initialConfigs[currentProvider] = {
            apiKey: activeKey,
            baseUrl: activeBaseUrl,
            model: activeModel
          };
          setProviderConfigs({ ...initialConfigs });
        }
      } catch (e) {
        console.error("加载设置失败:", e);
      }
    } else {
      // 没有任何保存时，应用默认预设
      applyPreset('deepseek');
    }
  }, [isOpen]);

  const applyPreset = (key: ProviderKey) => {
    setProvider(key);
    const preset = PROVIDER_PRESETS[key];
    if (preset) {
      const config = providerConfigs[key] || { apiKey: '', baseUrl: '', model: '' };
      setBaseUrl(config.baseUrl || preset.baseUrl);
      setModel(config.model || preset.defaultModel);
      setApiKey(config.apiKey || '');
    }
  };

  const handleProviderChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextProvider = e.target.value;
    if (!isProviderKey(nextProvider)) return;
    setProvider(nextProvider);
    
    // 取回该提供商上次编辑并保存的历史配置，拒绝一刀切清空
    const config = providerConfigs[nextProvider] || { apiKey: '', baseUrl: '', model: '' };
    const preset = PROVIDER_PRESETS[nextProvider];

    setApiKey(config.apiKey || '');
    setBaseUrl(config.baseUrl || (preset ? preset.baseUrl : ''));
    setModel(config.model || (preset ? preset.defaultModel : ''));
  };

  const handleSave = () => {
    setErrorMsg('');
    
    if (!apiKey.trim()) {
      setErrorMsg('⚠️ 请填写大模型 API Key！这是大模型推理所必需的。');
      return;
    }
    if (!baseUrl.trim()) {
      setErrorMsg('⚠️ 请填写大模型的 API Base URL！');
      return;
    }
    if (!model.trim()) {
      setErrorMsg('⚠️ 请填写模型名称！');
      return;
    }
    if (!anysearchKey.trim()) {
      setErrorMsg('⚠️ 请填写 AnySearch 检索 API Key！网页检索底座必须配置此密钥。');
      return;
    }


    const newSettings: UserSettings = {
      llm_provider: provider,
      llm_api_key: apiKey.trim(),
      llm_base_url: baseUrl.trim(),
      llm_model: model.trim(),
      anysearch_api_key: anysearchKey.trim(),
      max_sub_tasks: maxSubTasks,
      max_search_results: maxSearchResults,
      max_search_review_retries: maxSearchReviewRetries,
      obsidian_vault_path: obsidianVaultPath.trim(),
    };

    localStorage.setItem('deeper_research_settings', JSON.stringify(newSettings));
    localStorage.setItem('deeper_research_provider_configs', JSON.stringify(providerConfigs));
    window.dispatchEvent(new Event('deeper_research_settings_changed'));
    
    setSaveSuccess(true);
    setErrorMsg('');

    setTimeout(() => {
      setSaveSuccess(false);
      onClose();
    }, 1000);
  };



  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(5, 5, 15, 0.8)',
      backdropFilter: 'blur(10px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999,
      animation: 'fadeIn 0.25s ease-out'
    }}>
      <div className="glass-panel" style={{
        width: '100%',
        maxWidth: '520px',
        padding: '2rem',
        position: 'relative',
        boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        maxHeight: '90vh',
        overflowY: 'auto'
      }}>
        {/* 关闭按钮 (强制填写的首次状态下不显示，防止未配好直接关掉) */}
        {!isForce && (
          <button 
            onClick={onClose}
            style={{
              position: 'absolute',
              right: '1.25rem',
              top: '1.25rem',
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.2s'
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <X size={18} />
          </button>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem', borderBottom: '1px solid var(--panel-border)', paddingBottom: '1rem' }}>
          <Settings size={24} style={{ color: 'var(--primary)' }} />
          <h2 style={{ fontSize: '1.4rem', margin: 0, color: 'white', fontWeight: 600 }}>
            {isForce ? '配置大模型与检索服务' : '研究设置'}
          </h2>
        </div>

        {isForce && (
          <div style={{
            display: 'flex',
            gap: '0.6rem',
            alignItems: 'flex-start',
            background: 'rgba(99, 102, 241, 0.1)',
            border: '1px solid rgba(99, 102, 241, 0.2)',
            padding: '0.85rem 1rem',
            borderRadius: '8px',
            color: '#c7d2fe',
            fontSize: '0.85rem',
            marginBottom: '1.5rem',
            lineHeight: '1.5'
          }}>
            <ShieldAlert size={18} style={{ color: 'var(--primary)', flexShrink: 0, marginTop: '2px' }} />
            <span>检测到本地未配置个人大模型密钥，请先在下方输入您的 API 密钥，以便激活深度研究功能。所有配置只存在你本地浏览器中，绝不上传。</span>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          
          {/* 大模型服务商 */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.88rem', color: 'var(--text-muted)', marginBottom: '0.5rem', fontWeight: 500 }}>
              <Cpu size={14} />
              <span>大模型供应商 (LLM Provider)</span>
            </label>
            <select
              value={provider}
              onChange={handleProviderChange}
              className="input-glass"
              style={{
                width: '100%',
                padding: '0.6rem 0.75rem',
                fontSize: '0.92rem',
                background: '#0f172a',
                border: '1px solid var(--panel-border)',
                borderRadius: '8px',
                color: 'white',
                outline: 'none',
                cursor: 'pointer'
              }}
            >
              {Object.entries(PROVIDER_PRESETS).map(([key, item]) => (
                <option key={key} value={key} style={{ background: '#0f172a' }}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>

          {/* Base URL */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.88rem', color: 'var(--text-muted)', marginBottom: '0.5rem', fontWeight: 500 }}>
              <Globe size={14} />
              <span>API Base URL</span>
            </label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => {
                const val = e.target.value;
                setBaseUrl(val);
                updateProviderConfig(provider, { baseUrl: val });
              }}
              placeholder="例如: https://api.openai.com/v1"
              className="input-glass"
              style={{
                width: '100%',
                padding: '0.6rem 0.75rem',
                fontSize: '0.92rem',
                background: '#0f172a',
                border: '1px solid var(--panel-border)',
                borderRadius: '8px',
                color: 'white',
                outline: 'none',
                boxSizing: 'border-box'
              }}
            />
          </div>

          {/* Model Name */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.88rem', color: 'var(--text-muted)', marginBottom: '0.5rem', fontWeight: 500 }}>
              <Cpu size={14} />
              <span>模型名称 (Model Name)</span>
            </label>
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                value={model}
                onChange={(e) => {
                  const val = e.target.value;
                  setModel(val);
                  updateProviderConfig(provider, { model: val });
                }}
                placeholder="例如: deepseek-chat"
                className="input-glass"
                style={{
                  width: '100%',
                  padding: '0.6rem 0.75rem',
                  fontSize: '0.92rem',
                  background: '#0f172a',
                  border: '1px solid var(--panel-border)',
                  borderRadius: '8px',
                  color: 'white',
                  outline: 'none',
                  boxSizing: 'border-box'
                }}
              />
              
              {/* 快捷模型推荐 */}
              {PROVIDER_PRESETS[provider]?.models.length > 0 && (
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.4rem' }}>
                  {PROVIDER_PRESETS[provider].models.map(m => (
                    <button
                      key={m}
                      onClick={() => {
                        setModel(m);
                        updateProviderConfig(provider, { model: m });
                      }}
                      style={{
                        padding: '0.2rem 0.5rem',
                        fontSize: '0.75rem',
                        background: model === m ? 'rgba(99, 102, 241, 0.2)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${model === m ? 'var(--primary)' : 'var(--panel-border)'}`,
                        borderRadius: '4px',
                        color: model === m ? 'white' : 'var(--text-muted)',
                        cursor: 'pointer',
                        transition: 'all 0.2s'
                      }}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* API Key */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.88rem', color: 'var(--text-muted)', marginBottom: '0.5rem', fontWeight: 500 }}>
              <Key size={14} />
              <span>大模型 API Key</span>
            </label>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => {
                  const val = e.target.value;
                  setApiKey(val);
                  updateProviderConfig(provider, { apiKey: val });
                }}
                placeholder="输入以 sk- 开头的 API 密钥"
                className="input-glass"
                style={{
                  width: '100%',
                  padding: '0.6rem 2.5rem 0.6rem 0.75rem',
                  fontSize: '0.92rem',
                  background: '#0f172a',
                  border: '1px solid var(--panel-border)',
                  borderRadius: '8px',
                  color: 'white',
                  outline: 'none',
                  boxSizing: 'border-box'
                }}
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                style={{
                  position: 'absolute',
                  right: '0.75rem',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--panel-border)', margin: '0.5rem 0' }} />

          {/* AnySearch API Key */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.88rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                <Key size={14} />
                <span>AnySearch 检索 API Key</span>
              </label>
            </div>

            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <input
                type={showAnysearchKey ? 'text' : 'password'}
                value={anysearchKey}
                onChange={(e) => setAnysearchKey(e.target.value)}
                placeholder="在此填入您的 AnySearch Key 解锁高频检索"
                className="input-glass"
                style={{
                  width: '100%',
                  padding: '0.6rem 2.5rem 0.6rem 0.75rem',
                  fontSize: '0.92rem',
                  background: '#0f172a',
                  border: '1px solid var(--panel-border)',
                  borderRadius: '8px',
                  color: 'white',
                  outline: 'none',
                  boxSizing: 'border-box'
                }}
              />
              <button
                type="button"
                onClick={() => setShowAnysearchKey(!showAnysearchKey)}
                style={{
                  position: 'absolute',
                  right: '0.75rem',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                {showAnysearchKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* Local Vault/Directory Path */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.88rem', color: 'var(--text-muted)', marginBottom: '0.5rem', fontWeight: 500 }}>
              <FolderOpen size={14} />
              <span>本地目录绝对路径 (可选，支持 Obsidian/Typora/VSCode 工作区)</span>
            </label>
            <input
              type="text"
              value={obsidianVaultPath}
              onChange={(e) => setObsidianVaultPath(e.target.value)}
              placeholder="例如: D:/MyKnowledgeBase (留空则不启用同步)"
              className="input-glass"
              style={{
                width: '100%',
                padding: '0.6rem 0.75rem',
                fontSize: '0.92rem',
                background: '#0f172a',
                border: '1px solid var(--panel-border)',
                borderRadius: '8px',
                color: 'white',
                outline: 'none',
                boxSizing: 'border-box'
              }}
            />
          </div>

          <div style={{ borderTop: '1px solid var(--panel-border)', margin: '0.5rem 0' }} />

          {/* 高级研究参数折叠 */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                background: 'transparent',
                border: 'none',
                color: showAdvanced ? 'var(--primary)' : 'var(--text-muted)',
                cursor: 'pointer',
                fontSize: '0.88rem',
                fontWeight: 500,
                padding: '0.25rem 0',
                transition: 'color 0.2s',
                width: '100%',
                justifyContent: 'space-between'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Sliders size={14} />
                <span>高级研究参数控制</span>
              </div>
              {showAdvanced ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>

            {showAdvanced && (
              <div style={{
                marginTop: '1rem',
                padding: '1rem',
                background: 'rgba(0,0,0,0.15)',
                border: '1px solid var(--panel-border)',
                borderRadius: '8px',
                display: 'flex',
                flexDirection: 'column',
                gap: '1rem',
              }}>
                {/* 最大子任务数 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-main)', fontWeight: 500 }}>最大子任务数 (Tasks)</span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Orchestrator 拆解的最大子任务上限</span>
                  </div>
                  <select
                    value={maxSubTasks}
                    onChange={(e) => setMaxSubTasks(Number(e.target.value))}
                    style={{
                      padding: '0.4rem 0.6rem',
                      background: '#0f172a',
                      border: '1px solid var(--panel-border)',
                      borderRadius: '6px',
                      color: 'white',
                      fontSize: '0.85rem',
                      cursor: 'pointer',
                      outline: 'none'
                    }}
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                      <option key={n} value={n}>{n} 个任务</option>
                    ))}
                  </select>
                </div>

                {/* 每次搜索最大结果数 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-main)', fontWeight: 500 }}>搜索结果上限 (Results)</span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>每次网络搜索返回的网页上限</span>
                  </div>
                  <select
                    value={maxSearchResults}
                    onChange={(e) => setMaxSearchResults(Number(e.target.value))}
                    style={{
                      padding: '0.4rem 0.6rem',
                      background: '#0f172a',
                      border: '1px solid var(--panel-border)',
                      borderRadius: '6px',
                      color: 'white',
                      fontSize: '0.85rem',
                      cursor: 'pointer',
                      outline: 'none'
                    }}
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                      <option key={n} value={n}>{n} 条结果</option>
                    ))}
                  </select>
                </div>

                {/* 搜索质量审查重试次数 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-main)', fontWeight: 500 }}>审查重搜限制 (Retries)</span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>搜索结果质量不佳时的重试上限</span>
                  </div>
                  <select
                    value={maxSearchReviewRetries}
                    onChange={(e) => setMaxSearchReviewRetries(Number(e.target.value))}
                    style={{
                      padding: '0.4rem 0.6rem',
                      background: '#0f172a',
                      border: '1px solid var(--panel-border)',
                      borderRadius: '6px',
                      color: 'white',
                      fontSize: '0.85rem',
                      cursor: 'pointer',
                      outline: 'none'
                    }}
                  >
                    {[0, 1, 2, 3, 4, 5].map(n => (
                      <option key={n} value={n}>{n === 0 ? '不重试' : `${n} 次重试`}</option>
                    ))}
                  </select>
                </div>

              </div>
            )}
          </div>

        </div>


        {errorMsg && (
          <div style={{
            marginTop: '1.25rem',
            padding: '0.75rem',
            background: 'rgba(244, 63, 94, 0.1)',
            border: '1px solid rgba(244, 63, 94, 0.2)',
            borderRadius: '8px',
            color: '#fca5a5',
            fontSize: '0.85rem'
          }}>
            {errorMsg}
          </div>
        )}

        {/* 底部动作按钮 */}
        <div style={{ marginTop: '2rem', display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
          {!isForce && (
            <button
              onClick={onClose}
              style={{
                padding: '0.6rem 1.25rem',
                borderRadius: '8px',
                border: '1px solid var(--panel-border)',
                background: 'rgba(255,255,255,0.03)',
                color: 'var(--text-main)',
                fontSize: '0.9rem',
                cursor: 'pointer',
                transition: 'background 0.2s'
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
              onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
            >
              取消
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saveSuccess}
            style={{
              padding: '0.6rem 1.5rem',
              borderRadius: '8px',
              border: 'none',
              background: saveSuccess ? '#10b981' : 'var(--primary)',
              color: 'white',
              fontSize: '0.9rem',
              fontWeight: 600,
              cursor: saveSuccess ? 'default' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              boxShadow: '0 4px 12px rgba(99, 102, 241, 0.3)',
              transition: 'background 0.2s, transform 0.1s'
            }}
            onMouseEnter={e => { if(!saveSuccess) e.currentTarget.style.background = '#4f46e5'; }}
            onMouseLeave={e => { if(!saveSuccess) e.currentTarget.style.background = 'var(--primary)'; }}
            onMouseDown={e => { if(!saveSuccess) e.currentTarget.style.transform = 'scale(0.97)'; }}
            onMouseUp={e => { if(!saveSuccess) e.currentTarget.style.transform = 'scale(1)'; }}
          >
            {saveSuccess ? (
              <>
                <Check size={16} />
                <span>保存成功</span>
              </>
            ) : (
              <span>保存配置</span>
            )}
          </button>
        </div>

      </div>
    </div>
  );
}
