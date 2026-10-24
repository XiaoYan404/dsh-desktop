"""Native workbench presentation, arranged around work, artifacts and context."""
from datetime import date, datetime, timedelta
from pathlib import Path

from PyQt5.QtCore import Qt, QSize, QDate
from PyQt5.QtGui import QKeySequence, QColor
from PyQt5.QtWidgets import (QWidget, QFrame, QVBoxLayout, QHBoxLayout, QLabel, QProgressBar,
                             QTextEdit, QComboBox, QToolButton, QShortcut,
                             QSizePolicy, QDateEdit, QScrollArea, QListWidget, QListWidgetItem,
                             QLineEdit, QPushButton, QTreeWidget, QTreeWidgetItem, QHeaderView,
                             QAbstractItemView, QTabWidget, QMenu, QDialog, QFileDialog)

from prototype_model import NAV, NAV_ICONS, ITEM_KINDS, TODO_STATUSES, ACCESS_LABELS
from qt_widgets import label, button, row, box, icon, FileTile, ChatMessageInput, AnnouncementTicker


class WorkCard(QFrame):
    """A keyboard-accessible artifact card with an optional open action."""
    def __init__(self, callback=None, name='', kind='workCard'):
        super().__init__()
        self.callback = callback
        self.setProperty('kind', kind)
        self.setObjectName(name)
        if callback:
            self.setCursor(Qt.PointingHandCursor)
            self.setFocusPolicy(Qt.StrongFocus)

    def mouseReleaseEvent(self, event):
        if self.callback and event.button() == Qt.LeftButton and self.rect().contains(event.pos()):
            self.callback()
        super().mouseReleaseEvent(event)

    def keyPressEvent(self, event):
        if self.callback and event.key() in (Qt.Key_Return, Qt.Key_Enter, Qt.Key_Space):
            self.callback()
            event.accept()
        else:
            super().keyPressEvent(event)


class ContactChatDialog(QDialog):
    """A persistent peer conversation with tools directly above its composer."""
    def __init__(self, host, member_id):
        super().__init__(host)
        self.host = host
        self.account_id = host.state.current_account_id
        self.member_id = ''
        self.attachments = []
        self.setObjectName('contactChatWindow')
        self.setAttribute(Qt.WA_DeleteOnClose, True)
        self.setWindowModality(Qt.NonModal)
        self.setMinimumSize(760, 520)
        self.resize(min(1040, host.width() - 56), min(700, host.height() - 68))
        outer = QHBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self.sidebar = QFrame()
        self.sidebar.setObjectName('contactChatSidebar')
        self.sidebar.setFixedWidth(216)
        sl = QVBoxLayout(self.sidebar)
        sl.setContentsMargins(14, 18, 14, 14)
        sl.setSpacing(12)
        sl.addWidget(label('消息', 'section'))
        self.search = QLineEdit()
        self.search.setObjectName('peerChatSearch')
        self.search.setPlaceholderText('搜索同事')
        self.search.setAccessibleName('搜索聊天成员')
        self.search.textChanged.connect(self.refresh_peers)
        sl.addWidget(self.search)
        self.peers = QListWidget()
        self.peers.setObjectName('peerChatList')
        self.peers.setAccessibleName('成员会话列表')
        self.peers.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.peers.itemClicked.connect(lambda entry: self.open_member(entry.data(Qt.UserRole)))
        self.peers.itemActivated.connect(lambda entry: self.open_member(entry.data(Qt.UserRole)))
        sl.addWidget(self.peers, 1)
        sl.addWidget(label('企业内部聊天 · 本地演示', 'caption'))
        outer.addWidget(self.sidebar)
        chat = QWidget()
        right = QVBoxLayout(chat)
        right.setContentsMargins(0, 0, 0, 0)
        right.setSpacing(0)
        header = QFrame()
        header.setObjectName('peerChatHeader')
        hl = QHBoxLayout(header)
        hl.setContentsMargins(22, 15, 20, 15)
        self.avatar = label('', 'contactAvatar', False)
        self.avatar.setFixedSize(36, 36)
        hl.addWidget(self.avatar)
        identity = QVBoxLayout()
        identity.setSpacing(4)
        self.title = label('', 'section', False)
        self.title.setObjectName('peerChatTitle')
        self.subtitle = label('', 'caption', False)
        identity.addWidget(self.title)
        identity.addWidget(self.subtitle)
        hl.addLayout(identity, 1)
        hl.addWidget(button('成员资料', self.show_member, 'quiet', 'peerChatProfile'))
        right.addWidget(header)
        self.history = QScrollArea()
        self.history.setObjectName('contactMessageHistory')
        self.history.setWidgetResizable(True)
        self.history.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.history.setMinimumHeight(90)
        self.history.verticalScrollBar().rangeChanged.connect(lambda low, high: self.history.verticalScrollBar().setValue(high))
        right.addWidget(self.history, 1)
        composer = QFrame()
        composer.setObjectName('peerChatComposer')
        cl = QVBoxLayout(composer)
        cl.setContentsMargins(18, 10, 18, 14)
        cl.setSpacing(8)
        self.emoji_button = button('表情', self.show_emoji, 'chatAction', 'peerChatEmoji')
        attach = button('文件', self.choose_attachments, 'chatAction', 'peerChatAttach')
        attach.setIcon(icon('paperclip', '#7C8381', 17))
        task = button('派任务', lambda: host.create_todo_dialog('task', self.member_id), 'chatAction', 'peerChatTask')
        task.setIcon(icon('workbench', '#7C8381', 17))
        meeting = button('约会议', lambda: host.contact_meeting(self.member_id), 'chatAction', 'peerChatMeeting')
        meeting.setIcon(icon('calendar', '#7C8381', 17))
        todo = button('建待办', lambda: host.create_todo_dialog('todo', self.member_id), 'chatAction', 'peerChatTodo')
        todo.setIcon(icon('doc', '#7C8381', 17))
        toolbar = row(self.emoji_button, attach, None, task, meeting, todo)
        toolbar.setObjectName('peerChatToolbar')
        cl.addWidget(toolbar)
        self.attachment_label = label('', 'caption')
        self.attachment_label.setWordWrap(False)
        self.attachment_label.setMinimumWidth(0)
        self.attachment_label.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        self.attachment_bar = row(self.attachment_label,
                                  button('清除', self.clear_attachments, 'text', 'peerChatClearFiles'))
        self.attachment_bar.setObjectName('peerChatAttachments')
        cl.addWidget(self.attachment_bar)
        self.input = ChatMessageInput()
        self.input.setObjectName('peerChatInput')
        self.input.setAccessibleName('聊天消息输入')
        self.input.setFixedHeight(100)
        self.input.setPlaceholderText('输入消息…')
        self.input.textChanged.connect(self.save_draft)
        self.input.sendRequested.connect(self.send)
        cl.addWidget(self.input)
        self.error = label('', 'chatError')
        self.error.setObjectName('peerChatError')
        self.error.hide()
        cl.addWidget(self.error)
        self.send_button = button('发送', self.send, 'primary', 'peerChatSend')
        cl.addWidget(row(label('Enter 发送 · Shift+Enter 换行', 'caption', False), None, self.send_button))
        right.addWidget(composer)
        outer.addWidget(chat, 1)
        self.open_member(member_id)

    def open_member(self, member_id):
        member = self.host.state.member(member_id)
        if not member or member_id == self.account_id:
            return
        self.member_id = member_id
        self.host.state.contact_id = member_id
        self.setWindowTitle(member['name'] + ' · 企业聊天')
        self.avatar.setText(member['name'][:1])
        self.title.setText(member['name'])
        self.subtitle.setText(member['department'] + ' · ' + member['job'])
        draft = self.host.state.contact_draft(member_id)
        self.input.blockSignals(True)
        self.input.setPlainText(draft['text'])
        self.input.blockSignals(False)
        self.attachments = list(draft['attachments'])
        self.error.hide()
        self.refresh_attachments()
        self.refresh_peers()
        self.render_history()
        self.input.setFocus()

    def refresh_peers(self):
        self.peers.clear()
        for member in self.host.state.directory:
            if member['id'] == self.account_id or self.search.text().casefold() not in (member['name'] + member['department']).casefold():
                continue
            history = self.host.state.messages_with(member['id'])
            preview = (history[-1]['text'] or '文件：' + '、'.join(history[-1].get('attachments', []))) if history else member['department']
            entry = QListWidgetItem(member['name'] + '\n' + preview.replace('\n', ' ')[:18])
            entry.setData(Qt.UserRole, member['id'])
            entry.setIcon(icon('team', '#7C8381', 22))
            entry.setToolTip(member['name'] + ' · ' + member['job'])
            self.peers.addItem(entry)
            if member['id'] == self.member_id:
                self.peers.setCurrentItem(entry)

    def bubble_width(self):
        return max(180, min(420, self.width() - self.sidebar.width() - 140))

    def render_history(self):
        old = self.history.takeWidget()
        if old:
            old.deleteLater()
        body = QWidget()
        body.setObjectName('peerChatHistoryBody')
        bl = QVBoxLayout(body)
        bl.setContentsMargins(22, 18, 22, 20)
        bl.setSpacing(14)
        history = self.host.state.messages_with(self.member_id)
        if not history:
            bl.addStretch()
            hint = label('和' + self.host.state.member(self.member_id)['name'] + '开始沟通', 'caption')
            hint.setAlignment(Qt.AlignCenter)
            bl.addWidget(hint)
        last_time = ''
        for message in history:
            if message['time'] != last_time:
                last_time = message['time']
                time = label(last_time, 'caption', False)
                time.setAlignment(Qt.AlignCenter)
                bl.addWidget(time)
            mine = message['sender'] == self.account_id
            avatar = label(self.host.state.member(message['sender'])['name'][:1], 'contactAvatar', False)
            avatar.setFixedSize(34, 34)
            bubble, content = box('contactBubble', 12, 8)
            bubble.setProperty('outgoing', mine)
            lines = message['text'].splitlines() + ['文件  ' + name for name in message.get('attachments', [])]
            natural_width = max((self.fontMetrics().horizontalAdvance(line) for line in lines), default=30) + 26
            bubble.setProperty('naturalWidth', natural_width)
            bubble.setFixedWidth(max(50, min(self.bubble_width(), natural_width)))
            bubble.setSizePolicy(QSizePolicy.Maximum, QSizePolicy.Preferred)
            if message['text']:
                text = label(message['text'])
                text.setObjectName('peerMessageText')
                content.addWidget(text)
            for name in message.get('attachments', []):
                content.addWidget(label('文件  ' + name, 'field'))
            line = QWidget()
            ll = QHBoxLayout(line)
            ll.setContentsMargins(0, 0, 0, 0)
            ll.setSpacing(10)
            if mine:
                ll.addStretch()
                ll.addWidget(bubble, 0, Qt.AlignTop)
                ll.addWidget(avatar, 0, Qt.AlignTop)
            else:
                ll.addWidget(avatar, 0, Qt.AlignTop)
                ll.addWidget(bubble, 0, Qt.AlignTop)
                ll.addStretch()
            bl.addWidget(line)
        bl.addStretch()
        self.history.setWidget(body)

    def save_draft(self):
        if not self.member_id:
            return
        draft = self.host.state.contact_draft(self.member_id)
        draft.update(text=self.input.toPlainText(), attachments=list(self.attachments))
        self.send_button.setEnabled(bool(draft['text'].strip() or self.attachments))

    def refresh_attachments(self):
        self.attachment_label.setText('文件名称：' + ' · '.join(self.attachments))
        self.attachment_label.setToolTip(' · '.join(self.attachments))
        self.attachment_bar.setVisible(bool(self.attachments))
        self.save_draft()

    def choose_attachments(self):
        paths, _ = QFileDialog.getOpenFileNames(self, '选择文件（原型仅记录名称，不上传正文）', '', '所有文件 (*)')
        names = list(dict.fromkeys(self.attachments + [Path(path).name for path in paths]))
        if len(names) > 10:
            self.error.setText('每条消息最多附加 10 个文件名称')
            self.error.show()
            return
        self.attachments = names
        self.refresh_attachments()

    def clear_attachments(self):
        self.attachments = []
        self.refresh_attachments()

    def show_emoji(self):
        menu = QMenu(self)
        for emoji in ['🙂', '👍', '✅', '🙏', '🎉']:
            menu.addAction(emoji, lambda value=emoji: self.input.insertPlainText(value))
        menu.exec_(self.emoji_button.mapToGlobal(self.emoji_button.rect().bottomLeft()))

    def show_member(self):
        member = self.host.state.member(self.member_id)
        self.host.info(member['name'], member['department'] + ' · ' + member['job'] + '\n\n' +
                       member['role'] + '\n\n邮箱：' + member['email'] + '\n电话：' + member['phone'])

    def send(self):
        try:
            self.host.state.send_contact_message(self.member_id, self.input.toPlainText(), self.attachments)
        except ValueError as error:
            self.error.setText(str(error))
            self.error.show()
            return
        self.attachments = []
        self.input.clear()
        self.refresh_attachments()
        self.error.hide()
        self.render_history()
        self.refresh_peers()
        self.host.render()
        self.host.notify('消息已记录（本地原型）')
        self.input.setFocus()

    def resizeEvent(self, event):
        super().resizeEvent(event)
        if hasattr(self, 'history'):
            for frame in self.history.findChildren(QFrame):
                if frame.property('kind') == 'contactBubble':
                    frame.setFixedWidth(max(50, min(self.bubble_width(), frame.property('naturalWidth'))))


