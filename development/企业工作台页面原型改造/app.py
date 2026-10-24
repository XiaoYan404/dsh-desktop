"""Enterprise desktop prototype. Native PyQt5 widgets, local demonstration only."""
import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import sys
from datetime import date, timedelta
from urllib.parse import urlparse

from PyQt5.QtCore import Qt, QTimer, QObject, QEvent, QDate, QTime
from PyQt5.QtGui import QFont, QKeySequence
from PyQt5.QtNetwork import QLocalServer, QLocalSocket
from PyQt5.QtWidgets import (QApplication, QMainWindow, QWidget, QFrame, QLabel,
                             QVBoxLayout, QHBoxLayout, QGridLayout, QScrollArea,
                             QLineEdit, QTextEdit, QComboBox, QCheckBox, QTableWidget,
                             QTableWidgetItem, QHeaderView, QAbstractItemView,
                             QFileDialog, QListWidget, QListWidgetItem, QShortcut,
                             QMenu, QMessageBox, QSizePolicy, QDateEdit, QTimeEdit)
from prototype_model import (NAV, NAV_ICONS, PAGE_TITLES, ITEM_KINDS, TODO_STATUSES, ACCESS_LABELS, TEAM_MEMBERS, SCENARIOS, PLUGIN_INFO, PrototypeState,
                             PreferenceStore, report_text)
from qt_widgets import label, button, row, box, FormDialog, stylesheet, icon
from workbench_ui import WorkbenchView, ContactChatDialog


ROOT = Path(__file__).resolve().parent
SETTINGS = ['模型与服务', '本地工作区', '主题与显示', '手机连接', '更新与恢复', '隐私与数据']
MARKET = ['合同审核工作台', '内容运营工作台', '项目总控台']


class SearchKeys(QObject):
    def __init__(self, edit, results):
        super().__init__(edit)
        self.results = results
        edit.installEventFilter(self)

    def eventFilter(self, watched, event):
        if event.type() == QEvent.KeyPress and event.key() == Qt.Key_Down:
            self.results.setFocus(Qt.TabFocusReason)
            return True
        return super().eventFilter(watched, event)


