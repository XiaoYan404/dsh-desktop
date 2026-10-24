"""In-memory presentation data. No models, business systems, or file content access."""
from dataclasses import dataclass, field
from copy import deepcopy
from datetime import date, datetime
from pathlib import Path
import json
import os


NAV = [('home', '工作台'), ('chat', 'AI会话'), ('messages', '通讯录'), ('knowledge', '网盘'),
       ('tasks', '工作'), ('integrations', '集成'), ('plugins', '工具'),
       ('admin', '团队设置'), ('settings', '偏好与连接')]
NAV_ICONS = {'home': 'home', 'chat': 'sparkles', 'messages': 'team', 'knowledge': 'files',
             'tasks': 'workbench', 'integrations': 'plug', 'plugins': 'apps', 'admin': 'team', 'settings': 'settings'}
PAGE_TITLES = dict(NAV, calendar='日历', benches='场景工坊', agents='我的助手', item_detail='事项详情')
ITEM_KINDS = {'task': '工作任务', 'todo': '待办', 'system': '系统待办', 'schedule': '日程'}
TODO_STATUSES = ('待处理', '进行中', '已完成', '已取消')
ACCESS_LABELS = {'inherit': '跟随上级', 'none': '不可见', 'view': '可查看', 'edit': '可编辑', 'manage': '所有者'}
CONVERSATION_FIELDS = ('scenario', 'assistant', 'draft', 'messages', 'attachments', 'template', 'execution',
                       'linked_integrations', 'linked_tools', 'message_links')
TEAM_MEMBERS = (
    dict(id='lin-xiao', name='林晓', role='普通员工', job='行政专员', department='综合管理部',
         email='lin.xiao@example.com', phone='13800001001'),
    dict(id='chen-an', name='陈安', role='业务负责人', job='销售主管', department='销售部',
         email='chen.an@example.com', phone='13800001002'),
    dict(id='xu-ning', name='许宁', role='普通员工', job='运营专员', department='运营部',
         email='xu.ning@example.com', phone='13800001003'),
)


def default_today_items():
    """A day's fictional work. Dates follow the local preview date."""
    today = datetime.now().date().isoformat()
    records = [
        ('meeting', '部门例会', 'schedule', '企业日历', '09:30', '待参加', '陈晨 · 部门负责人',
         '一起回顾本周工作进展，讨论需要协调的事项。请提前整理自己的进度与待解决问题。', ['部门例会议程.pdf']),
        ('report', '提交本周工作报告', 'task', '工作台 · 主管派发', '11:00', '待处理', '陈晨 · 部门负责人',
         '整理本周已完成工作、关键成果和下周计划，按部门模板准备工作报告。完成后交给负责人检查。', ['部门工作报告模板.docx']),
        ('purchase', '处理采购申请', 'system', 'OA 审批系统', '15:00', '待处理', '李然 · 采购协作',
         '核对申请中的采购明细、用途及预算，补充相关说明。此处为 OA 待办示例，尚未连接真实审批记录。', ['采购申请明细.xlsx']),
        ('customer', '客户沟通', 'schedule', '企业日历', '16:30', '待参加', '林晓',
         '与客户对齐本周进展和下一步安排。可以请 Agent 帮忙整理沟通提纲。', []),
        ('inventory', '核对库存差异', 'task', '工作台 · 自己创建', '', '待处理', '林晓',
         '整理库存差异清单，标记需要业务同事核实的项目，并准备核对说明。', ['库存差异清单.xlsx']),
        ('expense', '补充报销材料', 'system', 'OA 审批系统', '', '待补充', '财务协作',
         '根据财务反馈补充报销说明与相关材料。此处为待办示例，不读取或上传真实票据。', []),
    ]
    items = [dict(id=key, title=title, kind=kind, source=source, time=time, date=today,
                 status=status, initiator=initiator, owner='林晓', description=description,
                 materials=materials, owner_id='lin-xiao', initiator_id='chen-an' if key == 'report' else 'lin-xiao')
            for key, title, kind, source, time, status, initiator, description, materials in records]
    for item in items:
        if item['kind'] == 'schedule':
            item['end_time'] = '10:00' if item['id'] == 'meeting' else '17:00'
            item['location'] = '3 号会议室' if item['id'] == 'meeting' else '线上会议'
            item['participants'] = [dict(id='chen-an', name='陈安', status='已接受')]
    return items
