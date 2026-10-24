/** Complete locale-owned copy for the independently integrated automation leaf. */
export interface OfficeAutomationLabels {
  title: string
  empty: string
  newRule: string
  edit: string
  enable: string
  disable: string
  refresh: string
  review: string
  cancel: string
  retry: string
  compensate: string
  recover: string
  confirm: string
  close: string
  primary: string
  compensation: string
  unknownHint: string
  reviewHint: string
  ruleTitle: string
  system: string
  action: string
  source: string
  trigger: string
  formTrigger: string
  eventTrigger: string
  webhookTrigger: string
  scheduleTrigger: string
  sourceHint: string
  save: string
  none: string
  unavailable: string
  denied: string
  startForm: string
  rulesTitle: string
  runsTitle: string
  noRules: string
  enabled: string
  disabled: string
  details: string
  runId: string
  requestId: string
  executionId: string
  noExecutionId: string
  revision: string
  connectionRevision: string
  adapterRevision: string
  occurrence: string
  parentRun: string
  ruleChanged: string
  refreshRequired: string
  saveUncertain: string
  serviceUnavailable: string
  noFields: string
  selectAction: string
  invalidFields: string
  resetFields: string
  externalCompensation: string
  removeCompensation: string
  runFilter: string
  noMatchingRuns: string
  sourceSharedHint: string
  rejection: string
  rejectionDenied: string
  rejectionNotAccepted: string
  rejectionUnauthorized: string
  rejectionRateLimited: string
  rejectionInvalidInput: string
  states: Record<'pending_approval' | 'running' | 'succeeded' | 'rejected' | 'unknown' | 'cancelled', string>
}
/** English and Chinese leaves have identical keys; Host and Client entry aggregation remains owned by integration. */
export const officeAutomationLabels: Readonly<Record<'en' | 'zh', OfficeAutomationLabels>> = {
  en: { title: 'Office automations', empty: 'No automation runs.', newRule: 'Create rule', edit: 'Edit', enable: 'Enable',
    disable: 'Disable', refresh: 'Refresh', review: 'Review operation', cancel: 'Cancel review', retry: 'Create retry for review',
    compensate: 'Request compensation review', recover: 'Check original execution', confirm: 'Confirm reviewed operation', close: 'Close',
    primary: 'Operation', compensation: 'Compensation', unknownHint: 'The external operation may have committed. Check its original execution.',
    reviewHint: 'Review every field. Acceptance does not establish delivery or business approval.',
    ruleTitle: 'Rule name', system: 'Company system', action: 'Business operation', source: 'Configured source', trigger: 'Trigger',
    formTrigger: 'Form', eventTrigger: 'Business event', webhookTrigger: 'Webhook', scheduleTrigger: 'Native scheduled task',
    sourceHint: 'Events, Webhooks and scheduled tasks need an administrator-configured source binding. A rule alone does not connect a source.',
    save: 'Save rule', none: 'None', unavailable: 'Data is unavailable. Keep the current form and refresh before continuing.',
    denied: 'The operation or configuration is unavailable under current permissions.',
    startForm: 'Trigger form rule',
    rulesTitle: 'Rules', runsTitle: 'Run history', noRules: 'Create a rule to configure a reviewed operation.',
    enabled: 'Enabled', disabled: 'Disabled', details: 'Execution details', runId: 'Run ID', requestId: 'Original request ID',
    executionId: 'Original execution ID', noExecutionId: 'No execution ID available', revision: 'Revision',
    connectionRevision: 'Connection revision', adapterRevision: 'Provider revision', occurrence: 'Source occurrence', parentRun: 'Parent run',
    ruleChanged: 'The rule has changed or is disabled. This retained run cannot start a new operation.',
    refreshRequired: 'A previous request has no confirmed outcome. Refresh the retained records before another change.',
    saveUncertain: 'The save response was lost. Refresh the rules to check the outcome. This draft will not be submitted again.',
    serviceUnavailable: 'Office automation is unavailable. Refresh or ask an administrator to confirm it is enabled.',
    noFields: 'This operation has no input fields.', selectAction: 'Select an available operation',
    invalidFields: 'Check the required fields and current operation. Changed fields or versions require an explicit selection.',
    resetFields: 'Reset fields to the selected operation',
    externalCompensation: 'Compensation belongs to another system. Its original operation and values are retained below.',
    removeCompensation: 'Remove compensation', runFilter: 'Find a run by rule, source, request or execution ID',
    noMatchingRuns: 'No runs match this search.',
    sourceSharedHint: 'A form submission admits every enabled rule for this source. Each operation still needs its own review.',
    rejection: 'Reason not accepted', rejectionDenied: 'Operation not permitted', rejectionNotAccepted: 'Request not accepted',
    rejectionUnauthorized: 'Authorization unavailable', rejectionRateLimited: 'Rate limit reached', rejectionInvalidInput: 'Input not accepted',
    states: { pending_approval: 'Awaiting review', running: 'Outcome unconfirmed', succeeded: 'Operation accepted',
      rejected: 'Not accepted', unknown: 'Outcome unknown', cancelled: 'Review cancelled' } },
  zh: { title: '办公自动化', empty: '暂无自动化运行。', newRule: '创建规则', edit: '编辑', enable: '启用', disable: '禁用', refresh: '刷新',
    review: '审核操作', cancel: '取消审核', retry: '创建重试并重新审核', compensate: '申请补偿审核', recover: '核查原执行',
    confirm: '确认已审核操作', close: '关闭', primary: '业务操作', compensation: '补偿操作',
    unknownHint: '外部操作可能已生效，请核查原执行结果。', reviewHint: '请逐项审核。操作受理不代表送达或业务审批通过。',
    ruleTitle: '规则名称', system: '公司系统', action: '业务操作', source: '已配置来源', trigger: '触发方式',
    formTrigger: '表单', eventTrigger: '业务事件', webhookTrigger: 'Webhook', scheduleTrigger: '原生定时任务',
    sourceHint: '事件、Webhook 和定时任务需要管理员配置来源绑定。保存规则本身不会连接来源。',
    save: '保存规则', none: '无', unavailable: '暂时无法获取数据，请保留当前表单并刷新后继续', denied: '当前权限下无法使用此操作或配置。',
    startForm: '触发表单规则',
    rulesTitle: '规则', runsTitle: '运行记录', noRules: '创建规则，配置需要审核的办公操作',
    enabled: '已启用', disabled: '已禁用', details: '执行详情', runId: '运行标识', requestId: '原请求标识',
    executionId: '原执行标识', noExecutionId: '尚无执行标识', revision: '版本',
    connectionRevision: '连接版本', adapterRevision: '适配器版本', occurrence: '来源事件标识', parentRun: '上次运行标识',
    ruleChanged: '规则已修改或禁用，此保留记录不能发起新操作',
    refreshRequired: '上次请求的结果尚未确认，请先刷新保留记录，再进行修改',
    saveUncertain: '保存回执丢失，请刷新规则列表核实结果，当前草稿不会再次提交',
    serviceUnavailable: '办公自动化暂不可用，请刷新或联系管理员确认已启用',
    noFields: '此操作没有输入字段', selectAction: '请选择可用操作',
    invalidFields: '请核对必填字段与当前操作，字段或版本变化后需要明确重新选择',
    resetFields: '按所选操作重置字段',
    externalCompensation: '补偿属于另一系统，下方保留其原操作和原字段',
    removeCompensation: '移除补偿配置', runFilter: '按规则、来源、请求或执行标识查找', noMatchingRuns: '没有匹配的运行记录',
    sourceSharedHint: '提交表单会为同一来源的所有已启用规则创建运行，每项操作仍需单独审核',
    rejection: '未受理原因', rejectionDenied: '不允许此操作', rejectionNotAccepted: '请求未受理',
    rejectionUnauthorized: '授权不可用', rejectionRateLimited: '请求频率受限', rejectionInvalidInput: '输入未被接受',
    states: { pending_approval: '等待审核', running: '结果待确认', succeeded: '操作已受理', rejected: '未受理', unknown: '结果未知', cancelled: '已取消审核' } },
}

const { states: englishStates, ...english } = officeAutomationLabels.en
const { states: chineseStates, ...chinese } = officeAutomationLabels.zh
/** Flat typed dictionary consumed by the existing Locale service. */
export const officeAutomationDictionary = { en: { ...english, ...englishStates }, zh: { ...chinese, ...chineseStates } }
/** Keys registered under the independently integrated Office automation locale namespace. */
export type OfficeAutomationCopyKey = keyof typeof officeAutomationDictionary.en

/**
 * Adapt the standard locale binding to the presentation's complete label props.
 * @param t - Existing framework locale binding for the Office automation namespace.
 * @returns Complete localized labels, including all conservative execution states.
 */
export function translateOfficeAutomation(t: (key: OfficeAutomationCopyKey) => string): OfficeAutomationLabels {
  const flat = Object.fromEntries(Object.keys(officeAutomationDictionary.en).map(key => [key, t(key as OfficeAutomationCopyKey)])) as
    Record<OfficeAutomationCopyKey, string>
  const { pending_approval, running, succeeded, rejected, unknown, cancelled, ...labels } = flat
  return { ...labels, states: { pending_approval, running, succeeded, rejected, unknown, cancelled } }
}