class PrototypeWindow(WorkbenchView, QMainWindow):
    def __init__(self, data_dir=None, live_preview=False):
        super().__init__()
        self.live_preview = live_preview
        self.state = PrototypeState()
        self.store = PreferenceStore(data_dir or ROOT / '.preview-data')
        startup_notice = self.store.load(self.state)
        self.dialog = None
        self.contact_chat_window = None
        self.page_widget = None
        self.timer = QTimer(self)
        self.timer.setSingleShot(True)
        self.timer.timeout.connect(self.complete_execution)
        self.resize(1440, 900)
        self.setMinimumSize(1040, 700)
        self.setObjectName('enterprisePrototype')
        self.build_shell()
        self.apply_theme()
        self.navigate('home')
        self.shortcuts = [QShortcut(QKeySequence('Ctrl+K'), self, activated=self.search_dialog),
                          QShortcut(QKeySequence('Alt+N'), self, activated=self.new_task)]
        if startup_notice:
            self.notify(startup_notice)


    def notify(self, text):
        self.status.setText(text)

    def apply_theme(self):
        self.setStyleSheet(stylesheet(self.state.dark, self.state.compact))
        suffix = ' · 实时预览' if self.live_preview else ''
        self.setWindowTitle(f'{self.state.brand} — PyQt 工作台原型 V0.8{suffix}')

    def save_preferences(self):
        try:
            self.store.save(self.state)
            self.notify('外观偏好已保存到原型本地目录')
            return True
        except OSError as error:
            logging.exception('Preference save failed')
            self.notify(f'偏好未保存：{error}；当前界面仍可继续使用')
            return False

    def toggle_theme(self):
        self.state.dark = not self.state.dark
        self.apply_theme()
        self.save_preferences()
        self.render()

    def toggle_density(self):
        self.state.compact = not self.state.compact
        self.apply_theme()
        self.save_preferences()
        self.render()

    def navigate(self, page):
        if page not in PAGE_TITLES:
            return
        if page == 'home' and self.state.active_item_id:
            self.interrupt_for_context_switch()
            self.state.activate_conversation()
        self.state.page = page
        self.render()

    def render(self, focus_name=None, cursor=None):
        if self.page_widget:
            old = self.page_widget
            self.page_slot.removeWidget(old)
            old.hide()
            old.deleteLater()
        self.update_account_display()
        self.breadcrumb.setText(f'工作空间   /   {PAGE_TITLES[self.state.page]}')
        active_nav = self.state.detail_return_page if self.state.page == 'item_detail' else self.state.page
        active_nav = {'calendar': 'home', 'benches': 'plugins', 'agents': 'plugins'}.get(active_nav, active_nav)
        for key, b in self.nav_buttons.items():
            b.setChecked(key == active_nav)
            glyph = NAV_ICONS[key]
            b.setIcon(icon(glyph, '#69C8B6' if self.state.dark and key == active_nav else
                           '#28736B' if key == active_nav else '#A3AAA6' if self.state.dark else '#6D7470', 21))
        page = QWidget()
        page.setObjectName('pageScrollContent')
        layout = QVBoxLayout(page)
        padding = 22 if self.state.compact else 32
        layout.setContentsMargins(padding, 28, padding, 26)
        layout.setSpacing(20)
        if self.state.safe:
            layout.addWidget(row(label('安全模式演示 · 未禁用任何真实插件', 'notice'), button('退出演示', self.exit_safe, 'text')))
        getattr(self, f'page_{self.state.page}')(layout)
        if self.state.page in ('chat', 'home', 'knowledge', 'messages'):
            self.page_widget = page
        else:
            layout.addStretch()
            scroll = QScrollArea()
            scroll.setWidgetResizable(True)
            scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
            scroll.setWidget(page)
            self.page_widget = scroll
        self.page_slot.addWidget(self.page_widget)
        if focus_name:
            field = page.findChild(QLineEdit, focus_name)
            if field:
                field.setFocus()
                if cursor is not None:
                    field.setCursorPosition(cursor)


    def tabs(self, options, selected, callback):
        buttons = []
        for text in options:
            b = button(text, lambda t=text: callback(t), 'tab')
            b.setCheckable(True)
            b.setChecked(text == selected)
            buttons.append(b)
        return row(*buttons, None)

    def set_filter(self, key, value):
        setattr(self.state, key, value)
        self.render()

    def search_field(self, name, text, placeholder, key):
        edit = QLineEdit(text)
        edit.setObjectName(name)
        edit.setPlaceholderText(placeholder)
        edit.setAccessibleName(placeholder)
        edit.setClearButtonEnabled(True)
        edit.textChanged.connect(lambda t: self.live_search(key, t, name, edit.cursorPosition()))
        return edit

    def live_search(self, key, text, name, cursor):
        setattr(self.state, key, text)
        self.render(name, cursor)

    def grid(self, items, builder, columns=3):
        host = QWidget()
        grid = QGridLayout(host)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setSpacing(14)
        for i, item in enumerate(items):
            grid.addWidget(builder(item), i // columns, i % columns)
        for i in range(columns):
            grid.setColumnStretch(i, 1)
        if not items:
            grid.addWidget(label('没有找到匹配内容，请尝试其他名称或分类。', 'notice'), 0, 0, 1, columns)
        return host




    def start_prompt(self, text):
        if not text.strip():
            self.notify('请先描述任务，或直接进入销售工作台查看示例')
            return
        home_attachments = list(self.state.home_attachments)
        self.new_task()
        self.state.draft = text.strip()
        self.state.attachments = home_attachments
        self.state.home_draft = ''
        self.state.home_attachments.clear()
        self.render()

    def resizeEvent(self, event):
        super().resizeEvent(event)
        # Rebuild only when a responsive breakpoint is crossed. Drafts live in state.
        breakpoint = self.width() >= 1260
        previous = getattr(self, '_wide_layout', breakpoint)
        self._wide_layout = breakpoint
        height_breakpoint = self.height() >= 800
        previous_height = getattr(self, '_tall_layout', height_breakpoint)
        self._tall_layout = height_breakpoint
        if (previous != breakpoint or previous_height != height_breakpoint) and getattr(self, 'page_widget', None):
            self.render()

    def new_task(self):
        self.interrupt_for_context_switch()
        self.state.new_conversation()
        self.navigate('chat')

    def select_saved_conversation(self, key):
        if key != self.state.conversation_key and key not in self.state.conversations:
            return
        if key != self.state.conversation_key:
            self.interrupt_for_context_switch()
            self.state.select_conversation(key)
        self.navigate('chat')

    def update_account_display(self):
        profile = self.state.profile
        self.login_avatar.setText(profile['name'][:1])
        self.login_name.setText(profile['name'])
        self.login_role.setText(profile['role'])
        self.login_job.setText(profile['job'])
        self.login_avatar.setToolTip('查看和设置个人资料')

    def switch_account(self, account_id):
        if self.contact_chat_window:
            self.contact_chat_window.close()
        self.interrupt_for_context_switch()
        self.state.switch_account(account_id)
        self.navigate('home' if self.state.page in ('item_detail', 'chat') else self.state.page)
        self.notify('已切换演示账号：' + self.state.profile['name'])

    def profile_dialog(self):
        profile = self.state.profile
        d = self.new_dialog('个人资料', '查看和编辑当前账号的个人资料。修改在本次预览中保留。')
        d.layout.setSpacing(10)
        fields = QGridLayout()
        for index, (key, title) in enumerate([('name', '姓名'), ('role', '角色'), ('job', '岗位'),
                                              ('department', '部门'), ('email', '邮箱'), ('phone', '电话')]):
            edit = QLineEdit(profile[key])
            edit.setMaxLength(80)
            edit.setObjectName(key)
            edit.setAccessibleName(title)
            d.fields[key] = edit
            fields.addWidget(label(title, 'field'), (index // 2) * 2, index % 2)
            fields.addWidget(edit, (index // 2) * 2 + 1, index % 2)
        d.layout.addLayout(fields)
        d.layout.addWidget(label('账号  ' + profile['id'], 'caption'))
        accounts = QComboBox()
        accounts.setObjectName('profileAccount')
        for member in self.state.directory:
            accounts.addItem(member['name'] + ' · ' + member['role'], member['id'])
        accounts.setCurrentIndex(accounts.findData(self.state.current_account_id))
        def switch():
            account_id = accounts.currentData()
            d.accept()
            self.switch_account(account_id)
        d.layout.addWidget(row(label('演示账号', 'caption'), accounts,
                               button('切换账号', switch, 'text', 'switchProfileAccount')))
        def save():
            try:
                self.state.save_profile(**{key: d.value(key) for key in d.fields})
            except ValueError as error:
                d.fail(str(error))
                return
            d.accept()
            self.render()
            self.notify('个人资料已更新（本次预览）')
        return d.finish(save, '保存个人资料')

    def select_contact(self, member_id):
        self.state.contact_id = member_id
        self.render()

    def contact_message_dialog(self, member_id):
        member = self.state.member(member_id)
        if not member or member_id == self.state.current_account_id:
            self.notify('请选择其他成员开始聊天')
            return
        window = self.contact_chat_window
        if window is None:
            window = ContactChatDialog(self, member_id)
            self.contact_chat_window = window
            window.finished.connect(lambda result: self.contact_chat_closed(window))
        else:
            window.open_member(member_id)
        window.showNormal()
        window.raise_()
        window.activateWindow()
        window.input.setFocus()
        return window

    def contact_chat_closed(self, window):
        if self.contact_chat_window is window:
            self.contact_chat_window = None

    def contact_meeting(self, member_id):
        self.state.calendar_date = date.today().isoformat()
        self.create_schedule_dialog((member_id,))

    def create_todo_dialog(self, kind='todo', owner_id=None):
        origin = self.state.page
        title = '派发任务' if kind == 'task' else '新建待办'
        d = self.new_dialog(title, '安排负责人和截止日期，创建后可在日历与工作清单中继续处理。')
        d.layout.setSpacing(9)
        d.field('title', '任务标题' if kind == 'task' else '待办标题', limit=60)
        day_key = self.state.calendar_date if origin == 'calendar' else date.today().isoformat()
        selected = date.fromisoformat(day_key)
        day = QDateEdit(QDate(selected.year, selected.month, selected.day))
        day.setCalendarPopup(True)
        day.setDisplayFormat('yyyy-MM-dd')
        day.setObjectName('todoDate')
        specify_time = QCheckBox('指定截止时间')
        specify_time.setObjectName('todoHasTime')
        time = QTimeEdit(QTime(18, 0))
        time.setDisplayFormat('HH:mm')
        time.setObjectName('todoTime')
        time.setEnabled(False)
        specify_time.toggled.connect(time.setEnabled)
        d.layout.addWidget(label('截止日期与时间', 'field'))
        d.layout.addWidget(row(day, specify_time, time))
        owner = QComboBox()
        owner.setObjectName('todoOwner')
        owner.setAccessibleName('负责人')
        for member in self.state.directory:
            owner.addItem(member['name'] + ' · ' + member['department'], member['id'])
        owner.setCurrentIndex(owner.findData(owner_id or self.state.current_account_id))
        status = QComboBox()
        status.setObjectName('todoStatus')
        status.setAccessibleName('待办状态')
        status.addItems(TODO_STATUSES)
        d.layout.addWidget(row(label('负责人', 'field'), owner, label('状态', 'field'), status))
        d.field('description', '工作说明（可选）', multiline=True).setFixedHeight(88)
        def save():
            try:
                item = self.state.add_todo(d.value('title'), day.date().toString('yyyy-MM-dd'),
                                           time.time().toString('HH:mm') if specify_time.isChecked() else '',
                                           d.value('description'), owner.currentData(), kind, status.currentText())
            except ValueError as error:
                d.fail(str(error))
                return
            d.accept()
            if origin == 'calendar':
                self.state.calendar_date = item['date']
            if origin == 'messages' or origin == 'tasks':
                self.state.work_scope = '我负责的' if item['owner_id'] == self.state.current_account_id else '我派发的'
                self.state.task_filter = '全部'
            self.navigate('tasks' if origin == 'messages' else origin)
            self.notify(title + '已创建，负责人：' + item['owner'] + '（本次预览）')
        return d.finish(save, '创建任务' if kind == 'task' else '创建待办')

    def change_item_status(self, item_id, status):
        try:
            self.state.set_item_status(item_id, status)
        except ValueError as error:
            self.notify(str(error))
            return
        self.render()
        self.notify('事项状态已更新为：' + status)

    def start_scenario(self, key, assistant=None):
        self.interrupt_for_context_switch()
        self.state.new_conversation(key, assistant)
        if key != 'sales':
            self.state.draft = SCENARIOS.get(key, ('', '', '', '描述本次业务目标与所用资料。'))[3]
        self.navigate('chat')

    def interrupt_for_context_switch(self):
        self.timer.stop()
        if self.state.busy:
            self.state.busy = False
            self.state.execution = '演示处理已停止，可继续发送要求。'

    def open_today_item(self, item_id, origin='home'):
        if self.state.item(item_id) is None:
            self.notify('该事项暂不可用，请返回今日工作。')
            return
        self.state.selected_item_id = item_id
        self.state.detail_return_page = origin if origin in ('home', 'calendar', 'tasks') else 'home'
        self.navigate('item_detail')

    def open_calendar(self):
        self.state.calendar_date = date.today().isoformat()
        self.navigate('calendar')

    def select_calendar_date(self, day):
        self.state.calendar_date = day
        self.navigate('calendar')

    def shift_calendar_date(self, days):
        selected = date.fromisoformat(self.state.calendar_date) + timedelta(days=days)
        self.select_calendar_date(selected.isoformat())

    def create_schedule_dialog(self, participant_ids=()):
        d = self.new_dialog('新建日程', '安排时间，并选择参与成员。邀请仅在本次原型中记录。')
        d.layout.setContentsMargins(24, 20, 24, 20)
        d.layout.setSpacing(8)
        d.field('title', '日程标题', limit=60)
        times = QWidget()
        time_layout = QHBoxLayout(times)
        time_layout.setContentsMargins(0, 0, 0, 0)
        selected = date.fromisoformat(self.state.calendar_date)
        day = QDateEdit(QDate(selected.year, selected.month, selected.day))
        day.setCalendarPopup(True)
        day.setDisplayFormat('yyyy-MM-dd')
        start = QTimeEdit(QTime(9, 0))
        end = QTimeEdit(QTime(10, 0))
        for name, title, widget in [('date', '日期', day), ('start', '开始时间', start), ('end', '结束时间', end)]:
            widget.setObjectName('schedule_' + name)
            widget.setAccessibleName(title)
            if isinstance(widget, QTimeEdit):
                widget.setDisplayFormat('HH:mm')
            column = QVBoxLayout()
            column.setSpacing(5)
            column.addWidget(label(title, 'field'))
            column.addWidget(widget)
            time_layout.addLayout(column)
        d.layout.addWidget(times)
        d.field('location', '地点或会议链接（可选）', limit=120)
        d.field('description', '日程说明（可选）', multiline=True).setFixedHeight(56)
        d.layout.addWidget(label('邀请参与成员 · 可多选，' + self.state.profile['name'] + '作为发起人自动参与', 'field'))
        members = QListWidget()
        members.setObjectName('scheduleMembers')
        members.setAccessibleName('选择日程参与成员')
        members.setFixedHeight(76)
        for member in self.state.directory:
            if member['id'] == self.state.current_account_id:
                continue
            entry = QListWidgetItem(f'{member["name"]}  ·  {member["role"]}')
            entry.setData(Qt.UserRole, member['id'])
            entry.setFlags(entry.flags() | Qt.ItemIsUserCheckable)
            entry.setCheckState(Qt.Checked if member['id'] in participant_ids else Qt.Unchecked)
            members.addItem(entry)
        d.layout.addWidget(members)

        def save():
            member_ids = [members.item(index).data(Qt.UserRole) for index in range(members.count())
                          if members.item(index).checkState() == Qt.Checked]
            try:
                item = self.state.add_schedule(d.value('title'), day.date().toString('yyyy-MM-dd'),
                                               start.time().toString('HH:mm'), end.time().toString('HH:mm'),
                                               d.value('location'), d.value('description'), member_ids)
            except ValueError as error:
                d.fail(str(error))
                return
            d.accept()
            self.state.calendar_date = item['date']
            self.navigate('calendar')
            self.notify(f'日程已创建，已记录 {len(member_ids)} 位成员的参与邀请（演示，未发送通知）')

        return d.finish(save, '创建日程')

    def open_item_assistance(self, item_id):
        if self.state.item(item_id) is None:
            self.notify('该事项暂不可用，请返回今日工作。')
            return
        if self.state.conversation_key != f'item:{item_id}':
            self.interrupt_for_context_switch()
            self.state.activate_conversation(item_id)
        self.navigate('chat')

    def open_general_chat(self):
        if self.state.active_item_id:
            self.interrupt_for_context_switch()
            self.state.activate_conversation()
        self.navigate('chat')

    def chat_link_dialog(self, kind):
        integrations = kind == 'integrations'
        title = '关联公司系统' if integrations else '关联工作工具'
        description = ('选择本会话需要访问的系统。配置状态会显示在会话中。' if integrations else
                       '选择本会话使用的技能；存在对应系统插件时，同时关联依赖系统。')
        d = self.new_dialog(title, description)
        d.setMinimumWidth(620)
        context = (self.state.current_account_id, self.state.conversation_key)
        selected = set(self.state.linked_integrations if integrations else self.state.linked_tools)
        search = QLineEdit()
        search.setObjectName('chatLinkSearch')
        search.setPlaceholderText('搜索系统名称或功能' if integrations else '搜索工具或技能')
        d.layout.addWidget(search)
        listing = QListWidget()
        listing.setObjectName('chatLinkChoices')
        listing.setAccessibleName(title)
        listing.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        listing.setMinimumHeight(200)
        records = self.state.integration_plugins if integrations else self.state.skills
        def populate(query=''):
            listing.blockSignals(True)
            listing.clear()
            for record in records:
                name = record['system'] if integrations else record['name']
                if query.casefold() not in (name + record['description']).casefold():
                    continue
                status = record['status'] if integrations else record['category'] + ' · ' + self.state.skill_link_status(record)
                entry = QListWidgetItem(name + '  ·  ' + status)
                entry.setData(Qt.UserRole, record['id'])
                entry.setFlags(entry.flags() | Qt.ItemIsUserCheckable)
                entry.setCheckState(Qt.Checked if record['id'] in selected else Qt.Unchecked)
                entry.setToolTip(record['description'])
                listing.addItem(entry)
            listing.blockSignals(False)
        def change(entry):
            if entry.checkState() == Qt.Checked:
                selected.add(entry.data(Qt.UserRole))
            else:
                selected.discard(entry.data(Qt.UserRole))
        listing.itemChanged.connect(change)
        search.textChanged.connect(populate)
        populate()
        d.layout.addWidget(listing)
        d.layout.addWidget(label('关联只设置会话上下文；待配置的系统仍需完成企业集成。', 'caption'))
        def save():
            if context != (self.state.current_account_id, self.state.conversation_key):
                d.fail('当前会话已切换，请重新选择关联能力')
                return
            self.state.set_chat_links(kind, [record['id'] for record in records if record['id'] in selected])
            d.accept()
            self.render()
        return d.finish(save, '保存关联')

    def remove_chat_link(self, kind, record_id):
        selected = self.state.linked_integrations if kind == 'integrations' else self.state.linked_tools
        self.state.set_chat_links(kind, [key for key in selected if key != record_id])
        self.render()

    def message_link_text(self, index):
        if index >= len(self.state.message_links) or not self.state.message_links[index]:
            return ''
        snapshot = self.state.message_links[index]
        names = [record['name'] + '（' + record['status'] + '）' for record in snapshot['integrations'] + snapshot['tools']]
        return '本次关联：' + ' · '.join(names) if names else ''

    def announcement_dialog(self, index):
        if not 0 <= index < len(self.state.announcements):
            return
        record = self.state.announcements[index]
        d = self.new_dialog(record['title'], record['publisher'] + ' · ' + record['date'])
        d.layout.addWidget(label(record['content']))
        d.layout.addWidget(label('企业工作台演示公告', 'caption'))
        return d.finish()

    def page_chat(self, layout):
        scenario = SCENARIOS.get(self.state.scenario)
        item = self.state.item(self.state.active_item_id)
        title = item['title'] if item else scenario[0] if scenario else '开始一件新工作'
        actions = ([button('返回事项详情', lambda: self.open_today_item(item['id'], self.state.detail_return_page), 'quiet', 'chatItemDetails')]
                   if item else [])
        self.header(layout, title, '想法、资料与成果，都在同一张工作画布上。',
                    actions + [button('最近工作', lambda: self.navigate('tasks'), 'quiet'),
                     button('工作区', self.workspace_dialog, 'quiet')])
        split = QHBoxLayout()
        split.setSpacing(18)
        main, ml = box('composer', margin=22)
        ml.addWidget(row(label(self.state.assistant, 'cardTitle'), None, label('工作助手', 'tag')))
        transcript = QWidget()
        tr = QVBoxLayout(transcript)
        tr.setContentsMargins(3, 8, 3, 8)
        tr.setSpacing(15)
        if item:
            context, context_layout = box('inset', 16, 9)
            context.setObjectName('chatItemContext')
            context_layout.addWidget(label('关联事项 · ' + ITEM_KINDS[item['kind']], 'overline'))
            context_layout.addWidget(label(item['title'], 'cardTitle'))
            context_layout.addWidget(label(f'{item["source"]}  ·  {item["time"] or "待安排"}  ·  {item["status"]}', 'caption'))
            context_layout.addWidget(label(item['description'], 'muted'))
            if item['materials']:
                context_layout.addWidget(label('关联资料（示例）：' + ' · '.join(item['materials']), 'caption'))
            tr.addWidget(context)
            if not self.state.messages:
                tr.addWidget(label('输入你希望 Agent 协助的内容，发送后开始处理。', 'muted'))
        elif self.state.scenario == 'sales':
            tr.addWidget(label('你', 'cardTitle'))
            tr.addWidget(label(SCENARIOS['sales'][3]))
            tr.addWidget(label('销售明细_本周.xlsx     企业周报模板.docx', 'notice'))
            tr.addWidget(label('销售分析助手 · 示例过程', 'cardTitle'))
            tr.addWidget(label('✓ 读取示例资料，校验字段与统计周期\n\n✓ 汇总趋势与重点客户\n\n✓ 应用企业模板，准备周报草稿', 'muted'))
            if self.state.task_stage == '待确认':
                approval, al = box('approval', 17)
                al.addWidget(label('等待你的确认', 'cardTitle'))
                al.addWidget(label('拟创建：销售运营 / 交付物 / 本周销售周报.docx\n不覆盖原始资料，不对外发送。', 'muted'))
                al.addWidget(row(button('确认交付', self.approval_dialog, 'primary', 'approveTask'), button('退回修改', self.reject_dialog, name='rejectTask'), None))
                tr.addWidget(approval)
            else:
                tr.addWidget(label(f'任务{self.state.task_stage}，记录可在任务中心查看。', 'notice'))
        else:
            tr.addWidget(label('从这里，开始你的工作。', 'section'))
            tr.addWidget(label('说说目标，附上参考资料。这里可以一起整理思路、推进任务和检查成果。', 'muted'))
            tr.addWidget(button('使用建议：整理会议纪要并提取行动项', lambda: self.set_draft('整理会议纪要，提取行动项与责任人。'), 'text'))
        for index, message in enumerate(self.state.messages):
            tr.addWidget(label('你', 'cardTitle'))
            tr.addWidget(label(message))
            if self.message_link_text(index):
                tr.addWidget(label(self.message_link_text(index), 'caption'))
        if self.state.execution:
            tr.addWidget(label(self.state.execution, 'notice'))
        tr.addStretch()
        scroll = QScrollArea()
        scroll.setObjectName('chatTranscript')
        scroll.setWidgetResizable(True)
        scroll.setWidget(transcript)
        ml.addWidget(scroll, 1)
        attachment_names = ' · '.join(self.state.attachments)
        if attachment_names:
            names = label('仅记录文件名：' + attachment_names, 'muted')
            names.setMaximumHeight(46)
            names.setToolTip(attachment_names)
            ml.addWidget(names)
        if self.state.template:
            ml.addWidget(label('PPT 模板：' + self.state.template + '（演示）', 'tag'))
        ml.addWidget(self.chat_associations_panel())
        self.composer = QTextEdit()
        self.composer.setObjectName('chatInput')
        self.composer.setProperty('kind', 'prompt')
        self.composer.setAccessibleName('任务输入')
        self.composer.setAcceptRichText(False)
        self.composer.setFixedHeight(78 if not self.state.compact else 60)
        self.composer.setPlaceholderText('描述目标、交付格式与所用资料…')
        self.composer.setPlainText(self.state.draft)
        self.composer.textChanged.connect(lambda: setattr(self.state, 'draft', self.composer.toPlainText()))
        shortcut = QShortcut(QKeySequence('Ctrl+Return'), self.composer)
        shortcut.activated.connect(self.send_message)
        ml.addWidget(self.composer)
        ml.addWidget(row(button('附件', self.choose_files, 'text', 'attachFiles'),
                         button('PPT', self.template_dialog, 'text'), button('模型', self.model_dialog, 'text'),
                         button('工具库', lambda: self.navigate('plugins'), 'text'),
                         None,
                         button('停止' if self.state.busy else '发送 ↑', self.stop_execution if self.state.busy else self.send_message,
                                'primary', 'sendOrStop')))
        side, sil = box('tray', margin=18)
        side.setObjectName('chatMaterials')
        sil.addWidget(label('这件工作的资料', 'section'))
        workspace = scenario[2] if scenario else '待选择'
        sil.addWidget(label(f'工作区      {workspace}\n\n参考资料    {2 if self.state.scenario == "sales" else len(self.state.attachments)} 份\n\n执行权限    关键操作需确认', 'muted'))
        sil.addWidget(button('选择工作区', self.workspace_dialog, 'text'))
        sil.addWidget(label('会话关联能力', 'cardTitle'))
        for record in self.state.linked_records('integrations'):
            sil.addWidget(button(record['system'] + ' · ' + record['status'],
                                 lambda value=record: self.integration_details(value), 'text'))
        for record in self.state.linked_records('tools'):
            sil.addWidget(button(record['name'] + ' · ' + self.state.skill_link_status(record),
                                 lambda value=record: self.skill_dialog(value), 'text'))
        if not self.state.linked_integrations and not self.state.linked_tools:
            sil.addWidget(label('尚未关联系统或工具', 'caption'))
        sil.addWidget(label('交付物', 'section'))
        if self.state.scenario == 'sales':
            paper, paper_layout = box('hero', 17)
            paper_layout.addWidget(label('WEEKLY REPORT', 'eyebrow'))
            paper_layout.addWidget(label('本周销售经营周报', 'cardTitle'))
            paper_layout.addWidget(label('销售额  ¥286,400\n成交订单  48\n新增客户  12\n\n虚构示例数据', 'muted'))
            sil.addWidget(paper)
            sil.addWidget(button('查看预览', self.report_dialog, name='previewReport'))
            sil.addWidget(button('下载演示文本', self.download_report, 'text', 'downloadReport'))
        else:
            sil.addWidget(label('尚未生成交付物\n任务结果将在这里预览。', 'notice'))
        sil.addStretch()
        sil.addWidget(label('原型演示 · 所有成果为示例', 'caption'))
        split.addWidget(main, 1)
        split.addWidget(self.conversation_sidebar(side))
        layout.addLayout(split, 1)

    def set_draft(self, text):
        self.state.draft = text
        self.render()
        self.composer.setFocus()

    def send_message(self):
        text = self.state.draft.strip()
        if not text:
            self.notify('请先描述任务')
            return
        if self.state.busy:
            return
        while len(self.state.message_links) < len(self.state.messages):
            self.state.message_links.append(None)
        self.state.message_links.append(self.state.message_link_snapshot())
        self.state.messages.append(text)
        self.state.draft = ''
        self.state.busy = True
        self.state.execution = '正在模拟整理任务…'
        self.timer.start(1700)
        if self.state.page == 'home':
            self.navigate('chat')
        else:
            self.render()

    def complete_execution(self):
        self.state.busy = False
        self.state.execution = '演示执行完成。未调用模型，未读写业务文件。'
        if self.state.page in ('chat', 'home'):
            self.render()
        self.notify('演示任务状态已更新')

    def stop_execution(self):
        self.timer.stop()
        self.state.busy = False
        self.state.execution = '演示执行已停止，可以修改要求后重新发送。'
        self.render()


    def table(self, headers, rows, name=''):
        table = QTableWidget(len(rows), len(headers))
        table.setObjectName(name)
        table.setAccessibleName(name or '数据表格')
        table.setHorizontalHeaderLabels(headers)
        table.verticalHeader().hide()
        table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        table.setSelectionBehavior(QAbstractItemView.SelectRows)
        table.setSelectionMode(QAbstractItemView.SingleSelection)
        table.setAlternatingRowColors(True)
        table.setShowGrid(False)
        table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        table.verticalHeader().setDefaultSectionSize(48)
        for r, record in enumerate(rows):
            for c, value in enumerate(record):
                item = QTableWidgetItem(str(value))
                item.setToolTip(str(value))
                table.setItem(r, c, item)
        table.setMinimumHeight(min(320, 46 + max(len(rows), 1) * 48))
        table.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        return table





    def page_agents(self, layout):
        self.header(layout, '和你的助手一起工作', '把常用的经验和方法，交给熟悉这项工作的助手。',
                    [button('导入 .dshpreset', self.import_preset), button('创建助手', lambda: self.agent_dialog(), 'primary', 'createAgent')])
        def card_builder(pair):
            index, agent = pair
            card, cl = box()
            cl.addWidget(row(label(agent['name'][:1], 'logo'), None, label('企业 Preset · 演示', 'tag')))
            cl.addWidget(label(agent['name'], 'cardTitle'))
            cl.addWidget(label(agent['role'], 'muted'), 1)
            cl.addWidget(row(button('配置助手', lambda: self.agent_dialog(index), 'text'), None,
                             button('开始会话 ↗', lambda: self.start_scenario('general', agent['name']), 'text')))
            return card
        layout.addWidget(self.grid(list(enumerate(self.state.agents)), card_builder))
        layout.addWidget(label('正式产品保留 Preset 导入导出、冲突检查、Skills、MCP 与工具组合。原型仅导出 JSON 示例，不生成真实 .dshpreset。', 'notice'))
        layout.addWidget(row(button('全部工具与能力', lambda: self.navigate('plugins')), None))

    def legacy_tools(self, layout):
        self.header(layout, '你的工作工具箱', '文件、演示、检索与自动化，按工作的需要组合。',
                    [button('社区市场', self.market_dialog), button('添加能力', lambda: self.info('添加能力', '正式产品继续使用原插件、Skills 与 MCP 配置流程。原型不安装依赖。'))])
        layout.addWidget(self.tabs(['全部', '内置', '扩展', '实验性'], self.state.plugin_filter,
                                   lambda v: self.set_filter('plugin_filter', v)))
        def plugin_card(record):
            name, desc, group = record
            card, cl = box()
            enabled = QCheckBox('演示启用')
            enabled.setObjectName('plugin_' + name)
            enabled.setChecked(self.state.plugins[name])
            enabled.clicked.connect(lambda value, n=name: self.toggle_plugin(n, value))
            cl.addWidget(row(label(name, 'cardTitle'), None, enabled))
            cl.addWidget(label(desc, 'muted'), 1)
            cl.addWidget(row(label(group, 'tag'), None, button('配置 →', lambda: self.plugin_dialog(name), 'text')))
            return card
        layout.addWidget(self.grid([p for p in PLUGIN_INFO if self.state.plugin_filter in ('全部', p[2])], plugin_card))
        layout.addWidget(label('演示开关 ≠ 安装完成 ≠ 运行依赖就绪 ≠ 实际激活。不会修改原应用插件。', 'notice'))

    def open_plugins(self, group):
        self.state.plugin_filter = group
        self.state.skill_category = '底层能力'
        self.navigate('plugins')

    def page_admin(self, layout):
        self.header(layout, '团队的工作空间', '品牌、成员和协作规则，在这里一起安排。', [label('拟新增企业层', 'tag')])
        layout.addWidget(label('成员、共享知识、策略与审计是设计方案；前端显隐不能代替真实权限校验。', 'notice'))
        columns = QHBoxLayout()
        brand, bl = box()
        bl.addWidget(label('品牌与组织', 'section'))
        self.org_input = QLineEdit(self.state.org)
        self.org_input.setObjectName('orgName')
        self.org_input.setAccessibleName('企业名称')
        self.org_input.setMaxLength(20)
        self.brand_input = QLineEdit(self.state.brand)
        self.brand_input.setObjectName('brandName')
        self.brand_input.setAccessibleName('应用名称')
        self.brand_input.setMaxLength(30)
        bl.addWidget(label('企业名称'))
        bl.addWidget(self.org_input)
        bl.addWidget(label('应用名称'))
        bl.addWidget(self.brand_input)
        bl.addWidget(label('只保存名称、主题与密度；会话、附件、邀请和策略不持久化。', 'muted'))
        bl.addWidget(button('保存外观偏好', self.save_brand, 'primary', 'saveBrand'))
        members, ml = box()
        ml.addWidget(row(label('成员与角色', 'section'), None, button('权限矩阵', self.permissions_dialog, 'text')))
        ml.addWidget(label('林晓 · 管理员\n\n陈安 · 业务负责人\n\n许宁 · 成员'))
        ml.addWidget(label(f'本次已保存 {len(self.state.members)} 份邀请草稿，未发送。', 'muted'))
        ml.addWidget(button('创建邀请草稿', self.invite_dialog, name='inviteMember'))
        ml.addStretch()
        columns.addWidget(brand)
        columns.addWidget(members)
        layout.addLayout(columns)
        governance, gl = box()
        gl.addWidget(label('数据与操作治理', 'section'))
        gl.addWidget(label(f'当前演示策略：{self.state.external_policy} · 文件覆盖需确认', 'muted'))
        gl.addWidget(row(button('编辑操作策略', self.policy_dialog), button('查看本次审计', self.review_dialog), None))
        layout.addWidget(governance)

    def save_brand(self):
        org, brand = self.org_input.text().strip(), self.brand_input.text().strip()
        if not org or not brand:
            self.notify('请填写企业名称和应用名称')
            return
        self.state.org, self.state.brand = org, brand
        self.apply_theme()
        self.save_preferences()
        self.render()

    def page_settings(self, layout):
        self.header(layout, '让工作台更顺手', '选择你的模型、工作区与桌面偏好。')
        tabs = QWidget()
        tl = QHBoxLayout(tabs)
        tl.setContentsMargins(0, 0, 0, 0)
        menu = QWidget()
        menu.setFixedWidth(162)
        m = QVBoxLayout(menu)
        m.setContentsMargins(0, 0, 10, 0)
        for name in SETTINGS:
            b = button(name, lambda n=name: self.set_filter('setting', n), 'nav')
            b.setCheckable(True)
            b.setChecked(name == self.state.setting)
            m.addWidget(b)
        m.addStretch()
        panel, pl = box()
        pl.addWidget(label(self.state.setting, 'section'))
        selected = self.state.setting
        if selected == '模型与服务':
            pl.addWidget(label('保留多模型配置。原型不连接服务，也不接收真实 API Key。', 'muted'))
            for name in ['DeepSeek', 'Anthropic', '企业网关 / 自托管服务']:
                pl.addWidget(row(label(name, 'cardTitle'), label('未连接', 'tag'), None, button('配置', self.model_dialog)))
        elif selected == '本地工作区':
            pl.addWidget(label('沿用原生文件夹选择与工作区管理，原型不绑定或扫描磁盘目录。', 'muted'))
            for name in ['销售运营', '品牌与市场']:
                pl.addWidget(row(label(name, 'cardTitle'), None, button('查看范围', self.workspace_dialog)))
        elif selected == '主题与显示':
            pl.addWidget(label('原生窗口支持拖动、缩放、最小化和关闭；菜单中可切换全屏。', 'muted'))
            pl.addWidget(row(label('当前主题：' + ('墨石' if self.state.dark else '纸白')), None, button('切换浅深主题', self.toggle_theme, name='toggleTheme')))
            pl.addWidget(row(label('布局密度：' + ('紧凑' if self.state.compact else '标准')), None, button('切换密度', self.toggle_density)))
        elif selected == '手机连接':
            pl.addWidget(label('保留局域网与临时公网配对入口。本原型不会启动网络隧道。', 'muted'))
            pl.addWidget(row(label('演示状态：' + ('已配对' if self.state.phone else '未配对')), None, button('查看连接流程', self.phone_dialog)))
        elif selected == '更新与恢复':
            for title, description, callback in [('应用更新', '用户决定是否下载、重启并安装', self.update_dialog),
                                                  ('安全模式', '保留独立的故障恢复入口', self.safe_dialog),
                                                  ('运行日志', '只展示并导出不含凭据的示例', self.logs_dialog),
                                                  ('重启服务', '原型没有实际 Agent 服务', lambda: self.info('重启服务', '正式应用调用原宿主重启逻辑。原型不会启动或重启后台服务。'))]:
                pl.addWidget(row(label(title, 'cardTitle'), label(description, 'muted'), None, button('查看', callback)))
        else:
            pl.addWidget(label('本地保存不等于离线推理。调用云模型时，参与推理的文本与文件内容可能发送到服务商。', 'notice'))
            pl.addWidget(label('产品统计与反馈\n正式改造需明确配置埋点和遥测。\n\n会话与工作区\n沿用原项目持久化与升级机制。\n\n本原型\n仅保存外观偏好，不收集凭据；演示状态关闭即清空。', 'muted'))
        pl.addStretch()
        tl.addWidget(menu)
        tl.addWidget(panel, 1)
        layout.addWidget(tabs)

    def dialog_closed(self, result):
        self.dialog = None

    def new_dialog(self, title, description=''):
        if self.dialog:
            self.dialog.close()
        self.dialog = FormDialog(self, title, description)
        return self.dialog

    def info(self, title, description):
        return self.new_dialog(title, description).finish()

    def bench_dialog(self, record):
        scenario = SCENARIOS.get(record['key'], (record['name'], '企业助手', '所选工作区', '', '待确定'))
        d = self.new_dialog(record['name'], record['description'])
        d.layout.addWidget(label('01  选择资料与模板\n\n02  整理目标与执行步骤\n\n03  检查结果并确认交付', 'notice'))
        d.layout.addWidget(label(f'默认工作区：{scenario[2]}\n执行助手：{scenario[1]}\n预期交付：{scenario[4]}', 'muted'))
        def start():
            d.accept()
            self.start_scenario(record['key'])
        return d.finish(start, '进入任务')

    def create_bench_dialog(self):
        d = self.new_dialog('创建企业工作台', '仅在本次原型内添加业务入口，不创建真实插件。')
        d.field('name', '工作台名称', limit=24)
        d.field('description', '业务说明', multiline=True)
        d.field('category', '业务分类', options=['销售运营', '行政协作', '品牌营销', '知识服务'])
        def save():
            try:
                self.state.add_bench(d.value('name'), d.value('description'), d.value('category'))
            except ValueError as e:
                d.fail(e)
                return
            self.state.bench_filter, self.state.bench_query = '全部', ''
            d.accept()
            self.navigate('benches')
            self.notify('演示工作台已创建，关闭程序后不保留')
        return d.finish(save, '创建演示工作台')

    def approval_dialog(self):
        d = self.new_dialog('确认交付销售周报', '本次只更改演示状态，不会创建真实 DOCX 文件。')
        d.layout.addWidget(label('操作：创建新报告\n目标：销售运营 / 交付物\n文件：本周销售周报.docx\n范围：不覆盖原始资料，不对外发送', 'notice'))
        def confirm():
            self.state.review('已完成', '创建周报，不覆盖原始资料，不外发')
            d.accept()
            self.render()
            self.notify('演示交付已确认，可查看本次审批记录')
        return d.finish(confirm, '确认交付（演示）')

    def reject_dialog(self):
        d = self.new_dialog('退回修改', '保留修改原因，不改变原始资料。')
        d.field('reason', '修改要求', multiline=True)
        def save():
            try:
                self.state.review('已退回', d.value('reason'))
            except ValueError as e:
                d.fail(e)
                return
            d.accept()
            self.render()
            self.notify('已记录退回原因')
        return d.finish(save, '退回并记录')

    def review_dialog(self):
        d = self.new_dialog('本次审批与审计记录', '只记录原型交互，不是服务器审计日志。')
        if self.state.reviews:
            d.layout.addWidget(self.table(['时间', '操作者', '决定', '原因'], [(r['time'], '林晓', r['decision'], r['reason']) for r in self.state.reviews]))
        else:
            d.layout.addWidget(label('尚未处理任务。确认或退回销售周报后可在这里查看。', 'notice'))
        return d.finish()

    def report_dialog(self):
        d = self.new_dialog('本周销售经营周报 · 演示预览', f'{self.state.org} / WEEKLY REPORT')
        d.layout.addWidget(label('统计周期：2026.10.05 — 2026.10.11\n当前状态：' + self.state.task_stage, 'muted'))
        d.layout.addWidget(self.table(['指标', '本周', '环比'], [('销售额', '¥286,400', '+12.8%'), ('成交订单', '48', '+6'), ('新增客户', '12', '+3')]))
        d.layout.addWidget(label('经营摘要：华东区域贡献主要增量。建议跟进报价阶段客户。\n\n以上数据完全虚构，未解析任何真实附件。', 'notice'))
        d.actions.addWidget(button('下载演示文本', self.download_report))
        return d.finish()

    def save_text(self, filename, text, filter_text='文本文件 (*.txt)'):
        path, _ = QFileDialog.getSaveFileName(self, '保存演示文件', str(Path.home() / 'Downloads' / filename), filter_text)
        if not path:
            self.notify('已取消保存')
            return False
        try:
            Path(path).write_text(text, encoding='utf-8-sig')
            self.notify('已保存演示文件：' + Path(path).name)
            return True
        except OSError as e:
            self.notify(f'保存失败：{e}')
            logging.exception('Demo export failed')
            return False

    def download_report(self):
        return self.save_text('销售周报_原型演示.txt', report_text(self.state))

    def open_drive_folder(self, folder_id, remember=True):
        record = self.state.drive_record(folder_id)
        if self.state.drive_access(folder_id) == 'none' or (record and record['kind'] != 'folder'):
            self.notify('当前账号无权打开此文件夹')
            return
        if remember and folder_id != self.state.drive_folder_id:
            self.state.drive_back.append(self.state.drive_folder_id)
            self.state.drive_forward.clear()
        self.state.drive_folder_id = folder_id
        self.state.drive_selected_id = self.state.file_query = ''
        self.navigate('knowledge')

    def drive_navigate(self, direction):
        current = self.state.drive_folder_id
        if direction == 'up':
            record = self.state.drive_record(current)
            if record:
                self.open_drive_folder(record['parent'])
            return
        source = self.state.drive_back if direction == 'back' else self.state.drive_forward
        dest = self.state.drive_forward if direction == 'back' else self.state.drive_back
        while source:
            target = source.pop()
            if self.state.drive_access(target) != 'none':
                dest.append(current)
                self.open_drive_folder(target, remember=False)
                return

    def select_drive_record(self, record_id):
        self.state.drive_selected_id = record_id
        record = self.state.drive_record(record_id)
        access = self.state.drive_access(record)
        self.drive_permissions_button.setEnabled(record is not None and access != 'none')
        self.drive_rename_button.setEnabled(access in ('edit', 'manage'))
        self.drive_use_button.setEnabled(bool(record and record['kind'] != 'folder' and access != 'none'))

    def open_drive_record(self, record_id):
        record = self.state.drive_record(record_id)
        if self.state.drive_access(record) == 'none':
            self.notify('当前账号无权访问此项目')
            return
        if record['kind'] == 'folder':
            self.open_drive_folder(record_id)
        else:
            self.file_dialog(record)

    def new_drive_folder_dialog(self):
        d = self.new_dialog('新建文件夹', '位置：' + self.state.drive_path())
        d.field('name', '文件夹名称', limit=100)
        def save():
            try:
                self.state.add_drive_record(d.value('name'))
            except ValueError as error:
                d.fail(str(error))
                return
            d.accept()
            self.render()
        return d.finish(save, '创建文件夹')

    def rename_drive_dialog(self):
        record = self.state.drive_record(self.state.drive_selected_id)
        if self.state.drive_access(record) not in ('edit', 'manage'):
            self.notify('当前账号没有编辑权限')
            return
        d = self.new_dialog('重命名', '修改本次预览中的名称。')
        d.field('name', '名称', record['name'], limit=100)
        def save():
            try:
                self.state.rename_drive_record(record['id'], d.value('name'))
            except ValueError as error:
                d.fail(str(error))
                return
            d.accept()
            self.render()
        return d.finish(save, '保存名称')

    def drive_permissions_dialog(self, record_id=None):
        record = self.state.drive_record(record_id or self.state.drive_selected_id)
        access = self.state.drive_access(record)
        if not record or access == 'none':
            self.notify('请选择当前账号可访问的文件或文件夹')
            return
        d = self.new_dialog('访问权限 · ' + record['name'], '按账号设置访问条件；文件夹权限会影响下级内容的可见范围。')
        d.setMinimumWidth(660)
        owner = self.state.member(record['owner_id'])
        d.layout.addWidget(label('所有者：' + owner['name'] + '   ·   ' + ('私有网盘' if record['space'] == 'private' else '共享网盘'), 'notice'))
        if record['space'] == 'private':
            d.layout.addWidget(label('私有网盘仅所属账号可以访问。需要与同事协作时，请将资料添加到共享网盘。', 'muted'))
            return d.finish()
        editable = access == 'manage'
        levels = ['inherit', 'none', 'view', 'edit']
        default = d.field('defaultAccess', '默认访问条件', ACCESS_LABELS[record['default_access']],
                          options=[ACCESS_LABELS[key] for key in levels])
        default.setEnabled(editable)
        table = self.table(['账号', '部门 / 岗位', '账号权限'], [], 'drivePermissionTable')
        table.setRowCount(len(self.state.directory))
        table.setFixedHeight(48 * len(self.state.directory) + 50)
        controls = {}
        for index, member in enumerate(self.state.directory):
            table.setItem(index, 0, QTableWidgetItem(member['name']))
            table.setItem(index, 1, QTableWidgetItem(member['department'] + ' / ' + member['job']))
            if member['id'] == record['owner_id']:
                table.setItem(index, 2, QTableWidgetItem('所有者 · 完全控制'))
                continue
            combo = QComboBox()
            combo.setObjectName('permission_' + member['id'])
            combo.setAccessibleName(member['name'] + '的权限')
            for title, key in [('跟随默认', 'inherit'), ('不可见', 'none'), ('可查看', 'view'), ('可编辑', 'edit')]:
                combo.addItem(title, key)
            combo.setCurrentIndex(combo.findData(record['permissions'].get(member['id'], 'inherit')))
            combo.setEnabled(editable)
            controls[member['id']] = combo
            table.setCellWidget(index, 2, combo)
        d.layout.addWidget(table)
        d.layout.addWidget(label('本原型演示账号权限；正式部署需由企业服务端校验。', 'caption'))
        def save():
            overrides = {member_id: combo.currentData() for member_id, combo in controls.items()
                         if combo.currentData() != 'inherit'}
            try:
                self.state.set_drive_permissions(record['id'], levels[default.currentIndex()], overrides)
            except ValueError as error:
                d.fail(str(error))
                return
            d.accept()
            self.render()
            self.notify('账号访问条件已更新（本次预览）')
        return d.finish(save if editable else None, '保存访问条件')

    def import_integration_dialog(self):
        path, _ = QFileDialog.getOpenFileName(self, '导入企业系统插件清单', '', '插件清单 (*.json)')
        if not path:
            self.notify('已取消导入插件')
            return
        try:
            with Path(path).open('rb') as stream:
                raw = stream.read(256 * 1024 + 1)
            if len(raw) > 256 * 1024:
                raise ValueError('插件清单不能超过 256 KB')
            record = self.state.import_integration(json.loads(raw.decode('utf-8-sig')))
        except (OSError, UnicodeError, ValueError, RecursionError) as error:
            self.info('导入未完成', str(error))
            return
        self.state.integration_query = ''
        self.navigate('integrations')
        self.integration_details(record)
        self.notify('已导入插件清单（原型未安装或执行插件）')

    def integration_details(self, record):
        d = self.new_dialog(record['system'], record['description'])
        d.layout.setSpacing(10)
        d.layout.addWidget(label(f'插件：{record["name"]}\n版本：{record["version"]}\n开发方：{record["provider"]}\n业务负责人：{record["owner"]}\n状态：{record["status"]}', 'notice'))
        d.layout.addWidget(label('Agent 可使用的功能', 'field'))
        d.layout.addWidget(label('\n'.join('· ' + value for value in record['capabilities']), 'muted'))
        d.field('address', '公司系统地址（可选）', record['address'])
        d.layout.addWidget(label('保存配置后进入待联调状态；本次预览不连接系统，也不保存密钥。', 'caption'))
        def save():
            address = d.value('address')
            parsed = urlparse(address)
            if address and (parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password):
                d.fail('请填写有效的 http/https 系统地址，凭据应由正式连接器单独配置')
                return
            record['address'] = address
            record['status'] = '已配置 · 待联调' if address else '待配置'
            d.accept()
            self.render()
        d.actions.addWidget(button('联系产品公司定制', lambda: self.customization_dialog(record['system']), 'text'))
        return d.finish(save, '保存配置')

    def customization_dialog(self, system=''):
        d = self.new_dialog('系统与技能定制', '描述公司使用的系统和工作需求，交由产品公司评估开发与集成。')
        d.field('system', '系统或技能名称', system, limit=80)
        d.field('contact', '联系人', self.state.profile['name'], limit=80)
        d.field('requirements', '希望 Agent 完成哪些工作', multiline=True)
        d.layout.addWidget(label('原型仅保存本次需求草稿，未提交给产品公司。', 'caption'))
        def save():
            values = {key: d.value(key) for key in d.fields}
            if not all(values.values()):
                d.fail('请填写系统名称、联系人和需求说明')
                return
            self.state.customization_requests.append(values)
            d.accept()
            self.notify('定制需求草稿已保存（未对外发送）')
        return d.finish(save, '保存需求草稿')

    def integration_import_help(self):
        sample = dict(name='钉钉企业协作插件', system='钉钉', version='1.0.0', provider='企业交付团队',
                      description='工作消息与协作提醒', owner='综合管理部', capabilities=['准备通知', '查询工作待办'])
        d = self.new_dialog('导入插件说明', '由产品公司交付适配本公司的插件。原型接收 JSON 清单，用于查看系统和能力。')
        preview = QTextEdit()
        preview.setReadOnly(True)
        preview.setPlainText(json.dumps(sample, ensure_ascii=False, indent=2))
        preview.setFixedHeight(220)
        d.layout.addWidget(preview)
        d.actions.addWidget(button('导出演示清单', lambda: self.save_text('企业系统插件示例.json',
                              json.dumps(sample, ensure_ascii=False, indent=2), 'JSON 文件 (*.json)'), 'text'))
        return d.finish()

    def skill_dialog(self, skill):
        d = self.new_dialog(skill['name'], skill['description'])
        integration = next((record for record in self.state.integration_plugins if
                           record['id'] == skill['integration'] or record['system'] == skill['name'] or
                           skill['name'] in record['system']), None) if skill['integration'] else None
        d.layout.addWidget(label('技能分类：' + skill['category'], 'tag'))
        d.layout.addWidget(label('可以这样开始：\n' + skill['instruction'], 'notice'))
        if skill['integration']:
            d.layout.addWidget(label('关联集成：' + (integration['system'] + ' · ' + integration['status'] if integration else
                                                  '待导入对应企业系统插件'), 'muted'))
            def open_integration():
                d.accept()
                self.navigate('integrations')
                if integration:
                    self.integration_details(integration)
            d.actions.addWidget(button('查看系统集成', open_integration, 'text'))
        def start():
            d.accept()
            if self.state.page != 'chat':
                self.start_scenario(skill['scenario'])
            self.state.set_chat_links('tools', self.state.linked_tools + [skill['id']])
            self.state.draft = skill['instruction']
            self.navigate('chat')
            self.notify('技能要求已带入 AI 会话，请确认后发送')
        return d.finish(start, '在 AI 会话中使用')

    def add_skill_dialog(self):
        d = self.new_dialog('添加工作技能', '配置技能入口与工作要求。需要新的系统能力时，可联系产品公司定制开发。')
        d.field('name', '技能名称', limit=40)
        d.field('category', '分类', options=['办公处理', '沟通协作', '审批流程', '自动化'])
        d.field('instruction', '使用这个技能时需要做什么', multiline=True)
        def save():
            if not d.value('name') or not d.value('instruction'):
                d.fail('请填写技能名称和工作要求')
                return
            if any(skill['name'] == d.value('name') for skill in self.state.skills):
                d.fail('已存在同名技能')
                return
            self.state.counter += 1
            self.state.skills.append(dict(id=f'skill-{self.state.counter}', name=d.value('name'), category=d.value('category'),
                                          instruction=d.value('instruction'), description=d.value('instruction')[:100],
                                          scenario='general', integration=''))
            d.accept()
            self.state.skill_category = '全部'
            self.state.skill_query = ''
            self.render()
        return d.finish(save, '添加技能')

    def choose_files(self):
        if self.state.page == 'knowledge' and self.state.drive_access(self.state.drive_folder_id) not in ('edit', 'manage'):
            self.notify('当前账号没有此文件夹的写入权限')
            return
        paths, _ = QFileDialog.getOpenFileNames(self, '选择资料（只记录文件名，不读取内容）', '', '所有文件 (*)')
        if not paths:
            self.notify('已取消选择资料')
            return
        failed = []
        for path in paths:
            p = Path(path)
            try:
                size = p.stat().st_size
            except OSError:
                failed.append(p.name)
                continue
            if self.state.page == 'knowledge':
                try:
                    self.state.add_drive_record(p.name, p.suffix[1:].upper()[:6] or 'FILE', f'{size / 1024:.1f} KB')
                except ValueError as error:
                    failed.append(p.name + '（' + str(error) + '）')
            else:
                if p.name not in self.state.attachments:
                    self.state.attachments.append(p.name)
        self.render()
        self.notify('只记录文件名与大小，没有读取内容或上传。' + ('无法访问：' + '、'.join(failed) if failed else ''))

    def file_dialog(self, record):
        if self.state.drive_access(record) == 'none':
            self.notify('当前账号无权查看这份文件')
            return
        d = self.new_dialog(record['name'], '只展示来源与使用范围，不读取文件正文。')
        d.layout.addWidget(label(f'来源：{record["source"]}\n分类：{record["category"]}\n版本：{record["version"]}\n访问权限：{ACCESS_LABELS[self.state.drive_access(record)]}', 'notice'))
        d.layout.addWidget(label('引用定位：尚未解析' if record['imported'] else '引用示例：产品介绍 / 第 2 节。正式检索需附文件、版本和章节。', 'muted'))
        def publish():
            self.state.published = True
            d.accept()
            self.render()
            self.notify('已完成演示确认，未发布真实资料')
        return d.finish(publish if not record['imported'] else None, '模拟确认发布')

    def agent_dialog(self, index=None):
        agent = self.state.agents[index] if index is not None else dict(name='', role='', prompt='')
        d = self.new_dialog('配置企业助手' if index is not None else '创建企业助手', '仅更新本次原型配置，不创建或修改真实 Preset。')
        d.field('name', '助手名称', agent['name'], limit=24)
        d.field('role', '岗位职责', agent['role'])
        d.field('prompt', '岗位指令', agent['prompt'], multiline=True)
        d.layout.addWidget(label('模型、Skills、MCP 与工具配置继续由原有 Preset 体系承载。', 'muted'))
        if index is not None:
            d.actions.addWidget(button('导出 JSON 示例', lambda: self.export_agent(index)))
        def save():
            try:
                self.state.save_agent(index, d.value('name'), d.value('role'), d.value('prompt'))
            except ValueError as e:
                d.fail(e)
                return
            d.accept()
            self.navigate('agents')
            self.notify('助手配置已更新，仅本次演示有效')
        return d.finish(save)

    def export_agent(self, index):
        data = dict(prototype=True, **self.state.agents[index], note='配置示例，不是可导入的 dshpreset 包')
        return self.save_text('企业助手_原型配置.json', json.dumps(data, ensure_ascii=False, indent=2), 'JSON 文件 (*.json)')

    def import_preset(self):
        path, _ = QFileDialog.getOpenFileName(self, '选择 Preset（原型只显示文件名）', '', 'Agent Preset (*.dshpreset)')
        if path:
            self.info('Preset 导入预检', f'已选择：{Path(path).name}\n正式应用需检查名称冲突、内容和信任来源。\n原型没有解析、导入或执行该文件。')
        else:
            self.notify('已取消导入')

    def toggle_plugin(self, name, enabled):
        if name == '办公文件处理' and not enabled and self.state.plugins['模板 PPT']:
            self.render()
            d = self.new_dialog('停用前检查依赖', '模板 PPT 的演示流程使用办公文件能力。')
            d.layout.addWidget(label('确认后将同时关闭两个演示开关。不会卸载真实插件或删除文件。', 'notice'))
            def disable():
                self.state.plugins['办公文件处理'] = self.state.plugins['模板 PPT'] = False
                d.accept()
                self.render()
            d.finish(disable, '同时停用（演示）')
            return
        if name == '模板 PPT' and enabled and not self.state.plugins['办公文件处理']:
            self.notify('请先启用办公文件处理的演示开关')
            self.render()
            return
        self.state.plugins[name] = enabled
        self.render()
        self.notify('已修改演示开关，未改变真实插件')

    def plugin_dialog(self, name):
        config = self.state.plugin_config.get(name, {})
        d = self.new_dialog(name + ' · 配置', '安装、准备依赖与实际激活是不同状态。此处仅演示参数。')
        d.field('scope', '可用范围', config.get('scope', '仅当前工作区'), options=['仅当前工作区', '所有授权工作区'])
        d.field('approval', '操作确认', config.get('approval', '关键操作逐次确认'), options=['关键操作逐次确认', '只读操作自动通过'])
        def save():
            self.state.plugin_config[name] = dict(scope=d.value('scope'), approval=d.value('approval'))
            d.accept()
            self.notify('演示参数已保存，重新打开可以查看')
        return d.finish(save)

    def market_dialog(self):
        d = self.new_dialog('社区工作台市场', '保留原有市场。这里不会联网、下载或执行扩展代码。')
        for name in MARKET:
            installed = name in self.state.market
            d.layout.addWidget(row(label(name, 'cardTitle'), None, button('移除演示' if installed else '安装预检', lambda n=name: self.market_item(n))))
        return d.finish()

    def market_item(self, name):
        if name in self.state.market:
            self.state.market.remove(name)
            self.market_dialog()
            return
        d = self.new_dialog('安装前检查 · ' + name, '源、权限与版本应在正式安装前核对。')
        d.layout.addWidget(label('来源：社区市场示例\n访问范围：授权工作区\n依赖：通用会话与文档能力\n版本：正式安装时验证宿主兼容性', 'notice'))
        def install():
            self.state.market.add(name)
            d.accept()
            self.market_dialog()
        return d.finish(install, '模拟安装')

    def permissions_dialog(self):
        d = self.new_dialog('企业角色权限矩阵', '设计提议。正式权限需要受信任的宿主或服务端校验。')
        d.layout.addWidget(self.table(['操作', '管理员', '负责人', '成员'], [('品牌与组织', '管理', '查看', '查看'),
            ('工作台与模板', '全企业', '本部门', '使用'), ('资料', '授权管理', '部门管理', '授权读取'),
            ('插件与服务', '策略管理', '申请', '使用'), ('任务交付', '按授权', '按授权', '按授权'), ('审计', '按角色授权', '本部门', '本人')]))
        return d.finish()

    def invite_dialog(self):
        d = self.new_dialog('创建成员邀请草稿', '不会发送邮件、通知或创建真实账号。')
        d.field('name', '演示成员姓名', limit=20)
        d.field('role', '拟分配角色', options=['成员', '业务负责人', '管理员'])
        d.field('department', '所属部门', options=['销售运营', '品牌与市场', '行政与人事'])
        def save():
            if not d.value('name'):
                d.fail('请填写成员姓名')
                return
            self.state.members.append({k: d.value(k) for k in ('name', 'role', 'department')})
            d.accept()
            self.render()
            self.notify('仅保存邀请草稿，没有发送邀请')
        return d.finish(save, '保存邀请草稿')

    def policy_dialog(self):
        d = self.new_dialog('关键操作策略', '只更新本次原型的策略说明，不改变真实工具权限。')
        d.layout.addWidget(label('覆盖文件：逐次确认\n写入 ERP / CRM：业务校验后确认', 'notice'))
        d.field('external', '对外发送消息或文件', self.state.external_policy, options=['发送前确认', '禁止对外发送'])
        def save():
            self.state.external_policy = d.value('external')
            d.accept()
            self.render()
        return d.finish(save, '保存演示策略')

    def model_dialog(self):
        d = self.new_dialog('配置模型服务', '本原型不连接服务，不接收或保存真实密钥。')
        d.field('provider', '提供方', options=['DeepSeek', 'Anthropic', '企业网关 / 自托管服务'])
        address = d.field('address', '服务地址（展示用）', 'https://model.example')
        address.setReadOnly(True)
        key = d.field('key', 'API Key（原型禁用）')
        key.setEchoMode(QLineEdit.Password)
        key.setPlaceholderText('请勿输入真实凭据')
        key.setEnabled(False)
        def save():
            d.accept()
            self.notify('配置流程演示完成，没有建立模型连接')
        return d.finish(save, '确认演示配置')

    def workspace_dialog(self):
        d = self.new_dialog('本地工作区', '正式应用保留原生目录选择器。原型不绑定或扫描文件夹。')
        d.layout.addWidget(label('销售运营\n资料 / 模板 / 交付物\n\n品牌与市场\n素材 / 演示 / 项目', 'notice'))
        return d.finish()

    def template_dialog(self):
        d = self.new_dialog('选择企业演示模板', '原项目的 16 套模板能力继续保留，这里展示 3 个预览入口。')
        d.field('template', 'PPT 模板', self.state.template, options=['远山 · 品牌绿', '商务 · 深海蓝', '年度 · 暖砂金'])
        def save():
            self.state.template = d.value('template')
            d.accept()
            if self.state.page == 'chat':
                self.render()
            self.notify('已选择演示模板，未生成 PPTX')
        return d.finish(save, '使用模板')

    def phone_dialog(self):
        d = self.new_dialog('连接手机 · 演示', '没有开放网络端口，没有生成真实配对二维码。')
        d.layout.addWidget(label('当前状态：' + ('演示设备已配对' if self.state.phone else '未配对'), 'section'))
        d.layout.addWidget(label('正式流程：选择连接范围 → 短时二维码 → 手机确认 → 继续会话 → 随时断开。\n临时公网连接应遵循企业策略。', 'notice'))
        def toggle():
            self.state.phone = not self.state.phone
            d.accept()
            self.render()
            self.phone_dialog()
        return d.finish(toggle, '断开演示连接' if self.state.phone else '模拟完成配对')

    def safe_dialog(self):
        d = self.new_dialog('安全模式 · 流程预览', '正式模式使用隔离 Profile，保留基础功能与诊断入口。')
        d.layout.addWidget(label('进入隔离环境 → 检查问题插件 → 恢复正常启动\n本原型只显示状态，不禁用插件、不清空数据。', 'notice'))
        def enter():
            self.state.safe = True
            d.accept()
            self.render()
        return d.finish(enter, '预览安全模式状态')

    def exit_safe(self):
        self.state.safe = False
        self.render()

    def logs_dialog(self):
        d = self.new_dialog('诊断日志 · 示例', '以下不是实际 DSH Desktop 日志。')
        text = '[demo] native Qt UI ready\n[demo] model: not connected\n[demo] business runtime: not started\n[demo] credentials: not collected'
        d.layout.addWidget(label(text, 'notice'))
        d.actions.addWidget(button('导出示例日志', lambda: self.save_text('诊断日志_原型演示.txt', '仅供原型演示\n' + text)))
        return d.finish()

    def update_dialog(self):
        d = self.new_dialog('应用更新 · 流程预览', '原型不查询版本，不下载或安装更新。')
        d.layout.addWidget(label('发现新版本 → 用户确认下载 → 保存工作 → 重启并安装\n正式应用保留跳过版本与保留用户数据的机制。', 'notice'))
        def confirm():
            d.accept()
            self.info('安装前确认 · 演示', '正式安装前提示保存工作，并说明数据保留策略。\n原型不会安装或重启任何应用。')
        return d.finish(confirm, '预览安装确认')

    def search_dialog(self):
        d = self.new_dialog('搜索工作空间', '搜索页面、工作台、资料和示例任务。方向键选择，Enter 打开。')
        edit = d.field('query', '搜索关键词')
        results = QListWidget()
        results.setObjectName('searchResults')
        results.setMinimumHeight(280)
        results.setAccessibleName('搜索结果')
        d.layout.addWidget(results)
        entries = [(title, '页面', lambda k=key: self.navigate(k)) for key, title in NAV]
        entries += [(b['name'], '工作台', lambda b=b: self.bench_dialog(b)) for b in self.state.benches]
        entries += [(f['name'], '资料', lambda f=f: self.file_dialog(f)) for f in self.state.files
                    if self.state.drive_access(f) != 'none']
        entries += [('销售周报生成', '任务', lambda: self.start_scenario('sales'))]
        def update(text):
            results.clear()
            for i, (name, category, callback) in enumerate(entries):
                if text.casefold() in name.casefold():
                    item = QListWidgetItem(f'{name}    ·    {category}')
                    item.setData(Qt.UserRole, i)
                    results.addItem(item)
            if results.count():
                results.setCurrentRow(0)
            else:
                item = QListWidgetItem('没有找到匹配内容')
                item.setFlags(Qt.NoItemFlags)
                results.addItem(item)
        def open_result(item=None):
            item = item or results.currentItem()
            if item is None or item.data(Qt.UserRole) is None:
                return
            callback = entries[item.data(Qt.UserRole)][2]
            d.accept()
            callback()
        edit.textChanged.connect(update)
        edit.result_keys = SearchKeys(edit, results)
        edit.returnPressed.connect(lambda: open_result())
        results.itemActivated.connect(open_result)
        update('')
        d.finish()
        return d

    def about_dialog(self):
        d = self.new_dialog('企业工作台 · PyQt 工作台原型 V0.8', '原生桌面办公原型 · 会话、协作、资料与系统集成。')
        d.layout.addWidget(label('所有业务操作均为演示。只有外观偏好和用户主动导出的示例会写入磁盘。\n\nAlt+N 新任务 · Ctrl+K 搜索 · Esc 关闭弹窗\n关闭程序后，任务、附件、邀请与策略重置。', 'notice'))
        d.actions.addWidget(button('重置任务演示', lambda: self.reset_demo(d)))
        d.actions.addWidget(button('恢复初始品牌', self.reset_brand))
        return d.finish()

    def reset_demo(self, dialog=None):
        if self.contact_chat_window:
            self.contact_chat_window.close()
        self.timer.stop()
        old = self.state
        self.state = PrototypeState(org=old.org, brand=old.brand, dark=old.dark, compact=old.compact)
        if dialog:
            dialog.accept()
        self.navigate('home')
        self.notify('本次演示数据已重置，保留外观偏好')

    def reset_brand(self):
        self.state.org, self.state.brand = '远山科技', '序 · 企业工作台'
        self.apply_theme()
        self.save_preferences()
        self.render()

    def closeEvent(self, event):
        if self.contact_chat_window:
            self.contact_chat_window.close()
        self.timer.stop()
        if self.dialog:
            self.dialog.close()
        event.accept()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, default=ROOT / '.preview-data')
    parser.add_argument('--allow-multiple', action='store_true', help='Use only for isolated UI checks')
    parser.add_argument('--live-preview', action='store_true', help='Mark the supervised development window')
    args = parser.parse_args()
    QApplication.setAttribute(Qt.AA_EnableHighDpiScaling, True)
    QApplication.setAttribute(Qt.AA_UseHighDpiPixmaps, True)
    application = QApplication(sys.argv[:1])
    application.setApplicationName('EnterprisePrototype')
    application.setFont(QFont('Microsoft YaHei UI', 10))
    try:
        args.data_dir.mkdir(parents=True, exist_ok=True)
        logging.basicConfig(filename=str(args.data_dir / 'preview.log'), encoding='utf-8',
                            level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    except OSError:
        logging.basicConfig(level=logging.INFO)
    lock_name = 'EnterprisePrototype-' + hashlib.sha256(str(args.data_dir.resolve()).encode()).hexdigest()[:18]
    server = None
    if not args.allow_multiple:
        socket = QLocalSocket()
        socket.connectToServer(lock_name)
        if socket.waitForConnected(600):
            socket.write(b'activate')
            socket.waitForBytesWritten(600)
            socket.disconnectFromServer()
            return 0
        server = QLocalServer()
        QLocalServer.removeServer(lock_name)
        if not server.listen(lock_name):
            QMessageBox.critical(None, '原型启动失败', '无法建立本地窗口激活通道，请重试或查看日志。')
            return 1
    window = PrototypeWindow(args.data_dir, live_preview=args.live_preview)
    def activate():
        connection = server.nextPendingConnection()
        if connection:
            connection.disconnectFromServer()
            connection.deleteLater()
        window.showNormal()
        window.raise_()
        window.activateWindow()
    if server:
        server.newConnection.connect(activate)
    def exception_hook(kind, value, traceback):
        logging.error('Unhandled UI exception', exc_info=(kind, value, traceback))
        QMessageBox.critical(window, '原型发生错误', '请查看 .preview-data/preview.log。\n' + str(value))
    sys.excepthook = exception_hook
    window.show()
    window.raise_()
    window.activateWindow()
    logging.info('Native Qt prototype opened')
    result = application.exec_()
    if server:
        server.close()
    return result


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        logging.exception('Prototype startup failed')
        if QApplication.instance():
            QMessageBox.critical(None, '无法启动原型', '启动失败，请查看 .preview-data/preview.log。')
        raise