SCENARIOS = {
    'sales': ('销售经营分析', '销售分析助手', '销售运营', '分析本周销售数据，按企业模板生成销售周报。', '经营周报 · DOCX'),
    'documents': ('企业文档助手', '文档撰写助手', '行政协作', '按企业模板起草下周全员培训通知。', '文档草稿 · DOCX'),
    'ppt': ('品牌演示工坊', '演示制作助手', '品牌与市场', '制作一份季度经营回顾演示。', '演示文稿 · PPTX'),
    'knowledge': ('企业知识问答', '企业知识助手', '企业资料', '查找差旅报销标准，并标明依据的制度与章节。', '回答与引用 · 拟新增'),
    'quote': ('采购报价工作台', '商务报价助手', '销售运营', '根据产品目录与采购清单，生成待审核报价。', '报价草稿 · XLSX'),
    'project': ('项目协作空间', '项目助理', '项目资料', '整理项目进度、下周待办和需要确认的风险。', '项目周报 · DOCX'),
}


def default_benches():
    descriptions = ['从销售数据到经营洞察，让每一次决策都有据可依。',
                    '沿用企业模板，完成通知、合同初稿与日常文书。',
                    '把想法变成演示，交付可编辑的品牌 PPT。',
                    '在制度、产品和项目资料中找到有来源的答案。',
                    '关联采购清单与产品目录，形成待审核报价。',
                    '汇集项目资料与待办，让工作上下文保持连贯。']
    categories = ['销售运营', '行政协作', '品牌营销', '知识服务', '销售运营', '行政协作']
    return [dict(key=k, name=v[0], description=descriptions[i], category=categories[i],
                 tag='企业专属' if i < 2 else 'PPT 能力' if i == 2 else '拟新增')
            for i, (k, v) in enumerate(SCENARIOS.items())]


def default_agents():
    return [dict(name='销售分析助手', role='核对口径，分析销售数据并形成经营报告。',
                 prompt='先核对统计周期、字段和单位，不虚构缺失数据，交付前请用户确认。'),
            dict(name='企业文档助手', role='使用企业模板，起草日常文书。',
                 prompt='遵循企业模板，涉及对外发布时先交付草稿。'),
            dict(name='通用办公助手', role='处理授权范围内的多步骤办公任务。',
                 prompt='先理解任务和资料，在授权范围内执行，结果需要可以检查。')]


def default_files():
    records = [dict(name=n, kind=t, category=c, size=z, source='示例资料', version='V1.2 · 演示', imported=False)
            for n, t, c, z in [('产品手册 2026 · 秋季版', 'PDF', '产品资料', '2.4 MB'),
                               ('本周销售明细', 'XLSX', '销售数据', '186 KB'),
                               ('企业周报标准模板', 'DOCX', '企业模板', '52 KB'),
                               ('远山科技品牌演示模板', 'PPTX', '企业模板', '4.8 MB'),
                               ('员工差旅与报销制度', 'PDF', '企业制度', '890 KB')]]
    parents = ['shared-products', 'private:lin-xiao', 'shared-templates', 'shared-templates', 'shared']
    for index, record in enumerate(records):
        record.update(id=f'file-{index}', parent=parents[index], owner_id='lin-xiao',
                      space='private' if index == 1 else 'shared', permissions={},
                      default_access='inherit', modified=date.today().isoformat())
    return records


def default_drive_folders():
    return [dict(id=key, name=name, parent=parent, space=space, owner_id=owner,
                 permissions={}, default_access=access, modified=date.today().isoformat(), kind='folder')
            for key, name, parent, space, owner, access in [
                ('private-work', '工作文档', 'private:lin-xiao', 'private', 'lin-xiao', 'inherit'),
                ('private-archive', '项目归档', 'private-work', 'private', 'lin-xiao', 'inherit'),
                ('shared-products', '产品资料', 'shared', 'shared', 'lin-xiao', 'view'),
                ('shared-templates', '企业模板', 'shared', 'shared', 'lin-xiao', 'view'),
                ('shared-sales', '销售协作', 'shared', 'shared', 'chen-an', 'none'),
            ]]