class WorkbenchView:
    def build_shell(self):
        shell = QWidget()
        shell.setObjectName('shell')
        outer = QHBoxLayout(shell)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self.setCentralWidget(shell)
        self.app_rail = QWidget()
        self.app_rail.setObjectName('appRail')
        self.app_rail.setFixedWidth(72)
        rail = QVBoxLayout(self.app_rail)
        rail.setContentsMargins(8, 15, 8, 10)
        rail.setSpacing(3)
        mark = label('序', 'railBrand', False)
        mark.setAlignment(Qt.AlignCenter)
        mark.setFixedSize(40, 40)
        rail.addWidget(mark, 0, Qt.AlignHCenter)
        rail.addSpacing(12)
        self.nav_buttons = {}
        for key, title in NAV:
            if key == 'admin':
                rail.addStretch()
            tool = QToolButton()
            short_name = {'admin': '团队', 'settings': '设置'}.get(key, title)
            glyph = NAV_ICONS[key]
            tool.setText(short_name)
            tool.setIcon(icon(glyph, '#5F6767', 21))
            tool.setIconSize(QSize(21, 21))
            tool.setToolButtonStyle(Qt.ToolButtonTextUnderIcon)
            tool.setFixedSize(56, 48)
            tool.setCursor(Qt.PointingHandCursor)
            tool.setCheckable(True)
            tool.setObjectName(f'nav_{key}')
            tool.setProperty('kind', 'rail')
            tool.setToolTip(title)
            tool.setAccessibleName(title)
            tool.clicked.connect(lambda checked=False, k=key: self.navigate(k))
            self.nav_buttons[key] = tool
            rail.addWidget(tool)
        outer.addWidget(self.app_rail)

        right = QWidget()
        right.setObjectName('workCanvas')
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.setSpacing(0)
        top = QWidget()
        top.setObjectName('workTopbar')
        top.setFixedHeight(64)
        tl = QHBoxLayout(top)
        tl.setContentsMargins(32, 0, 30, 0)
        self.breadcrumb = label('', 'caption', False)
        tl.addWidget(self.breadcrumb)
        tl.addStretch()
        search = button('搜索', self.search_dialog, 'quiet', 'globalSearch')
        search.setIcon(icon('search', '#7C8381', 16))
        search.setToolTip('搜索任何内容 · Ctrl+K')
        tl.addWidget(search)
        new = button('新工作', self.new_task, 'quiet', 'newTask')
        new.setIcon(icon('plus', '#7C8381', 16))
        new.setToolTip('开始一段独立的工作 · Alt+N')
        tl.addWidget(new)
        tl.addWidget(label('●', 'statusDot', False))
        tl.addWidget(label('本地演示', 'caption', False))
        tl.addSpacing(12)
        theme = button('', self.toggle_theme, 'quiet', 'shellTheme')
        theme.setIcon(icon('panel', '#7C8381', 18))
        theme.setFixedSize(32, 32)
        theme.setToolTip('切换浅色 / 深色')
        theme.setAccessibleName('切换浅深主题')
        tl.addWidget(theme)
        tl.addWidget(button('原型说明', self.about_dialog, 'quiet', 'aboutPrototype'))
        profile = QWidget()
        profile.setObjectName('loginProfile')
        pl = QHBoxLayout(profile)
        pl.setContentsMargins(12, 0, 0, 0)
        pl.setSpacing(9)
        self.login_avatar = button('', self.profile_dialog, 'avatarButton', 'loginAvatar')
        self.login_avatar.setAccessibleName('查看和设置个人资料')
        self.login_avatar.setFixedSize(36, 36)
        pl.addWidget(self.login_avatar)
        identity = QVBoxLayout()
        identity.setSpacing(3)
        self.login_name = label('', 'cardTitle', False)
        self.login_name.setObjectName('loginName')
        self.login_role = label('', 'tag', False)
        self.login_role.setObjectName('loginRole')
        identity.addWidget(row(self.login_name, self.login_role))
        self.login_job = label('', 'caption', False)
        self.login_job.setObjectName('loginJob')
        identity.addWidget(self.login_job)
        pl.addLayout(identity)
        tl.addWidget(profile)
        rl.addWidget(top)
        self.page_slot = QVBoxLayout()
        self.page_slot.setContentsMargins(0, 0, 0, 0)
        rl.addLayout(self.page_slot, 1)
        outer.addWidget(right, 1)
        self.status = label('工作台原型 · 本地演示数据', 'caption', False)
        self.statusBar().addWidget(self.status, 1)
        self.statusBar().addPermanentWidget(label('模型未连接', 'caption', False))
        app_menu = self.menuBar().addMenu('应用')
        for title, callback in [('新建任务', self.new_task), ('日历', self.open_calendar),
                                ('场景工坊', lambda: self.navigate('benches')),
                                ('我的助手', lambda: self.navigate('agents')), ('连接手机', self.phone_dialog),
                                ('安全模式演示', self.safe_dialog), ('诊断日志示例', self.logs_dialog),
                                ('更新流程预览', self.update_dialog), ('退出原型', self.close)]:
            app_menu.addAction(title, callback)
        view_menu = self.menuBar().addMenu('视图')
        view_menu.addAction('切换浅深主题', self.toggle_theme)
        view_menu.addAction('切换布局密度', self.toggle_density)
        view_menu.addAction('全屏 / 恢复', lambda: self.showNormal() if self.isFullScreen() else self.showFullScreen())
        self.menuBar().addMenu('帮助').addAction('关于原型', self.about_dialog)

    def conversation_sidebar(self, materials):
        side, sl = box('tray', 13, 10)
        side.setObjectName('conversationSidebar')
        side.setFixedWidth(258 if self.width() >= 1260 else 224)
        tabs = QTabWidget()
        tabs.setObjectName('conversationSidebarTabs')
        sessions = QWidget()
        vl = QVBoxLayout(sessions)
        vl.setContentsMargins(0, 12, 0, 0)
        vl.setSpacing(10)
        vl.addWidget(button('＋ 新建会话', self.new_task, 'primary', 'newConversation'))
        search = self.search_field('conversationSearch', self.state.conversation_query, '搜索会话', 'conversation_query')
        vl.addWidget(search)
        vl.addWidget(label('最近会话', 'overline'))
        conversations = QListWidget()
        conversations.setObjectName('conversationList')
        conversations.setAccessibleName('会话列表')
        conversations.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        for key, title in self.state.conversation_entries():
            entry = QListWidgetItem(title.replace('\n', ' ')[:44])
            entry.setData(Qt.UserRole, key)
            entry.setToolTip(title)
            entry.setIcon(icon('doc' if key.startswith('item:') else 'chat', '#7C8381', 16))
            conversations.addItem(entry)
            if key == self.state.conversation_key:
                conversations.setCurrentItem(entry)
        conversations.itemClicked.connect(lambda entry: self.select_saved_conversation(entry.data(Qt.UserRole)))
        conversations.itemActivated.connect(lambda entry: self.select_saved_conversation(entry.data(Qt.UserRole)))
        vl.addWidget(conversations, 1)
        vl.addWidget(label('会话与草稿在本次预览中保留', 'caption'))
        tabs.addTab(sessions, '会话')
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(materials)
        tabs.addTab(scroll, '资料与成果')
        sl.addWidget(tabs, 1)
        return side

    def chat_associations_panel(self):
        panel, pl = box('inset', 8, 4)
        panel.setObjectName('chatAssociations')
        count = len(self.state.linked_integrations) + len(self.state.linked_tools)
        pl.addWidget(row(label('本会话关联', 'caption'), label(f'{count} 项' if count else '未关联', 'caption'), None,
                         button('关联集成', lambda: self.chat_link_dialog('integrations'), 'text', 'chatLinkIntegration'),
                         button('关联工具', lambda: self.chat_link_dialog('tools'), 'text', 'chatLinkTool')))
        if count:
            content = QWidget()
            content.setObjectName('chatLinkedCapabilities')
            hl = QHBoxLayout(content)
            hl.setContentsMargins(0, 0, 0, 0)
            hl.setSpacing(8)
            for kind in ('integrations', 'tools'):
                for record in self.state.linked_records(kind):
                    integration = kind == 'integrations'
                    status = record['status'] if integration else self.state.skill_link_status(record)
                    text = ('系统 · ' + record['system'] if integration else '工具 · ' + record['name']) + ' · ' + status
                    chip = QFrame()
                    chip.setProperty('kind', 'association')
                    chip.setObjectName('linked_' + kind + '_' + record['id'])
                    cl = QHBoxLayout(chip)
                    cl.setContentsMargins(4, 0, 2, 0)
                    cl.setSpacing(0)
                    action = (lambda value=record: self.integration_details(value)) if integration else (lambda value=record: self.skill_dialog(value))
                    view = button(text, action, 'associationText')
                    view.setToolTip('查看详情：' + text)
                    view.setMinimumHeight(28)
                    cl.addWidget(view)
                    remove = button('×', lambda k=kind, key=record['id']: self.remove_chat_link(k, key),
                                    'text', 'unlink_' + kind + '_' + record['id'])
                    remove.setToolTip('取消关联')
                    remove.setAccessibleName('取消关联' + (record['system'] if integration else record['name']))
                    remove.setFixedSize(24, 24)
                    cl.addWidget(remove)
                    hl.addWidget(chip)
            content.resize(content.sizeHint())
            scroll = QScrollArea()
            scroll.setObjectName('chatLinkChips')
            scroll.setWidgetResizable(False)
            scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
            scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
            scroll.setFixedHeight(40)
            scroll.setWidget(content)
            pl.addWidget(scroll)
        return panel

    def header(self, layout, title, subtitle, actions=()):
        block = QWidget()
        bl = QVBoxLayout(block)
        bl.setContentsMargins(0, 0, 0, 0)
        bl.setSpacing(8)
        bl.addWidget(label(title, 'title'))
        bl.addWidget(label(subtitle, 'muted'))
        host = QWidget()
        hl = QHBoxLayout(host)
        hl.setContentsMargins(0, 0, 0, 0)
        hl.setSpacing(10)
        hl.addWidget(block, 1)
        for action in actions:
            hl.addWidget(action, 0, Qt.AlignVCenter)
        layout.addWidget(host)

    def page_home(self, layout):
        today = datetime.now()
        weekday = '一二三四五六日'[today.weekday()]
        layout.setSpacing(14)
        self.header(layout, '工作台', f'{today.month}月{today.day}日 · 星期{weekday}    {self.state.profile["name"]}，欢迎回来。')
        timed, untimed = self.state.today_groups()
        items = timed + untimed
        upper = QWidget()
        upper.setObjectName('homeUpper')
        upper.setFixedHeight(236 if self.height() >= 800 else 202)
        ul = QHBoxLayout(upper)
        ul.setContentsMargins(0, 0, 0, 0)
        ul.setSpacing(16)
        dashboard, dl = box('hero', 18, 10)
        dashboard.setObjectName('homeDashboard')
        dl.addWidget(row(label('今日工作概览', 'cardTitle'), None, label('仪表板', 'caption')))
        completed = sum(item['date'] == today.date().isoformat() and item['status'] == '已完成'
                        for item in self.state.today_items)
        metrics = QWidget()
        ml = QHBoxLayout(metrics)
        ml.setContentsMargins(0, 0, 0, 0)
        ml.setSpacing(16)
        values = [(len(items), '待完成'), (completed, '已完成'),
                  (sum(item['kind'] in ('task', 'system', 'todo') for item in items), '任务与待办'),
                  (sum(item['kind'] == 'schedule' for item in items), '今日日程')]
        for value, title in values:
            column = QVBoxLayout()
            column.setSpacing(5)
            column.addWidget(label(value, 'metric', False))
            column.addWidget(label(title, 'caption', False))
            ml.addLayout(column, 1)
        dl.addWidget(metrics, 1)
        percent = round(completed * 100 / (completed + len(items))) if completed + len(items) else 0
        dl.addWidget(row(label('今日完成进度', 'caption'), None, label(f'{percent}%', 'caption')))
        progress = QProgressBar()
        progress.setObjectName('homeCompletion')
        progress.setRange(0, 100)
        progress.setValue(percent)
        progress.setTextVisible(False)
        progress.setFixedHeight(8)
        dl.addWidget(progress)
        dl.addWidget(label('工作任务、系统待办与日程，统一掌握。', 'caption'))
        ul.addWidget(dashboard, 3)
        calendar, cl = box('card', 14, 6)
        calendar.setObjectName('homeCalendarTodo')
        cl.addWidget(row(label('日历 · 待办', 'cardTitle'), None,
                         button('＋ 待办', self.create_todo_dialog, 'text', 'homeNewTodo'),
                         button('日历  →', self.open_calendar, 'text', 'homeOpenCalendar')))
        week_start = today.date() - timedelta(days=today.weekday())
        week = []
        for offset in range(7):
            day = week_start + timedelta(days=offset)
            entry = button(str(day.day), lambda key=day.isoformat(): self.select_calendar_date(key), 'homeDay')
            entry.setCheckable(True)
            entry.setChecked(day == today.date())
            entry.setToolTip(day.isoformat() + ' 的日程')
            entry.setAccessibleName(day.isoformat() + ' 的日程')
            entry.setMinimumHeight(28)
            week.append(entry)
        cl.addWidget(row(*week))
        agenda_items = self.state.day_items(today.date().isoformat())
        if agenda_items:
            agenda = QListWidget()
            agenda.setObjectName('homeAgenda')
            agenda.setAccessibleName('今日日程与待办')
            agenda.setMinimumHeight(30)
            agenda.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
            for item in agenda_items:
                entry = QListWidgetItem(f'{item["time"] or "待安排"}   {item["title"]}   · {item["status"]}')
                entry.setData(Qt.UserRole, item['id'])
                entry.setIcon(icon('calendar' if item['kind'] == 'schedule' else 'workbench', '#7C8381', 15))
                entry.setToolTip(f'{ITEM_KINDS[item["kind"]]} · {item["source"]} · {item["status"]}')
                if item['status'] in ('已完成', '已取消'):
                    entry.setForeground(QColor('#7A8178'))
                agenda.addItem(entry)
            agenda.itemClicked.connect(lambda entry: self.open_today_item(entry.data(Qt.UserRole)))
            agenda.itemActivated.connect(lambda entry: self.open_today_item(entry.data(Qt.UserRole)))
            cl.addWidget(agenda, 1)
        else:
            cl.addWidget(row(label('今天还没有安排', 'caption'), None,
                             button('＋ 新建待办', self.create_todo_dialog, 'text', 'homeEmptyNewTodo')), 1)
        ticker = AnnouncementTicker(self.state.announcements)
        ticker.activated.connect(self.announcement_dialog)
        announcements = row(label('公告', 'tag'), ticker)
        announcements.setObjectName('homeAnnouncements')
        cl.addWidget(announcements)
        ul.addWidget(calendar, 2)
        layout.addWidget(upper)
        self.home_chat_panel(layout)

    def home_chat_panel(self, layout):
        panel, pl = box('composer', 14, 8)
        panel.setObjectName('homeChatPanel')
        pl.addWidget(row(label('AI会话', 'cardTitle'), label('通用办公助手', 'caption'), None,
                         button('展开会话  →', self.open_general_chat, 'text', 'homeOpenAgent')))
        transcript = QWidget()
        tl = QVBoxLayout(transcript)
        tl.setContentsMargins(8, 6, 8, 6)
        tl.setSpacing(9)
        if not self.state.messages:
            tl.addWidget(label('今天，有什么工作需要我帮忙？', 'section'))
            tl.addWidget(label('描述目标，或从上方的待办中选择一项工作。', 'muted'))
        for index, message in enumerate(self.state.messages):
            tl.addWidget(label('你', 'caption'))
            tl.addWidget(label(message))
            if self.message_link_text(index):
                tl.addWidget(label(self.message_link_text(index), 'caption'))
        if self.state.execution:
            tl.addWidget(label(self.state.execution, 'notice'))
        tl.addStretch()
        scroll = QScrollArea()
        scroll.setObjectName('homeTranscript')
        scroll.setMinimumHeight(36)
        scroll.setWidgetResizable(True)
        scroll.setWidget(transcript)
        scroll.verticalScrollBar().rangeChanged.connect(lambda low, high: scroll.verticalScrollBar().setValue(high))
        pl.addWidget(scroll, 1)
        if self.state.attachments:
            pl.addWidget(label('资料名称：' + ' · '.join(self.state.attachments), 'caption'))
        if self.state.linked_integrations or self.state.linked_tools:
            pl.addWidget(label(f'当前会话已关联 {len(self.state.linked_integrations)} 个系统、{len(self.state.linked_tools)} 个工具 · 展开会话可管理', 'caption'))
        self.composer = QTextEdit()
        self.composer.setObjectName('homeChatInput')
        self.composer.setProperty('kind', 'prompt')
        self.composer.setAccessibleName('工作台 AI 对话输入')
        self.composer.setAcceptRichText(False)
        self.composer.setFixedHeight(78 if self.height() >= 800 else 60)
        self.composer.setPlaceholderText('输入你希望完成的工作…')
        self.composer.setPlainText(self.state.draft)
        self.composer.textChanged.connect(lambda: setattr(self.state, 'draft', self.composer.toPlainText()))
        shortcut = QShortcut(QKeySequence('Ctrl+Return'), self.composer)
        shortcut.activated.connect(self.send_message)
        pl.addWidget(self.composer)
        pl.addWidget(row(button('添加资料', self.choose_files, 'text', 'homeAttach'), None,
                         button('停止' if self.state.busy else '发送 ↑',
                                self.stop_execution if self.state.busy else self.send_message,
                                'primary', 'homeSendOrStop')))
        layout.addWidget(panel, 1)

    def page_messages(self, layout):
        self.header(layout, '通讯录', '按组织找到同事，发起沟通与日常协作。')
        search = self.search_field('contactSearch', self.state.contact_query, '搜索成员、部门或岗位', 'contact_query')
        search.setMaximumWidth(360)
        layout.addWidget(row(search, None, label(f'{len(self.state.directory)} 位公司成员', 'caption')))
        body = QHBoxLayout()
        body.setSpacing(18)
        organization, ol = box('tray', 15, 10)
        organization.setFixedWidth(236)
        ol.addWidget(label('公司组织架构', 'cardTitle'))
        tree = QTreeWidget()
        tree.setObjectName('organizationTree')
        tree.setAccessibleName('公司组织架构与成员')
        tree.setHeaderHidden(True)
        tree.setMinimumHeight(160)
        root = QTreeWidgetItem([self.state.org])
        root.setIcon(0, icon('team', '#28736B', 18))
        tree.addTopLevelItem(root)
        query = self.state.contact_query.casefold()
        matched = [member for member in self.state.directory if query in ' '.join(
            member[key] for key in ('name', 'department', 'job', 'role')).casefold()]
        selected = next((member for member in matched if member['id'] == self.state.contact_id), matched[0] if matched else None)
        for department in dict.fromkeys(member['department'] for member in matched):
            branch = QTreeWidgetItem([department])
            branch.setIcon(0, icon('folder', '#7C8381', 16))
            root.addChild(branch)
            for member in [record for record in matched if record['department'] == department]:
                entry = QTreeWidgetItem([member['name'] + ('（我）' if member['id'] == self.state.current_account_id else '')])
                entry.setData(0, Qt.UserRole, member['id'])
                entry.setToolTip(0, member['job'])
                branch.addChild(entry)
                if selected and member['id'] == selected['id']:
                    tree.setCurrentItem(entry)
        tree.expandAll()
        tree.itemClicked.connect(lambda entry, column: self.select_contact(entry.data(0, Qt.UserRole))
                                 if entry.data(0, Qt.UserRole) else None)
        tree.itemActivated.connect(lambda entry, column: self.select_contact(entry.data(0, Qt.UserRole))
                                   if entry.data(0, Qt.UserRole) else None)
        ol.addWidget(tree, 1)
        body.addWidget(organization)
        detail, dl = box('card', 24, 14)
        detail.setObjectName('contactDetails')
        if selected:
            avatar = label(selected['name'][:1], 'avatar', False)
            avatar.setFixedSize(52, 52)
            dl.addWidget(row(avatar, label(selected['name'], 'section'), label(selected['role'], 'tag'), None))
            dl.addWidget(label(selected['department'] + '  ·  ' + selected['job'], 'muted'))
            dl.addWidget(label('邮箱  ' + (selected['email'] or '未设置') + '\n\n电话  ' + (selected['phone'] or '未设置'), 'muted'))
            actions = [button('发消息', lambda: self.contact_message_dialog(selected['id']), 'primary', 'contactChat'),
                       button('派任务', lambda: self.create_todo_dialog('task', selected['id']), name='contactTask'),
                       button('约会议', lambda: self.contact_meeting(selected['id']), name='contactMeeting'),
                       button('建待办', lambda: self.create_todo_dialog('todo', selected['id']), name='contactTodo')]
            for action in actions:
                action.setEnabled(selected['id'] != self.state.current_account_id)
            dl.addWidget(row(*actions, None))
            dl.addWidget(label('最近沟通', 'field'))
            history = self.state.messages_with(selected['id'])
            if history:
                transcript = QTextEdit()
                transcript.setObjectName('contactRecentMessages')
                transcript.setReadOnly(True)
                transcript.setPlainText('\n\n'.join(self.state.member(message['sender'])['name'] + '  ' + message['time'] +
                                                   '\n' + (message['text'] or '文件：' + '、'.join(message.get('attachments', [])))
                                                   for message in history[-6:]))
                dl.addWidget(transcript, 1)
            else:
                dl.addWidget(label('还没有消息，可以先和同事打个招呼。', 'caption'))
                dl.addStretch()
            dl.addWidget(label('本次预览内模拟协作，会议邀请与消息未发送到企业系统。', 'caption'))
        else:
            dl.addWidget(label('没有匹配的成员', 'section'))
            dl.addWidget(label('尝试搜索姓名、部门或岗位。', 'muted'))
            dl.addStretch()
        body.addWidget(detail, 1)
        layout.addLayout(body, 1)

    def page_integrations(self, layout):
        self.header(layout, '公司系统集成', '本公司使用的系统插件，让 Agent 在授权范围内连接业务。',
                    [button('导入说明', self.integration_import_help, 'quiet'),
                     button('导入插件', self.import_integration_dialog, 'primary', 'importIntegration')])
        intro, il = box('hero', 20, 9)
        il.addWidget(row(label('按公司的工作方式定制', 'cardTitle'), None,
                         button('联系产品公司定制', self.customization_dialog, 'text', 'customizeIntegration')))
        il.addWidget(label('企业已有的 OA、ERP、CRM、HR 等系统，可由产品公司开发适配插件，交付后导入 Agent。', 'muted'))
        layout.addWidget(intro)
        search = self.search_field('integrationSearch', self.state.integration_query, '搜索公司系统或功能', 'integration_query')
        search.setMaximumWidth(360)
        layout.addWidget(row(label('本公司系统插件', 'section'), None, search))
        records = [record for record in self.state.integration_plugins if self.state.integration_query.casefold() in
                   (record['system'] + record['name'] + ' '.join(record['capabilities'])).casefold()]
        def integration_card(record):
            card = WorkCard(lambda: self.integration_details(record), 'integration_' + record['id'])
            cl = QVBoxLayout(card)
            cl.setContentsMargins(20, 20, 20, 18)
            cl.setSpacing(12)
            glyph = label(record['system'].split()[0][:3], 'itemBadge', False)
            glyph.setFixedSize(42, 38)
            cl.addWidget(row(glyph, None, label(record['status'], 'tag')))
            cl.addWidget(label(record['system'], 'workTitle'))
            cl.addWidget(label(record['description'], 'muted'), 1)
            cl.addWidget(label(' · '.join(record['capabilities'][:3]), 'caption'))
            cl.addWidget(row(label('v' + record['version'], 'caption'), None,
                             button('查看系统详情 →', lambda: self.integration_details(record), 'text')))
            return card
        layout.addWidget(self.grid(records, integration_card, 3 if self.width() >= 1260 else 2))
        layout.addWidget(label(f'{len(records)} 个系统插件 · 示例插件待配置；导入仅载入清单，不执行插件代码。', 'caption'))

    def item_status_control(self, item, name):
        control = QComboBox()
        control.setObjectName(name)
        control.setAccessibleName(item['title'] + '的状态')
        options = ['待参加', '进行中', '已完成', '已取消'] if item['kind'] == 'schedule' else list(TODO_STATUSES)
        if item['status'] not in options:
            options.insert(0, item['status'])
        control.addItems(options)
        control.setCurrentText(item['status'])
        control.setMinimumWidth(104)
        control.currentTextChanged.connect(lambda value: self.change_item_status(item['id'], value))
        return control

    def today_item_row(self, item, calendar=False, origin=None):
        host = QWidget()
        hl = QHBoxLayout(host)
        hl.setContentsMargins(0, 0, 0, 0)
        hl.setSpacing(14)
        time_text = item['time'] or '待安排'
        if calendar and item.get('end_time'):
            time_text += '\n' + item['end_time']
        time = label(time_text, 'timelineTime', False)
        time.setFixedWidth(58)
        time.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        hl.addWidget(time)
        dot = label('●', 'timelineDot', False)
        dot.setFixedWidth(12)
        hl.addWidget(dot)
        origin = origin or ('calendar' if calendar else 'home')
        card = WorkCard(lambda key=item['id']: self.open_today_item(key, origin),
                        f'{origin}_{item["id"]}' if origin in ('calendar', 'tasks') else f'today_{item["id"]}')
        card.setAccessibleName(f'{item["time"] or "待安排"} {item["title"]}，{ITEM_KINDS[item["kind"]]}，{item["status"]}')
        cl = QHBoxLayout(card)
        cl.setContentsMargins(18, 13, 16, 13)
        cl.setSpacing(14)
        badge = label({'task': '任', 'todo': '待', 'system': '办', 'schedule': '历'}[item['kind']], 'itemBadge', False)
        badge.setProperty('itemKind', item['kind'])
        badge.setFixedSize(36, 36)
        badge.setAlignment(Qt.AlignCenter)
        cl.addWidget(badge)
        text = QVBoxLayout()
        text.setSpacing(6)
        text.addWidget(label(item['title'], 'cardTitle'))
        metadata = f'{ITEM_KINDS[item["kind"]]}  ·  {item["source"]}'
        if calendar and item['kind'] == 'schedule':
            metadata = f'{item.get("location") or "地点待定"}  ·  {1 + len(item.get("participants", []))} 人参与  ·  {item["source"]}'
        elif item['kind'] != 'schedule':
            metadata = f'{ITEM_KINDS[item["kind"]]}  ·  {item["owner"]}负责  ·  {item["source"]}'
        text.addWidget(label(metadata, 'caption'))
        cl.addLayout(text, 1)
        cl.addWidget(label('›', 'muted', False))
        for child in card.findChildren(QLabel):
            child.setAttribute(Qt.WA_TransparentForMouseEvents, True)
            child.setTextInteractionFlags(Qt.NoTextInteraction)
        hl.addWidget(card, 1)
        hl.addWidget(self.item_status_control(item, origin + 'Status_' + item['id']))
        return host

    def page_item_detail(self, layout):
        item = self.state.item(self.state.selected_item_id)
        origin = self.state.detail_return_page
        back_title = {'calendar': '日历', 'tasks': '工作'}.get(origin, '今日工作')
        if item is None:
            self.header(layout, '事项暂不可用', '返回列表查看其他事项。',
                        [button('返回' + back_title, lambda: self.navigate(origin), name='detailBack')])
            return
        layout.addWidget(row(button('← ' + back_title, lambda: self.navigate(origin), 'text', 'detailBack'), None,
                             label(ITEM_KINDS[item['kind']], 'tag')))
        self.header(layout, item['title'], item['source'])
        facts, fl = box('hero', 20, 12)
        when = item['date'] + '  ' + (item['time'] or '待安排')
        if item.get('end_time'):
            when += ' — ' + item['end_time']
        fl.addWidget(row(label('当前状态', 'cardTitle'), self.item_status_control(item, 'detailItemStatus'), None,
                        label('时间  ' + when, 'muted', False)))
        fl.addWidget(label(f'发起人  {item["initiator"]}       负责人  {item["owner"]}', 'muted'))
        layout.addWidget(facts)
        content, cl = box('card', 24, 14)
        cl.addWidget(label('事项内容', 'section'))
        cl.addWidget(label(item['description']))
        cl.addSpacing(8)
        if item['kind'] == 'schedule':
            cl.addWidget(label('地点  ' + (item.get('location') or '待确定'), 'muted'))
            cl.addWidget(label('参与成员', 'field'))
            cl.addWidget(label(item['owner'] + '  ·  ' + ('发起人' if item['source'] == '工作台日历' else '当前成员'), 'muted'))
            for member in item.get('participants', []):
                cl.addWidget(row(label(member['name']), None, label(member['status'], 'tag')))
            if item['source'] == '工作台日历' and item.get('participants'):
                cl.addWidget(label('邀请状态仅在本次原型中记录，尚未发送企业通知。', 'caption'))
            cl.addSpacing(8)
        cl.addWidget(label('相关资料', 'field'))
        for name in item['materials']:
            cl.addWidget(label('↳  ' + name, 'muted'))
        if not item['materials']:
            cl.addWidget(label('暂无关联资料', 'caption'))
        else:
            cl.addWidget(label('示例资料名称 · 未读取文件内容', 'caption'))
        layout.addWidget(content)
        assist = button('让 Agent 协助  →', lambda: self.open_item_assistance(item['id']),
                        'primary', 'detailAssist')
        actions = [assist]
        if item['kind'] == 'system' or item['kind'] == 'schedule' and item['source'] != '工作台日历':
            source = button('打开原系统', lambda: None, name='detailSource')
            source.setEnabled(False)
            source.setToolTip('该事项为演示数据，连接企业系统后可打开原记录。')
            actions.append(source)
        layout.addWidget(row(*actions, None))
        layout.addWidget(label('进入协助会话时会带入当前事项，发送要求后开始处理。', 'caption'))

    def page_calendar(self, layout):
        selected = date.fromisoformat(self.state.calendar_date)
        self.header(layout, '日历', '查看一天的安排，邀请同事一起参与。',
                    [button('＋ 新建待办', self.create_todo_dialog, name='calendarNewTodo'),
                     button('＋ 新建日程', self.create_schedule_dialog, 'primary', 'calendarNew')])
        picker = QDateEdit(QDate(selected.year, selected.month, selected.day))
        picker.setObjectName('calendarDatePicker')
        picker.setAccessibleName('选择日程日期')
        picker.setCalendarPopup(True)
        picker.setDisplayFormat('yyyy-MM-dd')
        picker.setMaximumWidth(160)
        picker.dateChanged.connect(lambda value: self.select_calendar_date(value.toString('yyyy-MM-dd')))
        layout.addWidget(row(button('‹', lambda: self.shift_calendar_date(-1), 'quiet', 'calendarPrev'),
                             picker, button('›', lambda: self.shift_calendar_date(1), 'quiet', 'calendarNext'),
                             button('今天', self.open_calendar, 'quiet', 'calendarToday'), None,
                             label('日程与待办', 'caption')))
        week_start = selected - timedelta(days=selected.weekday())
        days = []
        for offset in range(7):
            day = week_start + timedelta(days=offset)
            day_key = day.isoformat()
            text = f'周{"一二三四五六日"[day.weekday()]}\n{day.day}'
            entry = button(text, lambda key=day_key: self.select_calendar_date(key), 'calendarDay',
                           'calendarDay_' + day_key)
            entry.setCheckable(True)
            entry.setChecked(day == selected)
            entry.setMinimumHeight(60)
            entry.setAccessibleName(day_key + ' 的日程')
            days.append(entry)
        layout.addWidget(row(*days))
        items = self.state.day_items(self.state.calendar_date)
        weekday = '一二三四五六日'[selected.weekday()]
        layout.addWidget(row(label(f'{selected.month}月{selected.day}日 · 星期{weekday}', 'section'), None,
                             label(f'{len(items)} 项安排', 'caption')))
        if items:
            for item in items:
                layout.addWidget(self.today_item_row(item, calendar=True))
        else:
            empty, el = box('hero', 26, 12)
            empty.setObjectName('calendarEmpty')
            el.addWidget(label('这一天还没有安排', 'section'))
            el.addWidget(label('新建待办，或安排日程并邀请同事参与。', 'muted'))
            el.addWidget(row(button('＋ 新建待办', self.create_todo_dialog, 'primary', 'calendarEmptyNewTodo'),
                             button('＋ 新建日程', self.create_schedule_dialog, name='calendarEmptyNewSchedule'), None))
            layout.addWidget(empty)
        layout.addWidget(label('日程与成员邀请为本次预览内的演示记录。', 'caption'))

    def home_tray(self):
        tray, tl = box('tray', 20, 13)
        tray.setObjectName('homeTray')
        tray.setFixedWidth(238)
        tl.addWidget(label('你的工作资料', 'section'))
        today = datetime.now()
        weekdays = ['一', '二', '三', '四', '五', '六', '日']
        tl.addWidget(label(f'{today.month}月{today.day}日 · 星期{weekdays[today.weekday()]}', 'caption'))
        tl.addSpacing(12)
        tl.addWidget(row(label('最近使用', 'overline'), None,
                         button('全部', lambda: self.navigate('knowledge'), 'text')))
        for record in [self.state.files[1], self.state.files[2], self.state.files[3]]:
            entry = button(record['name'], lambda f=record: self.file_dialog(f), 'workspaceNav')
            entry.setIcon(icon('doc', '#7C8381', 18))
            entry.setToolTip(record['name'] + ' · ' + record['kind'])
            tl.addWidget(entry)
            tl.addWidget(label(record['kind'] + '  ·  ' + record['category'], 'caption'))
        tl.addSpacing(24)
        tl.addWidget(label('等你最后看一眼', 'overline'))
        pending, pl = box('inset', 15, 12)
        pl.addWidget(label('本周销售经营周报', 'cardTitle'))
        pl.addWidget(label('草稿已准备好，检查后即可确认交付。' if self.state.task_stage == '待确认'
                           else '当前状态：' + self.state.task_stage, 'muted'))
        pl.addWidget(button('打开草稿 →', lambda: self.open_work(0), 'text', 'trayReview'))
        tl.addWidget(pending)
        tl.addStretch()
        tl.addSpacing(25)
        tl.addWidget(label('保持专注，慢慢完成。', 'heroHint'))
        tl.addWidget(label('资料与任务都在本地演示空间中。', 'caption'))
        return tray

    def work_records(self):
        return [dict(index=0, name='本周销售经营周报', kind='DOCX', space='销售运营',
                     status=self.state.task_stage, description='统计、洞察与下一步建议', time='刚刚'),
                dict(index=1, name='季度品牌回顾', kind='PPTX', space='品牌与市场',
                     status='已完成', description='一份有条理的品牌演示', time='昨天'),
                dict(index=2, name='产品 FAQ 与资料目录', kind='PDF', space='知识服务',
                     status='已完成', description='常见问题和参考资料', time='10月12日')]

    def open_work(self, index):
        if index == -1 or index == 0 and self.state.scenario == 'sales':
            self.navigate('chat')
        elif index == 0:
            self.start_scenario('sales')
        else:
            record = self.work_records()[index]
            self.info(record['name'], '已完成的示例工作记录。正式产品在这里打开原有会话和交付物。')

    def work_card(self, record):
        card = WorkCard(lambda: self.open_work(record['index']), f'work_{record["index"]}')
        card.setAccessibleName(record['name'] + '，' + record['status'])
        cl = QVBoxLayout(card)
        cl.setContentsMargins(17, 18, 17, 16)
        cl.setSpacing(13)
        art = FileTile(record['kind'], self.state.dark)
        art.setFixedSize(120, 94)
        body = QWidget()
        bl = QVBoxLayout(body)
        bl.setContentsMargins(0, 0, 0, 0)
        bl.setSpacing(8)
        bl.addWidget(label(record['kind'] + '  /  ' + record['space'], 'overline'))
        bl.addWidget(label(record['name'], 'workTitle'))
        bl.addWidget(label(record['description'], 'caption'))
        bl.addStretch()
        cl.addWidget(row(art, body))
        cl.addWidget(row(label(record['status'], 'tag'), None, label(record['time'], 'caption')))
        card.setMinimumHeight(160)
        return card

    def tool_card(self, record):
        card = WorkCard(lambda: self.bench_dialog(record), kind='toolCard')
        card.setAccessibleName(record['name'])
        cl = QVBoxLayout(card)
        cl.setContentsMargins(16, 16, 16, 16)
        cl.setSpacing(8)
        glyph = QLabel()
        glyph.setPixmap(icon({'sales': 'workbench', 'ppt': 'panel'}.get(record['key'], 'doc'),
                             '#90BFB5' if self.state.dark else '#28736B', 22).pixmap(22, 22))
        cl.addWidget(row(glyph, None, label('↗', 'muted', False)))
        cl.addWidget(label(record['name'], 'cardTitle'))
        cl.addWidget(label({'sales': '从数据到一份经营洞察', 'documents': '从想法到清晰的文档',
                            'ppt': '从大纲到品牌演示'}.get(record['key'], record['category']), 'caption'))
        return card

    def bench_card(self, record):
        card = WorkCard(lambda: self.bench_dialog(record), kind='workCard')
        card.setAccessibleName(record['name'])
        cl = QVBoxLayout(card)
        cl.setContentsMargins(23, 23, 23, 20)
        cl.setSpacing(12)
        kind = {'sales': 'XLSX', 'ppt': 'PPTX', 'knowledge': 'PDF', 'quote': 'XLSX'}.get(record['key'], 'DOCX')
        cl.addWidget(FileTile(kind, self.state.dark))
        cl.addWidget(row(label(record['category'], 'overline'), None, label(record['tag'], 'tag')))
        cl.addWidget(label(record['name'], 'workTitle'))
        cl.addWidget(label(record['description'], 'muted'), 1)
        cl.addWidget(button('用这个场景开始 →', lambda: self.bench_dialog(record), 'text'))
        return card

    def page_benches(self, layout):
        self.header(layout, '为每一种工作，准备好起点。', '选一个场景，资料、模板和助手一起就位。',
                    [button('逛逛市场', self.market_dialog, 'quiet'),
                     button('自建场景', self.create_bench_dialog, 'primary', 'createBench')])
        search = self.search_field('benchSearch', self.state.bench_query, '搜索场景与工作台', 'bench_query')
        search.setMaximumWidth(280)
        layout.addWidget(row(self.tabs(['全部', '销售运营', '行政协作', '品牌营销', '知识服务'], self.state.bench_filter,
                                      lambda v: self.set_filter('bench_filter', v)), None, search))
        items = [b for b in self.state.benches if (self.state.bench_filter == '全部' or b['category'] == self.state.bench_filter)
                 and self.state.bench_query.casefold() in (b['name'] + b['description']).casefold()]
        layout.addWidget(self.grid(items, self.bench_card, 3 if self.width() >= 1260 else 2))

    def page_tasks(self, layout):
        self.header(layout, '手头的日常工作', '处理自己负责的事项，也跟进派发给同事的工作。',
                    [button('新建待办', self.create_todo_dialog, name='workNewTodo'),
                     button('派发任务', lambda: self.create_todo_dialog('task'), 'primary', 'workNewTask')])
        scope = QComboBox()
        scope.setObjectName('workScope')
        scope.setAccessibleName('工作范围')
        scope.addItems(['我负责的', '我派发的', '全部工作'])
        scope.setCurrentText(self.state.work_scope)
        scope.currentTextChanged.connect(lambda value: self.set_filter('work_scope', value))
        layout.addWidget(row(scope, None, label('任务与待办统一处理', 'caption')))
        scoped = [item for item in self.state.today_items if item['kind'] != 'schedule' and
                  (self.state.work_scope == '全部工作' or
                   self.state.work_scope == '我负责的' and item.get('owner_id') == self.state.current_account_id or
                   self.state.work_scope == '我派发的' and item.get('initiator_id') == self.state.current_account_id)]
        summary, sl = box('hero', 18, 8)
        metrics = []
        for title, number in [('待处理', sum(item['status'] in ('待处理', '待补充') for item in scoped)),
                              ('进行中', sum(item['status'] == '进行中' for item in scoped)),
                              ('已完成', sum(item['status'] == '已完成' for item in scoped))]:
            metrics.extend([label(str(number), 'metric'), label(title, 'caption'), None])
        sl.addWidget(row(*metrics))
        layout.addWidget(summary)
        layout.addWidget(self.tabs(['全部', '待处理', '进行中', '已完成', '已取消'], self.state.task_filter,
                                   lambda value: self.set_filter('task_filter', value)))
        records = sorted([item for item in scoped if self.state.task_filter == '全部' or
                          item['status'] == self.state.task_filter or
                          self.state.task_filter == '待处理' and item['status'] == '待补充'],
                         key=lambda item: (item['date'], not bool(item['time']), item['time'], item['id']))
        self.visible_works = records
        self.selected_work = None
        last_date = None
        for item in records:
            if item['date'] != last_date:
                last_date = item['date']
                layout.addWidget(label(('今天 · ' if last_date == date.today().isoformat() else '') + last_date, 'field'))
            layout.addWidget(self.today_item_row(item, origin='tasks'))
        if not records:
            empty, el = box('card', 24, 12)
            el.addWidget(label('这里暂时没有工作', 'section'))
            el.addWidget(label('选择其他状态，或新建一项日常工作。', 'muted'))
            el.addWidget(row(button('新建待办', self.create_todo_dialog, 'primary', 'workEmptyNewTodo'), None))
            layout.addWidget(empty)
        layout.addWidget(label(f'{len(records)} 项工作 · 点击事项查看详情或让 Agent 协助', 'caption'))

    def open_selected_task(self):
        if self.selected_work is None:
            self.notify('请先选择一条任务，点击工作卡片即可打开')
        else:
            self.open_work(self.selected_work)

    def file_card(self, record):
        card = WorkCard(lambda: self.file_dialog(record), kind='workCard')
        card.setAccessibleName(record['name'])
        cl = QVBoxLayout(card)
        cl.setContentsMargins(19, 18, 19, 18)
        cl.setSpacing(12)
        cl.addWidget(FileTile(record['kind'], self.state.dark))
        cl.addWidget(label(record['name'], 'workTitle'))
        cl.addWidget(label(record['kind'] + '  ·  ' + record['size'], 'caption'))
        cl.addWidget(row(label(record['category'], 'tag'), None,
                         button('用于工作', lambda: self.use_file(record), 'text'),
                         button('查看', lambda: self.file_dialog(record), 'text')))
        return card

    def use_file(self, record):
        if not record or self.state.drive_access(record) == 'none' or record['kind'] == 'folder':
            self.notify('请选择当前账号可以查看的文件')
            return
        if record['name'] not in self.state.attachments:
            self.state.attachments.append(record['name'])
        self.navigate('chat')
        self.notify('资料已带入当前工作 · 仅记录文件名，未读取或上传正文')

    def page_knowledge(self, layout):
        self.header(layout, '网盘', '像浏览文件夹一样管理资料，按账号设置共享访问条件。',
                    [label('当前账号  ' + self.state.profile['name'], 'tag')])
        if self.state.drive_access(self.state.drive_folder_id) == 'none':
            self.state.drive_folder_id = f'private:{self.state.current_account_id}'
        body = QHBoxLayout()
        body.setSpacing(16)
        locations, ll = box('tray', 12, 10)
        locations.setFixedWidth(208)
        ll.addWidget(label('文件位置', 'cardTitle'))
        tree = QTreeWidget()
        tree.setObjectName('driveFolderTree')
        tree.setAccessibleName('网盘文件夹')
        tree.setHeaderHidden(True)
        tree.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        def add_folder(parent, folder_id, name):
            entry = QTreeWidgetItem([name])
            entry.setData(0, Qt.UserRole, folder_id)
            entry.setIcon(0, icon('folder', '#A1874B', 18))
            if parent:
                parent.addChild(entry)
            else:
                tree.addTopLevelItem(entry)
            for folder in self.state.drive_folders:
                if folder['parent'] == folder_id and self.state.drive_access(folder) != 'none':
                    add_folder(entry, folder['id'], folder['name'])
            if folder_id == self.state.drive_folder_id:
                tree.setCurrentItem(entry)
            return entry
        add_folder(None, f'private:{self.state.current_account_id}', '私有网盘')
        add_folder(None, 'shared', '共享网盘')
        tree.expandAll()
        tree.itemClicked.connect(lambda entry, column: self.open_drive_folder(entry.data(0, Qt.UserRole)))
        tree.itemActivated.connect(lambda entry, column: self.open_drive_folder(entry.data(0, Qt.UserRole)))
        ll.addWidget(tree, 1)
        ll.addWidget(label('私有：仅本人可访问\n共享：按账号授权', 'caption'))
        body.addWidget(locations)
        explorer, el = box('card', 15, 12)
        explorer.setObjectName('driveExplorer')
        back = button('←', lambda: self.drive_navigate('back'), 'quiet', 'driveBack')
        back.setEnabled(bool(self.state.drive_back))
        back.setToolTip('后退')
        forward = button('→', lambda: self.drive_navigate('forward'), 'quiet', 'driveForward')
        forward.setEnabled(bool(self.state.drive_forward))
        forward.setToolTip('前进')
        up = button('↑', lambda: self.drive_navigate('up'), 'quiet', 'driveUp')
        up.setEnabled(self.state.drive_record(self.state.drive_folder_id) is not None)
        up.setToolTip('上一级')
        address = QLineEdit(self.state.drive_path())
        address.setObjectName('driveAddress')
        address.setAccessibleName('当前文件夹路径')
        address.setReadOnly(True)
        el.addWidget(row(back, forward, up, address))
        search = self.search_field('fileSearch', self.state.file_query, '搜索资料名称', 'file_query')
        el.addWidget(search)
        writable = self.state.drive_access(self.state.drive_folder_id) in ('edit', 'manage')
        new_folder = button('新建文件夹', self.new_drive_folder_dialog, 'quiet', 'driveNewFolder')
        new_folder.setEnabled(writable)
        upload = button('添加文件', self.choose_files, 'primary', 'importFiles')
        upload.setEnabled(writable)
        self.drive_permissions_button = button('访问权限', self.drive_permissions_dialog, 'quiet', 'drivePermissions')
        self.drive_rename_button = button('重命名', self.rename_drive_dialog, 'quiet', 'driveRename')
        self.drive_use_button = button('用于 AI 会话', lambda: self.use_file(self.state.drive_record(self.state.drive_selected_id)),
                                       'text', 'driveUseFile')
        el.addWidget(row(new_folder, upload, self.drive_rename_button, self.drive_permissions_button, None))
        listing = QTreeWidget()
        listing.setObjectName('driveFileList')
        listing.setAccessibleName('文件与文件夹列表，双击打开')
        listing.setRootIsDecorated(False)
        listing.setHeaderLabels(['名称', '修改日期', '类型', '大小', '访问权限'])
        listing.setSelectionMode(QAbstractItemView.SingleSelection)
        listing.setEditTriggers(QAbstractItemView.NoEditTriggers)
        listing.setAlternatingRowColors(True)
        listing.setSortingEnabled(False)
        listing.setMinimumHeight(100)
        listing.header().setSectionResizeMode(0, QHeaderView.Stretch)
        for column, width in [(1, 110), (2, 76), (3, 74), (4, 90)]:
            listing.header().setSectionResizeMode(column, QHeaderView.Interactive)
            listing.setColumnWidth(column, width)
        if self.width() < 1260:
            listing.setColumnHidden(1, True)
        records = self.state.drive_children()
        self.visible_files = [record for record in records if record['kind'] != 'folder']
        for record in records:
            entry = QTreeWidgetItem([record['name'], record['modified'],
                                    '文件夹' if record['kind'] == 'folder' else record['kind'] + ' 文件',
                                    '—' if record['kind'] == 'folder' else record['size'], ACCESS_LABELS[self.state.drive_access(record)]])
            entry.setData(0, Qt.UserRole, record['id'])
            entry.setIcon(0, icon('folder' if record['kind'] == 'folder' else 'doc',
                                  '#A1874B' if record['kind'] == 'folder' else '#28736B', 20))
            entry.setToolTip(0, record['name'] + '\n所有者：' + self.state.member(record['owner_id'])['name'])
            listing.addTopLevelItem(entry)
            if record['id'] == self.state.drive_selected_id:
                listing.setCurrentItem(entry)
        listing.currentItemChanged.connect(lambda entry, previous: self.select_drive_record(entry.data(0, Qt.UserRole) if entry else ''))
        listing.itemActivated.connect(lambda entry, column: self.open_drive_record(entry.data(0, Qt.UserRole)))
        listing.setContextMenuPolicy(Qt.CustomContextMenu)
        def context_menu(position):
            entry = listing.itemAt(position)
            if not entry:
                return
            listing.setCurrentItem(entry)
            record = self.state.drive_record(entry.data(0, Qt.UserRole))
            menu = QMenu(listing)
            menu.addAction('打开', lambda: self.open_drive_record(record['id']))
            rename = menu.addAction('重命名', self.rename_drive_dialog)
            rename.setEnabled(self.state.drive_access(record) in ('edit', 'manage'))
            menu.addAction('访问权限', lambda: self.drive_permissions_dialog(record['id']))
            if record['kind'] != 'folder':
                menu.addAction('用于 AI 会话', lambda: self.use_file(record))
            menu.exec_(listing.viewport().mapToGlobal(position))
        listing.customContextMenuRequested.connect(context_menu)
        el.addWidget(listing, 1)
        if not records:
            el.addWidget(label('没有匹配的项目' if self.state.file_query else '文件夹为空，可以新建文件夹或添加文件。', 'muted'))
        el.addWidget(row(label(f'{len(records)} 个项目', 'caption'), None, self.drive_use_button))
        el.addWidget(label('双击打开 · 右键管理 · 添加文件仅记录名称和大小，未上传正文。', 'caption'))
        self.select_drive_record(self.state.drive_selected_id if any(record['id'] == self.state.drive_selected_id for record in records) else '')
        body.addWidget(explorer, 1)
        layout.addLayout(body, 1)

    def page_plugins(self, layout):
        if self.state.skill_category == '底层能力':
            layout.addWidget(button('← 返回工作技能', lambda: self.set_filter('skill_category', '全部'), 'text', 'backToSkills'))
            self.legacy_tools(layout)
            return
        self.header(layout, '工作技能', '处理文档、沟通、审批和日常自动化，按需要选择技能。',
                    [button('底层能力', lambda: self.set_filter('skill_category', '底层能力'), 'quiet'),
                     button('添加技能', self.add_skill_dialog, 'primary', 'addSkill')])
        search = self.search_field('skillSearch', self.state.skill_query, '搜索技能或需要处理的工作', 'skill_query')
        search.setMaximumWidth(350)
        layout.addWidget(row(self.tabs(['全部', '办公处理', '沟通协作', '审批流程', '自动化'], self.state.skill_category,
                                       lambda value: self.set_filter('skill_category', value)), None))
        layout.addWidget(row(search, None, button('定制企业技能', self.customization_dialog, 'text')))
        records = [skill for skill in self.state.skills if (self.state.skill_category in ('全部', skill['category'])) and
                   self.state.skill_query.casefold() in (skill['name'] + skill['description']).casefold()]
        def skill_card(skill):
            card = WorkCard(lambda: self.skill_dialog(skill), 'skill_' + skill['id'])
            cl = QVBoxLayout(card)
            cl.setContentsMargins(20, 20, 20, 16)
            cl.setSpacing(12)
            glyph = label(skill['name'][:1], 'itemBadge', False)
            glyph.setFixedSize(38, 38)
            cl.addWidget(row(glyph, None, label(skill['category'], 'tag')))
            cl.addWidget(label(skill['name'], 'workTitle'))
            cl.addWidget(label(skill['description'], 'muted'), 1)
            cl.addWidget(row(label('需配置系统' if skill['integration'] else '办公技能', 'caption'), None,
                             button('查看技能 →', lambda: self.skill_dialog(skill), 'text')))
            return card
        layout.addWidget(self.grid(records, skill_card, 3 if self.width() >= 1260 else 2))
        layout.addWidget(label('技能使用要求将带入 AI 会话，确认并发送后开始原型演示。企业系统操作需完成对应集成。', 'caption'))

    def open_selected_file(self):
        self.notify('请先选择一份资料，点击资料封面即可查看')
