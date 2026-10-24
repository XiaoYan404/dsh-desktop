const locales = {
  zh: { edition: '企业工作空间 · 热开发版', title: '准备好，让工作更从容',
    description: '对话、资料与协作，在同一个工作空间。', status: '正在启动办公服务，首次启动可能需要稍候。' },
  en: { edition: 'ENTERPRISE WORKSPACE · DEVELOPMENT', title: 'A calmer place to get work done',
    description: 'Conversations, documents and collaboration in one workspace.', status: 'Starting the office service. The first launch may take a moment.' },
}
const language = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
const copy = locales[language]
for (const key of ['edition', 'title', 'description', 'status']) document.getElementById(key).textContent = copy[key]
document.getElementById('progress').setAttribute('aria-label', copy.status)