def default_integrations():
    return [dict(id=key, name=name + '连接插件', system=name, version='1.0.0', provider='产品公司 · 企业交付团队',
                 owner=owner, description=description, capabilities=capabilities, status='待配置', address='',
                 imported=False)
            for key, name, owner, description, capabilities in [
                ('oa', 'OA 协同办公', '综合管理部', '让审批和日常办公事项进入统一工作台。', ['查看审批待办', '查询申请详情', '准备申请草稿']),
                ('erp', 'ERP 经营管理', '财务与供应链', '在授权范围内查询采购、库存与经营数据。', ['查询采购单', '查看库存', '汇总经营数据']),
                ('crm', 'CRM 客户管理', '销售部', '围绕客户和商机整理跟进工作。', ['查询客户', '整理跟进记录', '查询商机进度']),
                ('hr', 'HR 人力资源', '人力资源部', '提供员工组织信息与常用人事服务入口。', ['查询组织成员', '查询考勤', '准备请假申请']),
            ]]


def default_skills():
    return [dict(id=key, name=name, category=category, description=description, scenario=scenario,
                 integration=integration, instruction=instruction)
            for key, name, category, description, scenario, integration, instruction in [
                ('documents', '文档处理', '办公处理', '起草、整理和检查日常办公文档。', 'documents', '', '按企业模板整理一份工作文档。'),
                ('sheets', '表格与数据分析', '办公处理', '汇总表格，检查数据并准备分析报告。', 'sales', '', '分析本周数据，整理关键变化与建议。'),
                ('ppt', '演示文稿', '办公处理', '从大纲准备符合企业风格的演示。', 'ppt', '', '制作一份季度工作回顾演示。'),
                ('pdf', 'PDF 与资料整理', '办公处理', '提取资料要点，整理可检查的摘要。', 'general', '', '整理这些 PDF 资料的要点并标明来源。'),
                ('dingtalk', '钉钉', '沟通协作', '准备通知、群消息和工作提醒。', 'general', 'dingtalk', '准备一条钉钉通知，请先确认接收人、内容和发送时间。'),
                ('wecom', '企业微信', '沟通协作', '整理客户沟通内容与团队协作消息。', 'general', 'wecom', '准备一条企业微信工作消息，请先确认接收对象和内容。'),
                ('meeting', '会议纪要', '沟通协作', '整理会议记录，提取行动项和负责人。', 'general', '', '整理会议纪要，提取行动项、负责人和截止日期。'),
                ('oa', 'OA 审批', '审批流程', '查询待办、核对申请并准备审批意见。', 'general', 'oa', '整理我的 OA 审批待办，准备处理建议，提交前请我确认。'),
                ('expense', '报销材料检查', '审批流程', '核对报销要求，列出需要补齐的材料。', 'general', 'oa', '检查报销材料，列出缺失项目和需要确认的问题。'),
                ('daily', '每日工作整理', '自动化', '汇总任务、日程和需要跟进的事项。', 'general', '', '整理今天的工作、日程和待办，并给出优先顺序。'),
                ('reminder', '任务提醒', '自动化', '准备到期提醒和周期性工作安排。', 'general', '', '帮我准备周期性工作提醒，先确认规则和提醒对象。'),
            ]]


PLUGIN_INFO = [('办公文件处理', 'DOCX / XLSX / PDF 文件处理与预览', '内置'),
               ('模板 PPT', '保留原有 16 套模板与可编辑 PPTX 交付', '内置'),
               ('网页搜索', '保留网页检索与抓取能力', '内置'),
               ('图像生成', '按服务配置提供图像生成能力', '扩展'),
               ('智能体团队', '团队成员、共享任务与协作工具', '实验性'),
               ('终端与命令', '保留终端与命令执行配置', '内置'),
               ('语音输入', '保留本地语音转写入口', '实验性'),
               ('自动化任务', '保留按计划执行会话任务的入口', '实验性'),
               ('MCP 连接', '企业系统与外部工具服务', '扩展')]


@dataclass
class PrototypeState:
    org: str = '远山科技'
    brand: str = '序 · 企业工作台'
    dark: bool = False
    compact: bool = False
    page: str = 'home'
    scenario: str = 'general'
    assistant: str = '通用办公助手'
    draft: str = ''
    home_draft: str = ''
    home_attachments: list = field(default_factory=list)
    task_stage: str = '待确认'
    published: bool = False
    busy: bool = False
    execution: str = ''
    messages: list = field(default_factory=list)
    attachments: list = field(default_factory=list)
    linked_integrations: list = field(default_factory=list)
    linked_tools: list = field(default_factory=list)
    message_links: list = field(default_factory=list)
    reviews: list = field(default_factory=list)
    benches: list = field(default_factory=default_benches)
    agents: list = field(default_factory=default_agents)
    files: list = field(default_factory=default_files)
    plugins: dict = field(default_factory=lambda: {p[0]: p[0] not in ('图像生成', '智能体团队', '语音输入', '自动化任务') for p in PLUGIN_INFO})
    plugin_config: dict = field(default_factory=dict)
    market: set = field(default_factory=set)
    members: list = field(default_factory=list)
    external_policy: str = '发送前确认'
    phone: bool = False
    safe: bool = False
    setting: str = '模型与服务'
    bench_filter: str = '全部'
    bench_query: str = ''
    task_filter: str = '全部'
    file_filter: str = '全部资料'
    file_query: str = ''
    file_sort: str = '默认'
    plugin_filter: str = '全部'
    template: str = ''
    counter: int = 0
    today_items: list = field(default_factory=default_today_items)
    selected_item_id: str = ''
    active_item_id: str = ''
    conversation_key: str = 'general'
    conversations: dict = field(default_factory=dict)
    calendar_date: str = field(default_factory=lambda: date.today().isoformat())
    detail_return_page: str = 'home'
    general_conversation_key: str = 'general'
    conversation_query: str = ''
    account_sessions: dict = field(default_factory=dict)
    current_account_id: str = 'lin-xiao'
    directory: list = field(default_factory=lambda: deepcopy(list(TEAM_MEMBERS)))
    contact_id: str = 'chen-an'
    contact_query: str = ''
    contact_messages: dict = field(default_factory=dict)
    contact_drafts: dict = field(default_factory=dict)
    work_scope: str = '我负责的'
    drive_folders: list = field(default_factory=default_drive_folders)
    drive_folder_id: str = 'private:lin-xiao'
    drive_selected_id: str = ''
    drive_back: list = field(default_factory=list)
    drive_forward: list = field(default_factory=list)
    integration_plugins: list = field(default_factory=default_integrations)
    integration_query: str = ''
    customization_requests: list = field(default_factory=list)
    skills: list = field(default_factory=default_skills)
    skill_query: str = ''
    skill_category: str = '全部'
    announcements: list = field(default_factory=lambda: [
        dict(id='weekly', title='周报提交提醒', content='请在本周五下班前整理工作进展与下周计划，提交部门周报。',
             publisher='综合管理部', date=date.today().isoformat()),
        dict(id='knowledge', title='企业资料更新', content='差旅与报销制度示例已加入共享网盘，可在企业制度资料中查看。',
             publisher='行政服务', date=date.today().isoformat()),
        dict(id='security', title='账号使用提醒', content='请使用本人账号处理办公事项，并按实际工作需要设置共享资料的访问条件。',
             publisher='IT 服务', date=date.today().isoformat()),
    ])

    def member(self, member_id):
        return next((member for member in self.directory if member['id'] == member_id), None)

    @property
    def profile(self):
        return self.member(self.current_account_id)

    def save_profile(self, name, role, job, department, email='', phone=''):
        if not all(value.strip() for value in (name, role, job, department)):
            raise ValueError('请填写姓名、角色、岗位和部门')
        if email.strip() and ('@' not in email or '.' not in email.rsplit('@', 1)[-1]):
            raise ValueError('请填写有效的邮箱地址')
        self.profile.update(name=name.strip(), role=role.strip(), job=job.strip(),
                            department=department.strip(), email=email.strip(), phone=phone.strip())
        for item in self.today_items:
            if item.get('owner_id') == self.current_account_id:
                item['owner'] = self.profile['name']
            if item.get('initiator_id') == self.current_account_id:
                item['initiator'] = self.profile['name']
            for participant in item.get('participants', []):
                if participant['id'] == self.current_account_id:
                    participant['name'] = self.profile['name']

    def switch_account(self, member_id):
        if not self.member(member_id):
            raise ValueError('账号不存在')
        if member_id == self.current_account_id:
            return
        self.remember_conversation()
        fields = CONVERSATION_FIELDS + ('conversation_key', 'general_conversation_key', 'active_item_id', 'conversations')
        self.account_sessions[self.current_account_id] = {key: deepcopy(getattr(self, key)) for key in fields}
        self.current_account_id = member_id
        saved = self.account_sessions.get(member_id)
        defaults = dict(scenario='general', assistant='通用办公助手', draft='', messages=[], attachments=[],
                        template='', execution='', linked_integrations=[], linked_tools=[], message_links=[],
                        conversation_key=f'general:{member_id}',
                        general_conversation_key=f'general:{member_id}', active_item_id='', conversations={})
        for key in fields:
            setattr(self, key, deepcopy((saved or defaults)[key]))
        self.busy = False
        self.drive_folder_id = f'private:{member_id}'
        self.drive_selected_id = self.file_query = self.conversation_query = ''
        self.drive_back.clear()
        self.drive_forward.clear()

    def messages_with(self, member_id):
        return self.contact_messages.get(tuple(sorted((self.current_account_id, member_id))), [])

    def contact_draft(self, member_id):
        return self.contact_drafts.setdefault((self.current_account_id, member_id), dict(text='', attachments=[]))

    def send_contact_message(self, member_id, text, attachments=()):
        if not self.member(member_id) or member_id == self.current_account_id:
            raise ValueError('请选择其他成员')
        text = text.strip()
        if (not text and not attachments) or len(text) > 2000:
            raise ValueError('请填写消息，最多 2000 个字')
        if len(attachments) > 10 or any(not isinstance(name, str) or not name.strip() or len(name) > 255 for name in attachments):
            raise ValueError('每条消息最多附加 10 个文件名称')
        key = tuple(sorted((self.current_account_id, member_id)))
        self.contact_messages.setdefault(key, []).append(dict(sender=self.current_account_id, text=text,
                                                              attachments=list(attachments), time=datetime.now().strftime('%H:%M')))

    def linked_records(self, kind):
        records = self.integration_plugins if kind == 'integrations' else self.skills
        selected = self.linked_integrations if kind == 'integrations' else self.linked_tools
        return [record for record in records if record['id'] in selected]

    def skill_integration(self, skill):
        dependency = skill['integration']
        if not dependency:
            return None
        alias = {'dingtalk': '钉钉', 'wecom': '企业微信', 'oa': 'OA'}.get(dependency, dependency).casefold()
        return next((record for record in self.integration_plugins if record['id'] == dependency or
                     alias in record['system'].casefold()), None)

    def skill_link_status(self, skill):
        if not skill['integration']:
            return '办公技能'
        dependency = self.skill_integration(skill)
        if not dependency:
            return '待导入系统'
        return dependency['status'] if dependency['id'] in self.linked_integrations else '未关联系统'

    def set_chat_links(self, kind, record_ids):
        if kind not in ('integrations', 'tools'):
            raise ValueError('无效的关联类型')
        selected = list(dict.fromkeys(record_ids))
        records = self.integration_plugins if kind == 'integrations' else self.skills
        if any(record_id not in {record['id'] for record in records} for record_id in selected):
            raise ValueError('请选择当前可用的系统或工具')
        setattr(self, 'linked_' + kind, selected)
        if kind == 'tools':
            for skill in self.linked_records('tools'):
                dependency = self.skill_integration(skill)
                if dependency and dependency['id'] not in self.linked_integrations:
                    self.linked_integrations.append(dependency['id'])

    def message_link_snapshot(self):
        return dict(integrations=[dict(id=record['id'], name=record['system'], status=record['status'])
                                  for record in self.linked_records('integrations')],
                    tools=[dict(id=record['id'], name=record['name'], status=self.skill_link_status(record))
                           for record in self.linked_records('tools')])

    def item(self, item_id):
        return next((item for item in self.today_items if item['id'] == item_id), None)

    def today_groups(self):
        today = datetime.now().date().isoformat()
        pending = [item for item in self.today_items if item['date'] == today
                   and item['status'] not in ('已完成', '已取消')]
        timed = sorted((item for item in pending if item['time']), key=lambda item: (item['time'], item['id']))
        untimed = [item for item in pending if not item['time']]
        return timed, untimed

    def schedules_for(self, day):
        return sorted((item for item in self.today_items if item['kind'] == 'schedule'
                       and item['date'] == day and item['status'] != '已取消'),
                      key=lambda item: (item['time'], item['id']))

    def day_items(self, day):
        return sorted((item for item in self.today_items if item['date'] == day),
                      key=lambda item: (not bool(item['time']), item['time'], item['id']))

    def add_todo(self, title, day, time='', description='', owner_id=None, kind='todo', status='待处理'):
        owner = self.member(owner_id or self.current_account_id)
        title = title.strip()
        if not title or len(title) > 60:
            raise ValueError('请填写标题，最多 60 个字')
        if not owner or kind not in ('todo', 'task') or status not in TODO_STATUSES:
            raise ValueError('请选择有效的负责人和状态')
        try:
            day = date.fromisoformat(day).isoformat()
            if time:
                time = datetime.strptime(time, '%H:%M').strftime('%H:%M')
        except (ValueError, TypeError):
            raise ValueError('请填写有效的日期和时间') from None
        if len(description.strip()) > 2000:
            raise ValueError('说明最多 2000 个字')
        self.counter += 1
        item = dict(id=f'{kind}-{self.counter}', title=title, kind=kind, source='工作台 · 成员派发' if
                    owner['id'] != self.current_account_id else '工作台 · 自己创建', date=day, time=time,
                    status=status, initiator=self.profile['name'], initiator_id=self.current_account_id,
                    owner=owner['name'], owner_id=owner['id'], description=description.strip() or '暂无补充说明。', materials=[])
        self.today_items.append(item)
        return item

    def set_item_status(self, item_id, status):
        item = self.item(item_id)
        allowed = ('待参加', '进行中', '已完成', '已取消') if item and item['kind'] == 'schedule' else TODO_STATUSES
        if not item or status not in allowed:
            raise ValueError('请选择有效的事项状态')
        item['status'] = status

    def add_schedule(self, title, day, start, end, location='', description='', member_ids=()):
        title = title.strip()
        if not title or len(title) > 60:
            raise ValueError('请填写日程标题，最多 60 个字')
        try:
            day = date.fromisoformat(day).isoformat()
            start_time = datetime.strptime(start, '%H:%M')
            end_time = datetime.strptime(end, '%H:%M')
        except (ValueError, TypeError):
            raise ValueError('请填写有效的日期和时间') from None
        if end_time <= start_time:
            raise ValueError('结束时间需要晚于开始时间；跨日日程请分别创建')
        if len(location.strip()) > 120 or len(description.strip()) > 2000:
            raise ValueError('地点最多 120 个字，说明最多 2000 个字')
        directory = {member['id']: member for member in self.directory if member['id'] != self.current_account_id}
        selected = list(dict.fromkeys(member_ids))
        if any(member_id not in directory for member_id in selected):
            raise ValueError('请选择当前团队中可邀请的成员')
        self.counter += 1
        item = dict(id=f'schedule-{self.counter}', title=title, kind='schedule', source='工作台日历',
                    date=day, time=start_time.strftime('%H:%M'), end_time=end_time.strftime('%H:%M'),
                    status='待参加', initiator=self.profile['name'], owner=self.profile['name'],
                    initiator_id=self.current_account_id, owner_id=self.current_account_id,
                    description=description.strip() or '暂无补充说明。',
                    location=location.strip(), materials=[],
                    participants=[dict(id=member_id, name=directory[member_id]['name'], status='待回应')
                                  for member_id in selected])
        self.today_items.append(item)
        return item

    def remember_conversation(self):
        self.conversations[self.conversation_key] = {
            key: deepcopy(getattr(self, key)) for key in CONVERSATION_FIELDS}

    def activate_conversation(self, item_id=''):
        key = f'item:{item_id}' if item_id else self.general_conversation_key
        self.select_conversation(key, item_id)

    def select_conversation(self, key, item_id=None):
        if key == self.conversation_key:
            return
        self.remember_conversation()
        defaults = dict(scenario='general', assistant='通用办公助手', draft='', messages=[],
                        attachments=[], template='', execution='', linked_integrations=[], linked_tools=[], message_links=[])
        values = self.conversations.get(key, defaults)
        for name in CONVERSATION_FIELDS:
            setattr(self, name, deepcopy(values[name]))
        self.conversation_key = key
        self.active_item_id = key[5:] if key.startswith('item:') else ''
        if not self.active_item_id:
            self.general_conversation_key = key
        self.busy = False

    def conversation_entries(self):
        records = dict(self.conversations)
        records[self.conversation_key] = {name: getattr(self, name) for name in CONVERSATION_FIELDS}
        entries = []
        for key, values in reversed(list(records.items())):
            item = self.item(key[5:]) if key.startswith('item:') else None
            title = item['title'] if item else (values['messages'][0] if values['messages'] else
                    values['draft'].strip() or SCENARIOS.get(values['scenario'], ('新会话',))[0])
            if self.conversation_query.casefold() in title.casefold():
                entries.append((key, title))
        return entries

    def preferences(self):
        return dict(org=self.org, brand=self.brand, dark=self.dark, compact=self.compact)

    def review(self, decision, reason):
        if decision not in ('已完成', '已退回'):
            raise ValueError('无效任务状态')
        if decision == '已退回' and not reason.strip():
            raise ValueError('请填写修改要求')
        self.task_stage = decision
        self.reviews.append(dict(decision=decision, reason=reason.strip(), time=datetime.now().strftime('%H:%M:%S')))

    def new_conversation(self, scenario='general', assistant=None):
        self.remember_conversation()
        self.counter += 1
        self.conversation_key = self.general_conversation_key = f'general-{self.counter}'
        self.active_item_id = ''
        self.scenario = scenario
        self.assistant = assistant or SCENARIOS.get(scenario, ('', '通用办公助手'))[1]
        self.draft = ''
        self.busy = False
        self.execution = ''
        self.messages = []
        self.attachments = []
        self.template = ''
        self.linked_integrations = []
        self.linked_tools = []
        self.message_links = []

    def drive_record(self, record_id):
        return next((record for record in self.drive_folders + self.files if record['id'] == record_id), None)

    def drive_access(self, record, account_id=None):
        account_id = account_id or self.current_account_id
        if isinstance(record, str):
            if record.startswith('private:'):
                return 'manage' if record == f'private:{account_id}' else 'none'
            if record == 'shared':
                return 'edit'
            record = self.drive_record(record)
        if not record:
            return 'none'
        if record['space'] == 'private':
            return 'manage' if record['owner_id'] == account_id else 'none'
        parent_access = self.drive_access(record['parent'], account_id)
        if parent_access == 'none':
            return 'none'
        if record['owner_id'] == account_id:
            return 'manage'
        access = record['permissions'].get(account_id, record['default_access'])
        return ('edit' if parent_access == 'manage' else parent_access) if access == 'inherit' else access

    def drive_children(self, folder_id=None):
        parent = folder_id or self.drive_folder_id
        if self.drive_access(parent) == 'none':
            return []
        records = [record for record in self.drive_folders + self.files if record['parent'] == parent
                   and self.drive_access(record) != 'none' and self.file_query.casefold() in record['name'].casefold()]
        return sorted(records, key=lambda record: (record['kind'] != 'folder', record['name'].casefold()))

    def drive_path(self, folder_id=None):
        key = folder_id or self.drive_folder_id
        if key.startswith('private:'):
            return '私有网盘'
        if key == 'shared':
            return '共享网盘'
        record = self.drive_record(key)
        return self.drive_path(record['parent']) + ' / ' + record['name'] if record else ''

    def validate_drive_name(self, name, parent, ignore_id=''):
        name = name.strip()
        reserved = {'CON', 'PRN', 'AUX', 'NUL'} | {f'{prefix}{i}' for prefix in ('COM', 'LPT') for i in range(1, 10)}
        if not name or len(name) > 100 or any(char in name for char in '<>:"/\\|?*') or any(ord(c) < 32 for c in name) or name.endswith('.') or name.split('.')[0].upper() in reserved:
            raise ValueError('请填写有效名称，最多 100 字，不能包含 Windows 文件名特殊字符或保留名称')
        if any(record['parent'] == parent and record['name'].casefold() == name.casefold() and record['id'] != ignore_id
               for record in self.drive_folders + self.files):
            raise ValueError('当前文件夹已有同名文件或文件夹')
        return name

    def add_drive_record(self, name, kind='folder', size='—'):
        if self.drive_access(self.drive_folder_id) not in ('edit', 'manage'):
            raise ValueError('当前账号没有此文件夹的写入权限')
        name = self.validate_drive_name(name, self.drive_folder_id)
        self.counter += 1
        private = self.drive_folder_id.startswith('private:') or (self.drive_record(self.drive_folder_id) or {}).get('space') == 'private'
        record = dict(id=f'drive-{self.counter}', name=name, kind=kind, parent=self.drive_folder_id,
                      space='private' if private else 'shared', owner_id=self.current_account_id,
                      permissions={}, default_access='inherit', modified=date.today().isoformat(),
                      size=size, category='导入记录', source='本地选择 · 未解析', version='尚未建立版本', imported=True)
        (self.drive_folders if kind == 'folder' else self.files).append(record)
        return record

    def set_drive_permissions(self, record_id, default_access, permissions):
        record = self.drive_record(record_id)
        if self.drive_access(record) != 'manage' or record['space'] != 'shared':
            raise ValueError('仅所有者可以设置共享文件的账号权限')
        if default_access not in ('inherit', 'none', 'view', 'edit') or any(
                not self.member(key) or value not in ('none', 'view', 'edit') for key, value in permissions.items()):
            raise ValueError('请选择有效的账号与权限')
        record.update(default_access=default_access, permissions=dict(permissions))

    def rename_drive_record(self, record_id, name):
        record = self.drive_record(record_id)
        if self.drive_access(record) not in ('edit', 'manage'):
            raise ValueError('当前账号没有编辑权限')
        record['name'] = self.validate_drive_name(name, record['parent'], record_id)
        record['modified'] = date.today().isoformat()

    def import_integration(self, data):
        if not isinstance(data, dict):
            raise ValueError('插件清单需要是 JSON 对象')
        required = ('name', 'system', 'version', 'provider', 'description')
        if any(not isinstance(data.get(key), str) or not data[key].strip() or len(data[key]) > 200
               for key in required):
            raise ValueError('请填写有效的 name、system、version、provider、description')
        capabilities = data.get('capabilities')
        if not isinstance(capabilities, list) or not 1 <= len(capabilities) <= 30 or any(
                not isinstance(value, str) or not value.strip() or len(value) > 120 for value in capabilities):
            raise ValueError('capabilities 需要包含 1–30 项功能名称')
        if any(record['name'].casefold() == data['name'].strip().casefold() for record in self.integration_plugins):
            raise ValueError('已经导入同名插件')
        self.counter += 1
        record = {key: data[key].strip() for key in required}
        owner = data.get('owner', '待指定')
        if not isinstance(owner, str) or len(owner) > 100:
            raise ValueError('业务负责人字段无效')
        record.update(id=f'integration-{self.counter}', owner=owner.strip() or '待指定',
                      capabilities=[value.strip() for value in capabilities], status='待配置', address='', imported=True)
        self.integration_plugins.append(record)
        return record

    def add_bench(self, name, description, category):
        name, description = name.strip(), description.strip()
        if not name or not description:
            raise ValueError('请完整填写名称和说明')
        if any(b['name'] == name for b in self.benches):
            raise ValueError('已存在同名工作台')
        self.counter += 1
        self.benches.append(dict(key=f'custom-{self.counter}', name=name[:24], description=description[:160], category=category, tag='演示创建'))

    def save_agent(self, index, name, role, prompt):
        values = [v.strip() for v in (name, role, prompt)]
        if not all(values):
            raise ValueError('请完整填写助手名称、职责和指令')
        if any(a['name'] == values[0] and i != index for i, a in enumerate(self.agents)):
            raise ValueError('已存在同名助手')
        record = dict(zip(('name', 'role', 'prompt'), values))
        if index is None:
            self.agents.append(record)
        else:
            self.agents[index] = record


class PreferenceStore:
    """Only display preferences are persisted, with atomic replacement."""
    def __init__(self, directory):
        self.directory = Path(directory)
        self.path = self.directory / 'preferences.json'

    def load(self, state):
        if not self.path.exists():
            return ''
        try:
            data = json.loads(self.path.read_text(encoding='utf-8'))
            if not isinstance(data, dict):
                raise ValueError('设置格式不正确')
            for key, limit in [('org', 20), ('brand', 30)]:
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    setattr(state, key, value.strip()[:limit])
            for key in ('dark', 'compact'):
                if isinstance(data.get(key), bool):
                    setattr(state, key, data[key])
            return ''
        except (OSError, ValueError) as error:
            return f'偏好设置未能读取，已使用默认外观：{error}'

    def save(self, state):
        self.directory.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.tmp')
        temporary.write_text(json.dumps(state.preferences(), ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(temporary, self.path)


def report_text(state):
    return (f'{state.org} · 原型演示\n本周销售经营周报\n状态：{state.task_stage}\n'
            '以下为虚构示例，不来自真实文件。\n销售额：286,400 元；订单：48；新增客户：12。\n'
            '这是文本演示，不是 DOCX 文件或真实 Agent 输出。\n')
