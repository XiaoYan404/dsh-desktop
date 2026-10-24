"""Native workbench regression checks with isolated temporary preferences."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from datetime import date, timedelta
from unittest.mock import patch

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
from PyQt5.QtCore import Qt, QDate, QTime, QEvent
from PyQt5.QtGui import QFont, QFontDatabase
from PyQt5.QtTest import QTest
from PyQt5.QtWidgets import (QApplication, QPushButton, QLineEdit, QLabel, QComboBox,
                             QTableWidget, QListWidget, QFileDialog, QTextEdit, QWidget, QDateEdit, QTimeEdit,
                             QTreeWidget, QTabWidget, QCheckBox, QScrollArea, QFrame)
from app import PrototypeWindow, SETTINGS
from prototype_model import NAV, SCENARIOS, PreferenceStore, PrototypeState
from workbench_ui import WorkCard
from qt_widgets import AnnouncementTicker

application = QApplication.instance() or QApplication([])
application.setQuitOnLastWindowClosed(False)
if sys.platform == 'win32':
    font_directory = Path(os.environ.get('WINDIR', r'C:\Windows')) / 'Fonts'
    for font_filename in ['msyh.ttc', 'segoeui.ttf']:
        font_path = font_directory / font_filename
        if font_path.is_file():
            QFontDatabase.addApplicationFont(str(font_path))
if not QFontDatabase().families():
    raise RuntimeError('Qt 没有可用字体，不能执行文字渲染与布局检查')
application.setFont(QFont('Microsoft YaHei', 10))
qt_exceptions = []
sys.excepthook = lambda kind, value, tb: qt_exceptions.append(f'{kind.__name__}: {value}')


class NativeReview(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='qt-prototype-review-')
        self.directory = Path(self.temp.name)
        self.window = PrototypeWindow(self.directory)
        self.window.show()
        application.processEvents()
        qt_exceptions.clear()

    def tearDown(self):
        self.window.close()
        self.window.deleteLater()
        application.processEvents()
        self.temp.cleanup()
        self.assertEqual(qt_exceptions, [], 'Uncaught Qt signal exceptions')

    def click(self, name, parent=None):
        root = parent or self.window.page_widget
        widget = root.findChild(QPushButton, name)
        self.assertIsNotNone(widget, name)
        QTest.mouseClick(widget, Qt.LeftButton)
        application.processEvents()

    def save_dialog(self, values):
        d = self.window.dialog
        self.assertIsNotNone(d)
        for name, value in values.items():
            field = d.fields[name]
            if isinstance(field, QComboBox):
                field.setCurrentText(value)
            elif hasattr(field, 'setPlainText'):
                field.setPlainText(value)
            else:
                field.setText(value)
        self.click('dialogSave', d)
        return d

    def assert_visible_in_window(self, widget):
        self.assertIsNotNone(widget)
        self.assertTrue(widget.isVisible(), widget.objectName())
        top = widget.mapTo(self.window, widget.rect().topLeft())
        bottom = widget.mapTo(self.window, widget.rect().bottomRight())
        self.assertGreaterEqual(top.x(), 0, widget.objectName())
        self.assertGreaterEqual(top.y(), self.window.menuBar().geometry().bottom(), widget.objectName())
        self.assertLess(bottom.x(), self.window.width(), widget.objectName())
        self.assertLess(bottom.y(), self.window.statusBar().geometry().top(), widget.objectName())

    def test_01_native_startup_and_resource_independence(self):
        """Round 01: real native window and no browser engine dependencies."""
        self.assertTrue(self.window.isVisible())
        self.assertTrue(QFontDatabase().families(), 'Native layout checks require real fonts')
        self.assertIn('PyQt', self.window.windowTitle())
        self.assertGreaterEqual(self.window.width(), 1040)
        self.assertFalse(any('WebEngine' in name or 'WebKit' in name for name in sys.modules))
        self.assertFalse((self.directory / 'preferences.json').exists())

    def test_02_all_navigation_and_selection(self):
        """Round 02: every primary destination and selected state."""
        for key, title in NAV:
            QTest.mouseClick(self.window.nav_buttons[key], Qt.LeftButton)
            application.processEvents()
            self.assertEqual(self.window.state.page, key)
            self.assertIn(title, self.window.breadcrumb.text())
            self.assertTrue(self.window.nav_buttons[key].isChecked())
            self.assertEqual(sum(b.isChecked() for b in self.window.nav_buttons.values()), 1)

    def test_03_desktop_sizes_and_composer_visibility(self):
        """Round 03: three desktop dimensions and the fixed composer."""
        for width, height in [(1440, 900), (1280, 800), (1040, 700)]:
            self.window.resize(width, height)
            for key in ['home', 'chat', 'admin', 'plugins', 'settings']:
                self.window.navigate(key)
                application.processEvents()
                navigation_width = self.window.app_rail.width()
                self.assertLessEqual(self.window.page_widget.width(), self.window.width() - navigation_width)
                self.assertTrue(self.window.nav_buttons['settings'].isVisible())
                if key == 'chat':
                    self.assertTrue(self.window.composer.isVisible())
                    bottom = self.window.composer.mapTo(self.window, self.window.composer.rect().bottomRight()).y()
                    self.assertLess(bottom, self.window.statusBar().geometry().top())

    def test_04_search_no_results_and_keyboard(self):
        """Round 04: native global search, empty result and keyboard activation."""
        d = self.window.search_dialog()
        d.fields['query'].setText('不存在的关键词')
        results = d.findChild(QListWidget, 'searchResults')
        self.assertEqual(results.item(0).text(), '没有找到匹配内容')
        QTest.keyClick(d.fields['query'], Qt.Key_Return)
        self.assertIsNotNone(self.window.dialog)
        d.fields['query'].setText('销售')
        self.assertGreater(results.count(), 0)
        QTest.keyClick(d.fields['query'], Qt.Key_Down)
        self.assertEqual(d.focusWidget(), results)
        QTest.keyClick(results, Qt.Key_Return)
        application.processEvents()
        self.assertIsNotNone(self.window.dialog)

    def test_05_draft_preservation_and_task_isolation(self):
        """Round 05: drafts survive navigation; new tasks cancel pending work."""
        self.window.new_task()
        self.window.composer.setPlainText('未发送的草稿')
        self.window.navigate('home')
        self.window.navigate('chat')
        self.assertEqual(self.window.composer.toPlainText(), '未发送的草稿')
        self.window.send_message()
        self.assertTrue(self.window.timer.isActive())
        self.window.new_task()
        self.assertFalse(self.window.timer.isActive())
        self.assertFalse(self.window.state.busy)
        self.assertEqual(self.window.state.messages, [])
        self.assertEqual(self.window.composer.toPlainText(), '')

    def test_06_workbench_creation_validation_and_live_filter(self):
        """Round 06: blank/duplicate validation and live search."""
        self.window.create_bench_dialog()
        self.save_dialog(dict(name=' ', description=' '))
        self.assertTrue(self.window.dialog.error.isVisible())
        self.save_dialog(dict(name='客户成功工作台', description='整理续约材料'))
        self.assertEqual(len(self.window.state.benches), 7)
        self.window.create_bench_dialog()
        self.save_dialog(dict(name='客户成功工作台', description='重复'))
        self.assertIn('同名', self.window.dialog.error.text())
        self.window.dialog.reject()
        self.window.navigate('benches')
        self.window.page_widget.findChild(QLineEdit, 'benchSearch').setText('客户')
        application.processEvents()
        self.assertEqual(self.window.state.bench_query, '客户')
        self.assertEqual(self.window.page_widget.findChild(QLineEdit, 'benchSearch').text(), '客户')

    def test_07_business_scenario_contexts_and_template(self):
        """Round 07: each scenario has distinct input and template selection."""
        for key, definition in SCENARIOS.items():
            self.window.start_scenario(key)
            self.assertEqual(self.window.state.assistant, definition[1])
            texts = '\n'.join(w.text() for w in self.window.page_widget.findChildren(QLabel))
            if key != 'sales':
                self.assertNotIn('销售明细_本周.xlsx', texts)
                self.assertIn('尚未生成交付物', texts)
        self.window.template_dialog()
        self.save_dialog(dict(template='商务 · 深海蓝'))
        self.assertEqual(self.window.state.template, '商务 · 深海蓝')

    def test_08_send_stop_complete_and_nonblocking_timer(self):
        """Round 08: empty input, stop and completion without business calls."""
        self.window.new_task()
        self.window.send_message()
        self.assertEqual(self.window.state.messages, [])
        self.window.composer.setPlainText('演示停止')
        self.click('sendOrStop')
        self.assertTrue(self.window.state.busy)
        self.click('sendOrStop')
        self.assertFalse(self.window.state.busy)
        self.assertIn('已停止', self.window.state.execution)
        self.window.composer.setPlainText('演示完成')
        self.window.send_message()
        self.window.timer.setInterval(30)
        QTest.qWait(100)
        self.assertFalse(self.window.state.busy)
        self.assertIn('未调用模型', self.window.state.execution)

    def test_09_approval_cancel_then_confirm(self):
        """Round 09: cancelling a decision cannot approve a task."""
        self.window.start_scenario('sales')
        d = self.window.approval_dialog()
        d.reject()
        self.assertEqual(self.window.state.task_stage, '待确认')
        self.assertEqual(self.window.state.reviews, [])
        self.window.approval_dialog()
        self.save_dialog({})
        self.assertEqual(self.window.state.task_stage, '已完成')
        self.assertEqual(len(self.window.state.reviews), 1)
        self.assertIn('不外发', self.window.state.reviews[0]['reason'])

    def test_10_rejection_and_review_trail(self):
        """Round 10: reject requires a reason, preserved in the review list."""
        self.window.reject_dialog()
        self.save_dialog(dict(reason=' '))
        self.assertEqual(self.window.state.task_stage, '待确认')
        self.assertIsNotNone(self.window.dialog)
        self.save_dialog(dict(reason='请补充区域分析'))
        self.assertEqual(self.window.state.task_stage, '已退回')
        self.assertEqual(self.window.state.reviews[0]['reason'], '请补充区域分析')
        d = self.window.review_dialog()
        self.assertEqual(d.findChild(QTableWidget).rowCount(), 1)

    def test_11_task_filters_selection_and_empty_state(self):
        """Work filters show matching cards, a useful empty state and clickable details."""
        self.window.navigate('tasks')
        self.window.set_filter('task_filter', '已取消')
        self.assertEqual(self.window.visible_works, [])
        self.assertEqual(self.window.page_widget.findChildren(WorkCard), [])
        texts = '\n'.join(w.text() for w in self.window.page_widget.findChildren(QLabel))
        self.assertIn('这里暂时没有工作', texts)
        self.window.open_selected_task()
        self.assertIn('先选择', self.window.status.text())
        self.window.set_filter('task_filter', '待处理')
        self.assertEqual(len(self.window.visible_works), 4)
        card = self.window.page_widget.findChild(WorkCard, 'tasks_report')
        self.assertIsNotNone(card)
        QTest.mouseClick(card, Qt.LeftButton)
        application.processEvents()
        self.assertEqual(self.window.state.selected_item_id, 'report')
        self.assertEqual(self.window.state.page, 'item_detail')

    def test_12_file_metadata_cancel_search_and_publication(self):
        """Round 12: import records metadata only, handles missing/cancelled files."""
        self.window.navigate('knowledge')
        sample = self.directory / '中文 资料.txt'
        sample.write_text('This file must not be parsed.', encoding='utf-8')
        with patch.object(QFileDialog, 'getOpenFileNames', return_value=([str(sample), str(self.directory / 'missing.txt')], '')):
            with patch.object(Path, 'read_text', side_effect=AssertionError('Must not read body')):
                self.window.choose_files()
        self.assertEqual(self.window.state.files[-1]['name'], '中文 资料.txt')
        self.assertTrue(self.window.state.files[-1]['imported'])
        self.assertIn('无法访问', self.window.status.text())
        count = len(self.window.state.files)
        with patch.object(QFileDialog, 'getOpenFileNames', return_value=([], '')):
            self.window.choose_files()
        self.assertEqual(len(self.window.state.files), count)
        self.window.set_filter('file_query', '中文')
        self.assertEqual(len(self.window.visible_files), 1)
        self.window.file_dialog(self.window.state.files[0])
        self.save_dialog({})
        self.assertTrue(self.window.state.published)

    def test_13_report_export_cancel_unicode_and_errors(self):
        """Round 13: native save, UTF-8 export, cancel and write failure."""
        dest = self.directory / '中文 周报.txt'
        with patch.object(QFileDialog, 'getSaveFileName', return_value=(str(dest), '')):
            self.assertTrue(self.window.download_report())
        self.assertIn('不是 DOCX', dest.read_text(encoding='utf-8-sig'))
        with patch.object(QFileDialog, 'getSaveFileName', return_value=('', '')):
            self.assertFalse(self.window.download_report())
        with patch.object(QFileDialog, 'getSaveFileName', return_value=(str(self.directory), '')):
            self.assertFalse(self.window.download_report())
        self.assertIn('保存失败', self.window.status.text())

    def test_14_agent_edit_create_duplicate_and_export(self):
        """Round 14: editing/reusing agents and truthful configuration export."""
        self.window.agent_dialog()
        self.save_dialog(dict(name='客户成功助手', role='整理反馈', prompt='不虚构客户信息'))
        self.assertEqual(len(self.window.state.agents), 4)
        self.window.agent_dialog(3)
        self.save_dialog(dict(name='销售分析助手'))
        self.assertIn('同名', self.window.dialog.error.text())
        self.save_dialog(dict(name='客户成功助手', role='整理反馈与续约'))
        self.assertEqual(self.window.state.agents[3]['role'], '整理反馈与续约')
        dest = self.directory / 'agent.json'
        with patch.object(QFileDialog, 'getSaveFileName', return_value=(str(dest), '')):
            self.window.export_agent(3)
        self.assertTrue(json.loads(dest.read_text(encoding='utf-8-sig'))['prototype'])

    def test_15_plugin_dependency_cancel_and_config(self):
        """Round 15: dependency prompt cancel must preserve checkbox state."""
        self.window.navigate('plugins')
        self.window.toggle_plugin('办公文件处理', False)
        self.assertIsNotNone(self.window.dialog)
        self.window.dialog.reject()
        self.assertTrue(self.window.state.plugins['办公文件处理'])
        self.window.toggle_plugin('办公文件处理', False)
        self.save_dialog({})
        self.assertFalse(self.window.state.plugins['办公文件处理'])
        self.assertFalse(self.window.state.plugins['模板 PPT'])
        self.window.toggle_plugin('模板 PPT', True)
        self.assertFalse(self.window.state.plugins['模板 PPT'])
        self.window.plugin_dialog('网页搜索')
        self.save_dialog(dict(scope='所有授权工作区', approval='只读操作自动通过'))
        self.window.plugin_dialog('网页搜索')
        self.assertEqual(self.window.dialog.value('scope'), '所有授权工作区')

    def test_16_market_preflight_install_remove(self):
        """Round 16: simulated marketplace activation and removal."""
        self.window.market_item('合同审核工作台')
        self.window.dialog.reject()
        self.assertNotIn('合同审核工作台', self.window.state.market)
        self.window.market_item('合同审核工作台')
        self.save_dialog({})
        self.assertIn('合同审核工作台', self.window.state.market)
        self.assertIsNotNone(self.window.dialog)
        self.window.market_item('合同审核工作台')
        self.assertNotIn('合同审核工作台', self.window.state.market)

    def test_17_enterprise_roles_invites_and_policy(self):
        """Round 17: proposed roles and invitation drafts never send messages."""
        d = self.window.permissions_dialog()
        self.assertEqual(d.findChild(QTableWidget).rowCount(), 6)
        d.reject()
        self.window.invite_dialog()
        self.save_dialog(dict(name=' '))
        self.assertEqual(self.window.state.members, [])
        self.save_dialog(dict(name='测试成员', role='业务负责人'))
        self.assertEqual(len(self.window.state.members), 1)
        self.window.policy_dialog()
        self.save_dialog(dict(external='禁止对外发送'))
        self.assertEqual(self.window.state.external_policy, '禁止对外发送')

    def test_18_preferences_only_atomic_corruption_and_failure(self):
        """Round 18: only appearance persists, corrupt files do not break startup."""
        self.window.navigate('admin')
        self.window.org_input.setText('测试企业')
        self.window.brand_input.setText('测试工作台')
        self.window.save_brand()
        data = json.loads((self.directory / 'preferences.json').read_text(encoding='utf-8'))
        self.assertEqual(set(data), {'org', 'brand', 'dark', 'compact'})
        self.assertEqual(data['org'], '测试企业')
        self.assertFalse((self.directory / 'preferences.tmp').exists())
        self.window.toggle_theme()
        restored = PrototypeState()
        self.assertEqual(PreferenceStore(self.directory).load(restored), '')
        self.assertTrue(restored.dark)
        (self.directory / 'preferences.json').write_text('{broken', encoding='utf-8')
        self.assertIn('默认', PreferenceStore(self.directory).load(PrototypeState()))
        with patch.object(self.window.store, 'save', side_effect=PermissionError('read only')):
            self.assertFalse(self.window.save_preferences())

    def test_19_settings_privacy_phone_recovery_and_theme(self):
        """Round 19: desktop settings, disabled secrets, pair/unpair, recovery."""
        self.window.navigate('settings')
        for setting in SETTINGS:
            self.window.set_filter('setting', setting)
            QApplication.processEvents()
            self.assertTrue(self.window.page_widget.isVisible())
        d = self.window.model_dialog()
        self.assertFalse(d.fields['key'].isEnabled())
        d.reject()
        self.window.phone_dialog()
        self.save_dialog({})
        self.assertTrue(self.window.state.phone)
        self.save_dialog({})
        self.assertFalse(self.window.state.phone)
        self.window.dialog.reject()
        self.window.safe_dialog()
        self.save_dialog({})
        self.assertTrue(self.window.state.safe)
        self.window.exit_safe()
        self.assertFalse(self.window.state.safe)
        self.window.toggle_theme()
        self.window.toggle_density()
        self.assertTrue(self.window.state.dark and self.window.state.compact)

    def test_20_input_safety_escape_reset_and_teardown(self):
        """Round 20: plain text, Esc, reset and no orphan execution timer."""
        self.window.new_task()
        self.window.composer.setPlainText('<img src=x onerror=alert(1)>中文')
        self.window.send_message()
        self.assertIn('<img', self.window.state.messages[0])
        self.assertTrue(all(l.textFormat() == Qt.PlainText for l in self.window.page_widget.findChildren(QLabel)))
        d = self.window.info('Esc 测试', '关闭后保持任务不变')
        QTest.keyClick(d, Qt.Key_Escape)
        application.processEvents()
        self.assertIsNone(self.window.dialog)
        self.window.reset_demo()
        self.assertFalse(self.window.timer.isActive())
        self.assertEqual(self.window.state.messages, [])
        self.assertEqual(self.window.state.task_stage, '待确认')
        self.window.new_task()
        self.window.composer.setPlainText('退出前任务')
        self.window.send_message()
        self.window.close()
        self.assertFalse(self.window.timer.isActive())

    def test_21_home_agenda_keeps_time_order_and_opens_full_ai_conversation(self):
        """The combined agenda keeps all pending work, with an embedded chat below."""
        self.window.state.today_items.reverse()
        self.window.render()
        self.assertIsNotNone(self.window.page_widget.findChild(QTextEdit, 'homeChatInput'))
        agenda = self.window.page_widget.findChild(QListWidget, 'homeAgenda')
        ids = [agenda.item(index).data(Qt.UserRole) for index in range(agenda.count())]
        self.assertEqual(ids[:4], ['meeting', 'report', 'purchase', 'customer'])
        self.assertEqual(set(ids[4:]), {'inventory', 'expense'})
        self.click('homeOpenAgent')
        self.assertEqual(self.window.state.page, 'chat')
        self.assertFalse(self.window.state.active_item_id)
        self.assertEqual(self.window.composer.toPlainText(), '')

    def test_22_item_keyboard_opens_detail_then_unsent_assistance(self):
        """A timeline item opens its own page before explicitly requested assistance."""
        agenda = self.window.page_widget.findChild(QListWidget, 'homeAgenda')
        agenda.setCurrentRow(1)
        agenda.setFocus()
        QTest.keyClick(agenda, Qt.Key_Return)
        application.processEvents()
        self.assertEqual(self.window.state.page, 'item_detail')
        self.assertTrue(self.window.nav_buttons['home'].isChecked())
        self.assertEqual(self.window.state.selected_item_id, 'report')
        self.click('detailAssist')
        self.assertEqual(self.window.state.page, 'chat')
        self.assertEqual(self.window.state.active_item_id, 'report')
        self.assertEqual(self.window.composer.toPlainText(), '')
        self.assertEqual(self.window.state.messages, [])
        self.assertFalse(self.window.state.busy)
        self.assertFalse(self.window.timer.isActive())
        texts = '\n'.join(w.text() for w in self.window.page_widget.findChildren(QLabel))
        self.assertIn(self.window.state.item('report')['description'], texts)
        self.assertNotIn('销售明细_本周.xlsx', texts)
        self.click('chatItemDetails')
        self.assertEqual(self.window.state.page, 'item_detail')
        self.click('detailBack')
        self.assertEqual(self.window.state.page, 'home')

    def test_23_item_attachment_metadata_stays_with_its_conversation(self):
        """Selecting materials never reads their body and does not leak into other items."""
        self.window.open_item_assistance('report')
        sample = self.directory / '会议 资料.txt'
        sample.write_text('Private body: must never be read by the prototype.', encoding='utf-8')
        with patch.object(QFileDialog, 'getOpenFileNames', return_value=([str(sample)], '')):
            with patch.object(Path, 'read_text', side_effect=AssertionError('Must not read body')):
                self.click('attachFiles')
        self.assertEqual(self.window.state.attachments, ['会议 资料.txt'])
        with patch.object(QFileDialog, 'getOpenFileNames', return_value=([], '')):
            self.click('attachFiles')
        self.window.composer.setPlainText('从这些资料整理会议行动项')
        self.window.open_item_assistance('purchase')
        self.assertEqual(self.window.state.attachments, [])
        self.assertEqual(self.window.state.draft, '')
        self.window.open_item_assistance('report')
        self.assertEqual(self.window.state.attachments, ['会议 资料.txt'])
        self.assertEqual(self.window.state.draft, '从这些资料整理会议行动项')
        self.assertEqual(self.window.state.messages, [])
        self.assertFalse(self.window.state.busy)

    def test_24_continue_current_task_keeps_work_context(self):
        """Returning through the conversation rail keeps current context and materials."""
        self.window.new_task()
        self.window.state.messages.append('已经发送的工作要求')
        self.window.state.attachments.append('项目资料.pdf')
        self.window.state.template = '商务 · 深海蓝'
        self.window.composer.setPlainText('待补充的修改要求')
        self.window.navigate('home')
        QTest.mouseClick(self.window.nav_buttons['chat'], Qt.LeftButton)
        application.processEvents()
        self.assertEqual(self.window.state.page, 'chat')
        self.assertEqual(self.window.composer.toPlainText(), '待补充的修改要求')
        self.assertEqual(self.window.state.messages, ['已经发送的工作要求'])
        self.assertEqual(self.window.state.attachments, ['项目资料.pdf'])
        self.assertEqual(self.window.state.template, '商务 · 深海蓝')

    def test_25_work_card_keyboard_opens_record_or_active_task(self):
        """Work cards expose a keyboard action for both completed and pending work."""
        self.window.navigate('tasks')
        card = self.window.page_widget.findChild(WorkCard, 'tasks_inventory')
        self.assertIsNotNone(card)
        self.assertTrue(card.accessibleName())
        card.setFocus()
        QTest.keyClick(card, Qt.Key_Return)
        application.processEvents()
        self.assertEqual(self.window.state.selected_item_id, 'inventory')
        self.click('detailBack')
        card = self.window.page_widget.findChild(WorkCard, 'tasks_report')
        card.setFocus()
        QTest.keyClick(card, Qt.Key_Return)
        application.processEvents()
        self.assertEqual(self.window.state.page, 'item_detail')
        self.assertEqual(self.window.state.selected_item_id, 'report')

    def test_26_work_pages_show_artifacts_without_management_tables(self):
        """Home, work and materials retain direct artifact access without data tables."""
        for page in ['home', 'tasks', 'knowledge']:
            self.window.navigate(page)
            application.processEvents()
            self.assertEqual(self.window.page_widget.findChildren(QTableWidget), [], page)
            if page == 'tasks':
                self.assertGreater(len(self.window.page_widget.findChildren(WorkCard)), 0, page)
            elif page == 'knowledge':
                self.assertIsNotNone(self.window.page_widget.findChild(QTreeWidget, 'driveFileList'))

    def test_27_desktop_primary_controls_remain_in_view(self):
        """Primary controls and rail destinations fit all supported desktop sizes."""
        controls = {
            'home': [(QPushButton, 'homeOpenAgent'), (QTextEdit, 'homeChatInput'),
                     (QPushButton, 'homeSendOrStop'), (QPushButton, 'homeOpenCalendar')],
            'item_detail': [(QPushButton, 'detailBack'), (QPushButton, 'detailAssist')],
            'calendar': [(QDateEdit, 'calendarDatePicker'), (QPushButton, 'calendarNew')],
            'benches': [(QLineEdit, 'benchSearch'), (QPushButton, 'createBench')],
            'tasks': [(WorkCard, 'tasks_report'), (QPushButton, 'workNewTask')],
            'knowledge': [(QLineEdit, 'fileSearch'), (QPushButton, 'importFiles')],
            'chat': [(QTextEdit, 'chatInput'), (QPushButton, 'sendOrStop')],
        }
        self.window.state.selected_item_id = 'report'
        for width, height in [(1440, 900), (1280, 800), (1040, 700)]:
            self.window.resize(width, height)
            application.processEvents()
            self.assertEqual(self.window.width(), width)
            self.assertEqual(self.window.height(), height)
            for page, fields in controls.items():
                self.window.navigate(page)
                application.processEvents()
                with self.subTest(width=width, height=height, page=page):
                    for widget_type, name in fields:
                        self.assert_visible_in_window(self.window.page_widget.findChild(widget_type, name))
                    self.assert_visible_in_window(self.window.nav_buttons['settings'])
                    if page == 'home':
                        dashboard = self.window.page_widget.findChild(QWidget, 'homeDashboard')
                        calendar = self.window.page_widget.findChild(QWidget, 'homeCalendarTodo')
                        panel = self.window.page_widget.findChild(QWidget, 'homeChatPanel')
                        self.assertGreater(dashboard.width(), calendar.width())
                        self.assertGreater(panel.y(), dashboard.parentWidget().geometry().bottom())

    def test_28_item_conversations_keep_messages_drafts_and_results_separate(self):
        self.window.open_item_assistance('report')
        self.window.composer.setPlainText('帮我起草报告')
        self.window.send_message()
        self.window.timer.setInterval(20)
        QTest.qWait(150)
        self.assertFalse(self.window.state.busy)
        self.window.composer.setPlainText('补充下周计划')
        result = self.window.state.execution
        self.window.open_item_assistance('purchase')
        self.assertEqual(self.window.state.messages, [])
        self.assertEqual(self.window.state.execution, '')
        self.window.composer.setPlainText('核对采购用途')
        self.window.send_message()
        self.window.open_item_assistance('report')
        self.assertFalse(self.window.timer.isActive())
        self.assertFalse(self.window.state.busy)
        self.assertEqual(self.window.state.messages, ['帮我起草报告'])
        self.assertEqual(self.window.state.draft, '补充下周计划')
        self.assertEqual(self.window.state.execution, result)
        self.window.open_item_assistance('purchase')
        self.assertEqual(self.window.state.messages, ['核对采购用途'])
        self.assertIn('已停止', self.window.state.execution)

    def test_29_today_empty_and_date_status_scope(self):
        self.window.state.today_items[0]['date'] = '2000-01-01'
        for item in self.window.state.today_items[1:]:
            item['status'] = '已完成'
        self.window.render()
        self.assertEqual(self.window.page_widget.findChildren(WorkCard), [])
        agenda = self.window.page_widget.findChild(QListWidget, 'homeAgenda')
        self.assertEqual(agenda.count(), 5)
        self.assertTrue(all('已完成' in agenda.item(index).text() for index in range(agenda.count())))
        self.assertEqual(self.window.state.today_groups(), ([], []))
        self.click('homeOpenAgent')
        self.assertEqual(self.window.state.page, 'chat')

    def test_30_general_chat_survives_item_assistance_and_new_work(self):
        self.window.open_general_chat()
        self.window.composer.setPlainText('普通会话的草稿')
        self.window.open_item_assistance('report')
        self.window.composer.setPlainText('报告会话的草稿')
        self.window.open_general_chat()
        self.assertEqual(self.window.state.draft, '普通会话的草稿')
        self.window.new_task()
        self.assertEqual(self.window.state.draft, '')
        self.window.open_item_assistance('report')
        self.assertEqual(self.window.state.draft, '报告会话的草稿')

    def test_31_unavailable_item_and_unconnected_source_are_honest(self):
        self.window.open_today_item('purchase')
        source = self.window.page_widget.findChild(QPushButton, 'detailSource')
        self.assertFalse(source.isEnabled())
        self.window.state.selected_item_id = 'missing'
        self.window.render()
        self.assertIsNone(self.window.page_widget.findChild(QPushButton, 'detailAssist'))
        self.click('detailBack')
        self.window.open_item_assistance('missing')
        self.assertEqual(self.window.state.page, 'home')
        self.assertFalse(self.window.state.busy)

    def test_32_single_navigation_rail_keeps_new_work_and_search(self):
        self.assertIsNone(self.window.findChild(QWidget, 'workspaceSidebar'))
        self.assert_visible_in_window(self.window.findChild(QPushButton, 'globalSearch'))
        self.assert_visible_in_window(self.window.findChild(QPushButton, 'newTask'))
        self.click('newTask', self.window)
        self.assertEqual(self.window.state.page, 'chat')

    def test_33_calendar_opens_today_and_switches_dates(self):
        tomorrow = date.today() + timedelta(days=1)
        self.window.state.calendar_date = tomorrow.isoformat()
        self.window.navigate('home')
        self.click('homeOpenCalendar')
        self.assertEqual(self.window.state.calendar_date, date.today().isoformat())
        cards = self.window.page_widget.findChildren(WorkCard)
        self.assertEqual([card.objectName() for card in cards], ['calendar_meeting', 'calendar_report',
                         'calendar_purchase', 'calendar_customer', 'calendar_expense', 'calendar_inventory'])
        picker = self.window.page_widget.findChild(QDateEdit, 'calendarDatePicker')
        picker.setDate(QDate(tomorrow.year, tomorrow.month, tomorrow.day))
        application.processEvents()
        self.assertEqual(self.window.state.calendar_date, tomorrow.isoformat())
        self.assertEqual(self.window.page_widget.findChildren(WorkCard), [])
        self.click('calendarToday')
        day = date.today() + timedelta(days=1 if date.today().weekday() < 6 else -1)
        self.click('calendarDay_' + day.isoformat())
        self.assertEqual(self.window.state.calendar_date, day.isoformat())
        self.click('calendarToday')
        card = self.window.page_widget.findChild(WorkCard, 'calendar_meeting')
        card.setFocus()
        QTest.keyClick(card, Qt.Key_Return)
        application.processEvents()
        self.assertEqual(self.window.state.page, 'item_detail')
        self.assertTrue(self.window.nav_buttons['home'].isChecked())
        self.click('detailBack')
        self.assertEqual(self.window.state.page, 'calendar')

    def test_34_create_schedule_with_multiple_member_invitations(self):
        self.window.open_calendar()
        self.click('calendarNew')
        dialog = self.window.dialog
        dialog.findChild(QTimeEdit, 'schedule_start').setTime(QTime(14, 15))
        dialog.findChild(QTimeEdit, 'schedule_end').setTime(QTime(14, 45))
        members = dialog.findChild(QListWidget, 'scheduleMembers')
        for index in range(members.count()):
            members.item(index).setCheckState(Qt.Checked)
        self.save_dialog(dict(title='项目进度同步', location='2 号会议室', description='同步当前进展与需要协调的事项。'))
        self.assertEqual(self.window.state.page, 'calendar')
        item = self.window.state.today_items[-1]
        self.assertEqual(item['title'], '项目进度同步')
        self.assertEqual(item['time'], '14:15')
        self.assertEqual(item['end_time'], '14:45')
        self.assertEqual({member['name'] for member in item['participants']}, {'陈安', '许宁'})
        self.assertTrue(all(member['status'] == '待回应' for member in item['participants']))
        self.assertIn('未发送通知', self.window.status.text())
        self.assertEqual(len(self.window.state.schedules_for(date.today().isoformat())), 3)
        self.window.open_today_item(item['id'], 'calendar')
        text = '\n'.join(w.text() for w in self.window.page_widget.findChildren(QLabel))
        self.assertIn('2 号会议室', text)
        self.assertIn('陈安', text)
        self.assertIn('许宁', text)
        self.assertIn('待回应', text)
        self.click('detailAssist')
        self.assertEqual(self.window.state.messages, [])
        self.click('chatItemDetails')
        self.click('detailBack')
        self.assertEqual(self.window.state.page, 'calendar')
        self.window.navigate('home')
        agenda = self.window.page_widget.findChild(QListWidget, 'homeAgenda')
        self.assertIn(item['id'], [agenda.item(index).data(Qt.UserRole) for index in range(agenda.count())])

    def test_35_schedule_validation_and_cancel_leave_no_partial_records(self):
        self.window.open_calendar()
        count = len(self.window.state.today_items)
        self.click('calendarNew')
        self.save_dialog(dict(title=' '))
        self.assertIn('标题', self.window.dialog.error.text())
        self.assertEqual(len(self.window.state.today_items), count)
        self.window.dialog.findChild(QTimeEdit, 'schedule_end').setTime(QTime(8, 0))
        self.save_dialog(dict(title='时间校验'))
        self.assertIn('结束时间', self.window.dialog.error.text())
        self.assertEqual(len(self.window.state.today_items), count)
        self.window.dialog.reject()
        self.assertEqual(len(self.window.state.today_items), count)
        with self.assertRaises(ValueError):
            self.window.state.add_schedule('无效成员', date.today().isoformat(), '09:00', '10:00', member_ids=['missing'])
        self.assertEqual(len(self.window.state.today_items), count)

    def test_36_schedule_uses_selected_day_and_does_not_leak_into_today(self):
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        self.window.select_calendar_date(tomorrow)
        self.click('calendarNew')
        picker = self.window.dialog.findChild(QDateEdit, 'schedule_date')
        self.assertEqual(picker.date().toString('yyyy-MM-dd'), tomorrow)
        self.save_dialog(dict(title='明日专注时间'))
        self.assertEqual(self.window.state.calendar_date, tomorrow)
        item = self.window.state.today_items[-1]
        self.assertEqual(item['participants'], [])
        self.assertEqual(len(self.window.state.schedules_for(tomorrow)), 1)
        self.window.navigate('home')
        agenda = self.window.page_widget.findChild(QListWidget, 'homeAgenda')
        self.assertNotIn(item['id'], [agenda.item(index).data(Qt.UserRole) for index in range(agenda.count())])

    def test_37_schedule_dialog_primary_controls_fit_small_window(self):
        self.window.resize(1040, 700)
        self.window.open_calendar()
        self.click('calendarNew')
        dialog = self.window.dialog
        application.processEvents()
        self.assertLessEqual(dialog.height(), 700)
        for widget in [dialog.findChild(QListWidget, 'scheduleMembers'),
                       dialog.findChild(QPushButton, 'dialogSave'),
                       dialog.findChild(QDateEdit, 'schedule_date')]:
            self.assertTrue(widget.isVisible())
            point = widget.mapTo(dialog, widget.rect().bottomRight())
            self.assertLess(point.y(), dialog.height())

    def test_38_home_chat_sends_and_shares_general_conversation_without_losing_item_draft(self):
        self.window.state.attachments = ['项目资料.xlsx']
        self.window.composer.setPlainText('帮我整理今天的工作安排')
        self.click('homeSendOrStop')
        self.assertEqual(self.window.state.page, 'chat')
        self.assertTrue(self.window.nav_buttons['chat'].isChecked())
        self.assertTrue(self.window.app_rail.isVisible())
        self.assertEqual(self.window.state.messages, ['帮我整理今天的工作安排'])
        self.assertEqual(self.window.state.attachments, ['项目资料.xlsx'])
        self.assertTrue(self.window.state.busy)
        self.click('sendOrStop')
        self.assertFalse(self.window.state.busy)
        self.window.composer.setPlainText('普通会话待发送草稿')
        self.window.navigate('home')
        self.click('homeOpenAgent')
        self.assertEqual(self.window.composer.toPlainText(), '普通会话待发送草稿')
        self.window.open_item_assistance('report')
        self.window.composer.setPlainText('这份报告的修改要求')
        self.window.navigate('home')
        self.assertEqual(self.window.composer.toPlainText(), '普通会话待发送草稿')
        self.assertEqual(self.window.state.messages, ['帮我整理今天的工作安排'])
        self.window.open_item_assistance('report')
        self.assertEqual(self.window.state.draft, '这份报告的修改要求')

    def test_39_dashboard_progress_follows_today_work_status(self):
        from PyQt5.QtWidgets import QProgressBar
        for item in self.window.state.today_items[:3]:
            item['status'] = '已完成'
        self.window.render()
        self.assertEqual(self.window.page_widget.findChild(QProgressBar, 'homeCompletion').value(), 50)
        self.assertEqual(self.window.page_widget.findChild(QListWidget, 'homeAgenda').count(), 6)

    def test_40_home_empty_send_stays_and_keyboard_send_opens_chat_once(self):
        self.click('homeSendOrStop')
        self.assertEqual(self.window.state.page, 'home')
        self.assertEqual(self.window.state.messages, [])
        self.assertFalse(self.window.timer.isActive())
        self.window.composer.setPlainText('  整理会议纪要并提取行动项  ')
        self.window.composer.setFocus()
        QTest.keyClick(self.window.composer, Qt.Key_Return, Qt.ControlModifier)
        application.processEvents()
        self.assertEqual(self.window.state.page, 'chat')
        self.assertEqual(self.window.state.messages, ['整理会议纪要并提取行动项'])
        self.assertEqual(self.window.state.draft, '')
        self.assertTrue(self.window.state.busy)
        self.assertTrue(self.window.nav_buttons['chat'].isChecked())
        self.assertIsNone(self.window.page_widget.findChild(QTextEdit, 'homeChatInput'))
        self.assert_visible_in_window(self.window.page_widget.findChild(QTextEdit, 'chatInput'))
        self.assert_visible_in_window(self.window.nav_buttons['home'])

    def test_41_empty_home_can_create_todo_and_status_updates_everywhere(self):
        self.window.state.today_items.clear()
        self.window.render()
        self.click('homeEmptyNewTodo')
        self.save_dialog({'title': ' '})
        self.assertTrue(self.window.dialog.error.isVisible())
        self.assertEqual(self.window.state.today_items, [])
        self.save_dialog({'title': '核对本月办公用品'})
        item = self.window.state.today_items[-1]
        self.assertEqual(item['kind'], 'todo')
        self.assertEqual(item['status'], '待处理')
        agenda = self.window.page_widget.findChild(QListWidget, 'homeAgenda')
        self.assertIn('待处理', agenda.item(0).text())
        self.window.open_calendar()
        control = self.window.page_widget.findChild(QComboBox, 'calendarStatus_' + item['id'])
        control.setCurrentText('进行中')
        application.processEvents()
        self.assertEqual(item['status'], '进行中')
        self.window.open_today_item(item['id'], 'calendar')
        self.window.page_widget.findChild(QComboBox, 'detailItemStatus').setCurrentText('已完成')
        application.processEvents()
        self.window.navigate('home')
        from PyQt5.QtWidgets import QProgressBar
        self.assertEqual(self.window.page_widget.findChild(QProgressBar, 'homeCompletion').value(), 100)
        self.assertIn('已完成', self.window.page_widget.findChild(QListWidget, 'homeAgenda').item(0).text())
        self.window.navigate('tasks')
        self.window.set_filter('task_filter', '已完成')
        self.assertEqual([record['id'] for record in self.window.visible_works], [item['id']])

    def test_42_calendar_empty_todo_respects_selected_date_and_cancel(self):
        tomorrow = date.today() + timedelta(days=1)
        self.window.select_calendar_date(tomorrow.isoformat())
        self.click('calendarEmptyNewTodo')
        count = len(self.window.state.today_items)
        self.window.dialog.reject()
        self.assertEqual(len(self.window.state.today_items), count)
        self.click('calendarNewTodo')
        d = self.window.dialog
        self.assertEqual(d.findChild(QDateEdit, 'todoDate').date(), QDate(tomorrow.year, tomorrow.month, tomorrow.day))
        d.findChild(QCheckBox, 'todoHasTime').setChecked(True)
        d.findChild(QTimeEdit, 'todoTime').setTime(QTime(15, 30))
        self.save_dialog({'title': '明天提交材料'})
        item = self.window.state.today_items[-1]
        self.assertEqual((item['date'], item['time']), (tomorrow.isoformat(), '15:30'))
        self.assertEqual(self.window.state.calendar_date, tomorrow.isoformat())
        self.window.navigate('home')
        agenda = self.window.page_widget.findChild(QListWidget, 'homeAgenda')
        self.assertNotIn(item['id'], [agenda.item(index).data(Qt.UserRole) for index in range(agenda.count())])

    def test_43_sidebar_new_conversation_restores_history_draft_and_materials(self):
        self.window.composer.setPlainText('整理今天的工作')
        self.click('homeSendOrStop')
        original = self.window.state.conversation_key
        self.window.select_saved_conversation(original)
        self.assertTrue(self.window.timer.isActive())
        self.click('sendOrStop')
        self.window.state.attachments = ['周报.xlsx']
        self.window.composer.setPlainText('补充销售情况')
        self.click('newConversation')
        self.assertNotEqual(self.window.state.conversation_key, original)
        self.assertEqual(self.window.state.messages, [])
        self.assertEqual(self.window.state.attachments, [])
        self.window.composer.setPlainText('另一件工作的草稿')
        listing = self.window.page_widget.findChild(QListWidget, 'conversationList')
        entry = next(listing.item(index) for index in range(listing.count()) if listing.item(index).data(Qt.UserRole) == original)
        listing.setCurrentItem(entry)
        listing.setFocus()
        QTest.keyClick(listing, Qt.Key_Return)
        application.processEvents()
        self.assertEqual(self.window.state.messages, ['整理今天的工作'])
        self.assertEqual(self.window.state.draft, '补充销售情况')
        self.assertEqual(self.window.state.attachments, ['周报.xlsx'])
        self.window.page_widget.findChild(QLineEdit, 'conversationSearch').setText('整理今天')
        application.processEvents()
        self.assertEqual(self.window.page_widget.findChild(QListWidget, 'conversationList').count(), 1)

    def test_44_profile_sidebar_and_drive_controls_fit_supported_windows(self):
        for width, height in [(1440, 900), (1040, 700)]:
            self.window.resize(width, height)
            for page in ['home', 'chat', 'knowledge', 'messages', 'integrations', 'plugins']:
                self.window.navigate(page)
                application.processEvents()
                with self.subTest(width=width, page=page):
                    self.assertEqual(self.window.width(), width)
                    for name in ['loginAvatar', 'loginName', 'loginRole', 'loginJob']:
                        self.assert_visible_in_window(self.window.findChild(QWidget, name))
                    if page == 'chat':
                        for name in ['conversationSidebar', 'newConversation', 'chatInput', 'sendOrStop']:
                            self.assert_visible_in_window(self.window.page_widget.findChild(QWidget, name))
                    elif page == 'knowledge':
                        for name in ['driveFolderTree', 'driveFileList', 'driveAddress', 'driveNewFolder', 'importFiles']:
                            self.assert_visible_in_window(self.window.page_widget.findChild(QWidget, name))
                    elif page == 'messages':
                        for name in ['organizationTree', 'contactChat', 'contactTask', 'contactMeeting', 'contactTodo']:
                            self.assert_visible_in_window(self.window.page_widget.findChild(QWidget, name))

    def test_45_drive_folder_navigation_create_and_validation(self):
        self.window.navigate('knowledge')
        listing = self.window.page_widget.findChild(QTreeWidget, 'driveFileList')
        folder = next(listing.topLevelItem(index) for index in range(listing.topLevelItemCount())
                      if listing.topLevelItem(index).data(0, Qt.UserRole) == 'private-work')
        listing.setCurrentItem(folder)
        listing.setFocus()
        QTest.keyClick(listing, Qt.Key_Return)
        application.processEvents()
        self.assertEqual(self.window.state.drive_folder_id, 'private-work')
        self.assertIn('工作文档', self.window.page_widget.findChild(QLineEdit, 'driveAddress').text())
        self.click('driveNewFolder')
        self.save_dialog({'name': 'bad/name'})
        self.assertIsNotNone(self.window.dialog)
        self.save_dialog({'name': '合同归档'})
        created = self.window.state.drive_folders[-1]
        self.assertEqual(created['parent'], 'private-work')
        self.click('driveNewFolder')
        self.save_dialog({'name': '合同归档'})
        self.assertIn('同名', self.window.dialog.error.text())
        self.window.dialog.reject()
        self.click('driveBack')
        self.assertEqual(self.window.state.drive_folder_id, 'private:lin-xiao')
        self.click('driveForward')
        self.assertEqual(self.window.state.drive_folder_id, 'private-work')
        self.click('driveUp')
        self.assertEqual(self.window.state.drive_folder_id, 'private:lin-xiao')

    def test_46_drive_permissions_isolate_accounts_and_block_hidden_descendants(self):
        self.window.state.set_drive_permissions('shared-templates', 'none', {'chen-an': 'view'})
        self.window.state.draft = '林晓的私有会话草稿'
        self.window.switch_account('chen-an')
        self.assertEqual(self.window.state.draft, '')
        self.assertEqual(self.window.state.drive_access('private-work'), 'none')
        self.window.open_drive_folder('private-work')
        self.assertEqual(self.window.state.drive_folder_id, 'private:chen-an')
        self.window.use_file(self.window.state.files[1])
        self.assertEqual(self.window.state.attachments, [])
        self.window.file_dialog(self.window.state.files[1])
        self.assertIsNone(self.window.dialog)
        d = self.window.search_dialog()
        d.fields['query'].setText('本周销售明细')
        results = d.findChild(QListWidget, 'searchResults')
        self.assertEqual(results.item(0).text(), '没有找到匹配内容')
        d.reject()
        self.window.open_drive_folder('shared-templates')
        self.assertFalse(self.window.page_widget.findChild(QPushButton, 'importFiles').isEnabled())
        with self.assertRaises(ValueError):
            self.window.state.add_drive_record('无权新建')
        with self.assertRaises(ValueError):
            self.window.state.rename_drive_record('file-2', '越权重命名')
        with self.assertRaises(ValueError):
            self.window.state.set_drive_permissions('shared-templates', 'edit', {})
        self.window.switch_account('xu-ning')
        self.assertEqual(self.window.state.drive_access('shared-templates'), 'none')
        self.assertEqual(self.window.state.drive_access('file-2'), 'none')
        self.window.open_drive_folder('shared')
        self.assertNotIn('shared-templates', [record['id'] for record in self.window.state.drive_children()])
        self.window.switch_account('lin-xiao')
        self.assertEqual(self.window.state.draft, '林晓的私有会话草稿')

    def test_47_drive_permission_dialog_cancel_save_and_owner_control(self):
        self.window.navigate('knowledge')
        original = dict(self.window.state.drive_record('shared-templates')['permissions'])
        d = self.window.drive_permissions_dialog('shared-templates')
        d.findChild(QComboBox, 'permission_chen-an').setCurrentText('可编辑')
        d.reject()
        self.assertEqual(self.window.state.drive_record('shared-templates')['permissions'], original)
        d = self.window.drive_permissions_dialog('shared-templates')
        d.findChild(QComboBox, 'permission_chen-an').setCurrentText('可编辑')
        d.findChild(QComboBox, 'permission_xu-ning').setCurrentText('不可见')
        self.save_dialog({})
        self.assertEqual(self.window.state.drive_access('file-2', 'chen-an'), 'edit')
        self.assertEqual(self.window.state.drive_access('file-2', 'xu-ning'), 'none')
        self.window.switch_account('chen-an')
        self.window.open_drive_folder('shared-templates')
        self.window.state.rename_drive_record('file-2', '已授权修改的模板')
        self.assertEqual(self.window.state.files[2]['name'], '已授权修改的模板')
        d = self.window.drive_permissions_dialog('shared-templates')
        self.assertIsNone(d.findChild(QPushButton, 'dialogSave'))

    def test_48_profile_edit_validation_updates_header_and_directory(self):
        self.click('loginAvatar', self.window)
        self.save_dialog({'name': ' ', 'email': 'bad'})
        self.assertEqual(self.window.state.profile['name'], '林晓')
        self.save_dialog({'name': '林小满', 'role': '业务负责人', 'job': '行政主管', 'email': 'bad'})
        self.assertIn('邮箱', self.window.dialog.error.text())
        self.save_dialog({'email': 'xiaoman@example.com'})
        self.assertEqual(self.window.findChild(QLabel, 'loginName').text(), '林小满')
        self.assertEqual(self.window.findChild(QLabel, 'loginRole').text(), '业务负责人')
        self.assertEqual(self.window.findChild(QLabel, 'loginJob').text(), '行政主管')
        self.window.navigate('messages')
        self.window.page_widget.findChild(QLineEdit, 'contactSearch').setText('林小满')
        application.processEvents()
        self.assertIn('行政主管', '\n'.join(widget.text() for widget in self.window.page_widget.findChildren(QLabel)))
        self.window.profile_dialog()
        self.window.dialog.fields['name'].setText('取消的修改')
        self.window.dialog.reject()
        self.assertEqual(self.window.state.profile['name'], '林小满')

    def test_49_contacts_send_message_and_switch_profile_account(self):
        self.window.navigate('messages')
        self.assertEqual(self.window.nav_buttons['messages'].text(), '通讯录')
        self.click('contactChat')
        chat = self.window.contact_chat_window
        self.click('peerChatSend', chat)
        self.assertEqual(self.window.state.messages_with('chen-an'), [])
        chat.input.setPlainText('请确认本周客户沟通时间')
        self.click('peerChatSend', chat)
        self.assertTrue(chat.isVisible())
        self.assertEqual(self.window.state.messages_with('chen-an')[0]['sender'], 'lin-xiao')
        self.window.profile_dialog()
        d = self.window.dialog
        accounts = d.findChild(QComboBox, 'profileAccount')
        accounts.setCurrentIndex(accounts.findData('chen-an'))
        self.click('switchProfileAccount', d)
        self.assertEqual(self.window.state.current_account_id, 'chen-an')
        self.assertEqual(self.window.findChild(QLabel, 'loginName').text(), '陈安')
        self.window.select_contact('lin-xiao')
        self.click('contactChat')
        chat = self.window.contact_chat_window
        texts = '\n'.join(widget.text() for widget in chat.history.findChildren(QLabel))
        self.assertIn('请确认本周客户沟通时间', texts)
        chat.input.setPlainText('已确认，周五下午沟通')
        self.click('peerChatSend', chat)
        self.window.switch_account('lin-xiao')
        self.assertEqual(len(self.window.state.messages_with('chen-an')), 2)

    def test_50_contacts_assign_task_todo_and_preselect_meeting_member(self):
        self.window.navigate('messages')
        self.click('contactTask')
        self.assertEqual(self.window.dialog.findChild(QComboBox, 'todoOwner').currentData(), 'chen-an')
        self.save_dialog({'title': '准备客户回访清单'})
        task = self.window.state.today_items[-1]
        self.assertEqual(task['owner_id'], 'chen-an')
        self.assertEqual(self.window.state.page, 'tasks')
        self.assertIn(task, self.window.visible_works)
        self.assertEqual(self.window.state.work_scope, '我派发的')
        self.window.navigate('messages')
        self.click('contactTodo')
        self.save_dialog({'title': '确认客户名单'})
        self.assertEqual(self.window.state.today_items[-1]['kind'], 'todo')
        self.window.navigate('messages')
        self.click('contactMeeting')
        members = self.window.dialog.findChild(QListWidget, 'scheduleMembers')
        selected = [members.item(index).data(Qt.UserRole) for index in range(members.count())
                    if members.item(index).checkState() == Qt.Checked]
        self.assertEqual(selected, ['chen-an'])
        self.save_dialog({'title': '客户回访碰头会'})
        self.assertEqual(self.window.state.today_items[-1]['participants'][0]['id'], 'chen-an')

    def test_51_daily_work_scope_status_filters_and_detail_return(self):
        item = self.window.state.add_todo('跨部门任务', date.today().isoformat(), owner_id='chen-an', kind='task')
        self.window.navigate('tasks')
        self.assertNotIn(item, self.window.visible_works)
        self.window.page_widget.findChild(QComboBox, 'workScope').setCurrentText('我派发的')
        application.processEvents()
        self.assertIn(item, self.window.visible_works)
        self.window.page_widget.findChild(QComboBox, 'tasksStatus_' + item['id']).setCurrentText('已完成')
        application.processEvents()
        self.window.set_filter('task_filter', '已完成')
        self.assertEqual(self.window.visible_works, [item])
        card = self.window.page_widget.findChild(WorkCard, 'tasks_' + item['id'])
        card.setFocus()
        QTest.keyClick(card, Qt.Key_Return)
        application.processEvents()
        self.assertTrue(self.window.nav_buttons['tasks'].isChecked())
        self.click('detailBack')
        self.assertEqual(self.window.state.page, 'tasks')
        self.assertEqual(self.window.state.task_filter, '已完成')

    def test_52_integration_import_details_configuration_and_customization(self):
        self.window.navigate('integrations')
        path = self.directory / 'integration.json'
        manifest = dict(name='定制钉钉插件', system='钉钉', version='1.0.0', provider='产品公司',
                        description='企业通知与协作', capabilities=['准备工作通知'], owner='综合管理部')
        path.write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
        with patch.object(QFileDialog, 'getOpenFileName', return_value=(str(path), '')):
            self.click('importIntegration')
        record = self.window.state.integration_plugins[-1]
        self.assertEqual(record['status'], '待配置')
        self.save_dialog({'address': 'not-a-url'})
        self.assertTrue(self.window.dialog.error.isVisible())
        self.assertEqual(record['address'], '')
        self.save_dialog({'address': 'https://office.example.com'})
        self.assertEqual(record['status'], '已配置 · 待联调')
        self.click('customizeIntegration')
        self.save_dialog({'system': '采购系统', 'requirements': '查询采购单并准备到货提醒'})
        self.assertEqual(self.window.state.customization_requests[-1]['system'], '采购系统')
        self.assertIn('未对外发送', self.window.status.text())

    def test_53_invalid_duplicate_large_or_cancelled_plugin_import_has_no_partial_record(self):
        self.window.navigate('integrations')
        count = len(self.window.state.integration_plugins)
        path = self.directory / 'bad.json'
        for content in ['{invalid', '[]', '{"name": "incomplete"}', 'x' * (256 * 1024 + 1)]:
            path.write_text(content, encoding='utf-8')
            with patch.object(QFileDialog, 'getOpenFileName', return_value=(str(path), '')):
                self.window.import_integration_dialog()
            self.assertEqual(len(self.window.state.integration_plugins), count)
            self.assertIsNotNone(self.window.dialog)
            self.window.dialog.reject()
        existing = dict(self.window.state.integration_plugins[0])
        with self.assertRaises(ValueError):
            self.window.state.import_integration(existing)
        with patch.object(QFileDialog, 'getOpenFileName', return_value=('', '')):
            self.window.import_integration_dialog()
        self.assertEqual(len(self.window.state.integration_plugins), count)

    def test_54_tools_skills_search_custom_entry_and_unsent_ai_handoff(self):
        self.window.navigate('plugins')
        self.window.page_widget.findChild(QLineEdit, 'skillSearch').setText('钉钉')
        application.processEvents()
        cards = self.window.page_widget.findChildren(WorkCard)
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0].objectName(), 'skill_dingtalk')
        cards[0].setFocus()
        QTest.keyClick(cards[0], Qt.Key_Return)
        application.processEvents()
        self.click('dialogSave', self.window.dialog)
        self.assertEqual(self.window.state.page, 'chat')
        self.assertIn('钉钉', self.window.state.draft)
        self.assertFalse(self.window.state.busy)
        self.assertEqual(self.window.state.messages, [])
        self.window.navigate('plugins')
        self.click('addSkill')
        self.save_dialog({'name': '合同要点整理', 'instruction': '整理合同条款与待确认事项。'})
        self.assertEqual(self.window.state.skills[-1]['name'], '合同要点整理')
        self.window.skill_dialog(next(skill for skill in self.window.state.skills if skill['id'] == 'oa'))
        self.assertIn('OA', '\n'.join(widget.text() for widget in self.window.dialog.findChildren(QLabel)))

    def test_55_new_forms_fit_small_window(self):
        self.window.resize(1040, 700)
        openers = [self.window.profile_dialog, self.window.create_todo_dialog,
                   lambda: self.window.drive_permissions_dialog('shared-templates'),
                   lambda: self.window.integration_details(self.window.state.integration_plugins[0]),
                   self.window.add_skill_dialog]
        for opener in openers:
            opener()
            application.processEvents()
            d = self.window.dialog
            with self.subTest(dialog=d.windowTitle()):
                self.assertLessEqual(d.height(), 700)
                self.assertTrue(d.findChild(QPushButton, 'dialogSave').isVisible())
                for combo in d.findChildren(QComboBox):
                    self.assertGreaterEqual(combo.height(), combo.fontMetrics().height() + 8)
            d.reject()

    def test_56_wechat_message_window_sends_continuously_and_preserves_line_breaks(self):
        self.window.navigate('messages')
        chat = self.window.contact_message_dialog('chen-an')
        chat.input.setPlainText('第一行')
        chat.input.moveCursor(chat.input.textCursor().End)
        QTest.keyClick(chat.input, Qt.Key_Return, Qt.ShiftModifier)
        chat.input.insertPlainText('<b>第二行</b>')
        self.assertEqual(self.window.state.messages_with('chen-an'), [])
        self.assertEqual(chat.input.toPlainText(), '第一行\n<b>第二行</b>')
        QTest.keyClick(chat.input, Qt.Key_Return)
        application.processEvents()
        self.assertEqual(len(self.window.state.messages_with('chen-an')), 1)
        self.assertTrue(chat.isVisible())
        self.assertEqual(chat.input.toPlainText(), '')
        self.assertFalse(chat.send_button.isEnabled())
        self.assertEqual(self.window.state.contact_draft('chen-an')['text'], '')
        chat.input.setPlainText('继续沟通')
        QTest.keyClick(chat.input, Qt.Key_Return, Qt.ControlModifier)
        application.processEvents()
        self.assertEqual(len(self.window.state.messages_with('chen-an')), 2)
        self.assertTrue(all(widget.textFormat() == Qt.PlainText for widget in chat.history.findChildren(QLabel)))
        bubbles = [frame for frame in chat.history.findChildren(QFrame) if frame.property('kind') == 'contactBubble']
        self.assertEqual(len(bubbles), 2)
        self.assertTrue(all(frame.property('outgoing') for frame in bubbles))
        chat.input.setPlainText('x' * 2001)
        QTest.keyClick(chat.input, Qt.Key_Return)
        self.assertEqual(len(self.window.state.messages_with('chen-an')), 2)
        self.assertTrue(chat.error.isVisible())

    def test_57_peer_drafts_files_and_reused_window_stay_with_their_recipient(self):
        chat = self.window.contact_message_dialog('chen-an')
        chat.input.setPlainText('给陈安的草稿')
        sample = self.directory / '会议材料.pdf'
        sample.write_text('Contents must not be read', encoding='utf-8')
        with patch.object(QFileDialog, 'getOpenFileNames', return_value=([str(sample)], '')):
            with patch.object(Path, 'read_text', side_effect=AssertionError('Must not read file body')):
                self.click('peerChatAttach', chat)
        self.assertEqual(chat.attachments, ['会议材料.pdf'])
        self.assertIs(self.window.contact_message_dialog('xu-ning'), chat)
        self.assertEqual(chat.input.toPlainText(), '')
        self.assertEqual(chat.attachments, [])
        chat.input.setPlainText('给许宁的草稿')
        self.window.contact_message_dialog('chen-an')
        self.assertEqual(chat.input.toPlainText(), '给陈安的草稿')
        self.assertEqual(chat.attachments, ['会议材料.pdf'])
        chat.input.clear()
        self.click('peerChatSend', chat)
        self.assertEqual(self.window.state.messages_with('chen-an')[-1]['attachments'], ['会议材料.pdf'])
        chat.close()
        application.processEvents()
        self.assertIsNone(self.window.contact_chat_window)
        reopened = self.window.contact_message_dialog('xu-ning')
        self.assertEqual(reopened.input.toPlainText(), '给许宁的草稿')
        self.window.switch_account('chen-an')
        self.assertIsNone(self.window.contact_chat_window)
        received = self.window.contact_message_dialog('lin-xiao')
        bubbles = [frame for frame in received.history.findChildren(QFrame) if frame.property('kind') == 'contactBubble']
        self.assertTrue(bubbles)
        self.assertTrue(all(not frame.property('outgoing') for frame in bubbles))

    def test_58_chat_toolbar_actions_preserve_chat_and_target_the_selected_member(self):
        self.window.navigate('messages')
        chat = self.window.contact_message_dialog('chen-an')
        chat.input.setPlainText('讨论中的消息草稿')
        for width, height in [(1040, 700), (760, 520)]:
            chat.resize(width, height)
            application.processEvents()
            for name in ['peerChatToolbar', 'peerChatInput', 'peerChatSend', 'peerChatTask', 'peerChatMeeting', 'peerChatTodo']:
                widget = chat.findChild(QWidget, name)
                self.assertTrue(widget.isVisible(), name)
                corner = widget.mapTo(chat, widget.rect().bottomRight())
                self.assertLess(corner.x(), chat.width(), name)
                self.assertLess(corner.y(), chat.height(), name)
            toolbar = chat.findChild(QWidget, 'peerChatToolbar')
            self.assertLess(toolbar.mapTo(chat, toolbar.rect().bottomLeft()).y(), chat.input.mapTo(chat, chat.input.rect().topLeft()).y())
        self.click('peerChatTask', chat)
        self.assertEqual(self.window.dialog.findChild(QComboBox, 'todoOwner').currentData(), 'chen-an')
        self.save_dialog({'title': '跟进下周客户计划'})
        self.assertTrue(chat.isVisible())
        self.assertEqual(chat.input.toPlainText(), '讨论中的消息草稿')
        self.assertEqual(self.window.state.today_items[-1]['owner_id'], 'chen-an')
        self.click('peerChatMeeting', chat)
        members = self.window.dialog.findChild(QListWidget, 'scheduleMembers')
        self.assertEqual([members.item(index).data(Qt.UserRole) for index in range(members.count())
                          if members.item(index).checkState() == Qt.Checked], ['chen-an'])
        self.window.dialog.reject()
        self.click('peerChatTodo', chat)
        self.save_dialog({'title': '确认会议材料'})
        self.assertEqual(self.window.state.today_items[-1]['kind'], 'todo')
        self.assertEqual(chat.input.toPlainText(), '讨论中的消息草稿')

    def test_59_peer_window_closes_on_account_reset_and_new_account_drafts_are_separate(self):
        chat = self.window.contact_message_dialog('chen-an')
        chat.input.setPlainText('林晓的草稿')
        self.window.switch_account('chen-an')
        self.assertIsNone(self.window.contact_chat_window)
        chat = self.window.contact_message_dialog('lin-xiao')
        self.assertEqual(chat.input.toPlainText(), '')
        chat.input.setPlainText('陈安的草稿')
        self.window.switch_account('lin-xiao')
        chat = self.window.contact_message_dialog('chen-an')
        self.assertEqual(chat.input.toPlainText(), '林晓的草稿')
        self.window.reset_demo()
        self.assertIsNone(self.window.contact_chat_window)
        self.assertEqual(self.window.state.contact_drafts, {})

    def test_60_ai_link_picker_cancel_search_chips_and_remove_keep_draft(self):
        self.window.open_general_chat()
        self.window.composer.setPlainText('帮我处理审批工作')
        self.click('chatLinkIntegration')
        d = self.window.dialog
        listing = d.findChild(QListWidget, 'chatLinkChoices')
        listing.item(0).setCheckState(Qt.Checked)
        d.reject()
        self.assertEqual(self.window.state.linked_integrations, [])
        self.click('chatLinkIntegration')
        d = self.window.dialog
        listing = d.findChild(QListWidget, 'chatLinkChoices')
        listing.item(0).setCheckState(Qt.Checked)
        d.findChild(QLineEdit, 'chatLinkSearch').setText('CRM')
        self.assertEqual(listing.count(), 1)
        listing.item(0).setCheckState(Qt.Checked)
        d.findChild(QLineEdit, 'chatLinkSearch').clear()
        self.assertEqual(listing.item(0).checkState(), Qt.Checked)
        self.save_dialog({})
        self.assertEqual(set(self.window.state.linked_integrations), {'oa', 'crm'})
        self.assertEqual(self.window.state.draft, '帮我处理审批工作')
        self.assertIsNotNone(self.window.page_widget.findChild(QWidget, 'linked_integrations_oa'))
        self.click('chatLinkTool')
        d = self.window.dialog
        listing = d.findChild(QListWidget, 'chatLinkChoices')
        entry = next(listing.item(index) for index in range(listing.count()) if listing.item(index).data(Qt.UserRole) == 'oa')
        entry.setCheckState(Qt.Checked)
        self.save_dialog({})
        self.assertEqual(self.window.state.linked_tools, ['oa'])
        self.assertIsNotNone(self.window.page_widget.findChild(QWidget, 'linked_tools_oa'))
        self.click('unlink_integrations_oa')
        self.assertNotIn('oa', self.window.state.linked_integrations)
        self.assertEqual(self.window.state.skill_link_status(next(skill for skill in self.window.state.skills if skill['id'] == 'oa')), '未关联系统')
        self.assertEqual(self.window.state.messages, [])
        self.assertFalse(self.window.state.busy)

    def test_61_ai_links_are_per_conversation_and_send_preserves_the_original_selection(self):
        self.window.open_general_chat()
        original = self.window.state.conversation_key
        self.window.state.set_chat_links('tools', ['oa', 'documents'])
        self.window.composer.setPlainText('整理审批待办')
        self.window.send_message()
        self.window.stop_execution()
        snapshot = self.window.state.message_links[0]
        self.assertEqual(snapshot['integrations'][0]['id'], 'oa')
        self.window.remove_chat_link('integrations', 'oa')
        self.assertEqual(snapshot['integrations'][0]['status'], '待配置')
        self.assertIn('OA 协同办公', self.window.message_link_text(0))
        self.window.new_task()
        self.assertEqual(self.window.state.linked_tools, [])
        self.assertEqual(self.window.state.message_links, [])
        self.window.open_item_assistance('report')
        self.assertEqual(self.window.state.linked_integrations, [])
        self.window.state.set_chat_links('integrations', ['erp'])
        self.window.select_saved_conversation(original)
        self.assertEqual(self.window.state.linked_tools, ['oa', 'documents'])
        self.assertEqual(self.window.state.message_links[0], snapshot)
        self.window.switch_account('chen-an')
        self.assertEqual(self.window.state.linked_tools, [])
        self.window.switch_account('lin-xiao')
        self.assertEqual(self.window.state.linked_tools, ['oa', 'documents'])

    def test_62_skill_use_links_dependencies_without_replacing_an_open_ai_conversation(self):
        self.window.open_general_chat()
        self.window.composer.setPlainText('原有的讨论')
        self.window.send_message()
        self.window.stop_execution()
        original = self.window.state.conversation_key
        skill = next(skill for skill in self.window.state.skills if skill['id'] == 'oa')
        self.window.skill_dialog(skill)
        self.save_dialog({})
        self.assertEqual(self.window.state.conversation_key, original)
        self.assertEqual(self.window.state.messages, ['原有的讨论'])
        self.assertEqual(self.window.state.linked_integrations, ['oa'])
        self.assertEqual(self.window.state.linked_tools, ['oa'])
        self.assertIn('OA', self.window.state.draft)
        self.assertFalse(self.window.state.busy)
        self.window.resize(1040, 700)
        application.processEvents()
        self.assert_visible_in_window(self.window.page_widget.findChild(QWidget, 'chatLinkIntegration'))
        self.assert_visible_in_window(self.window.page_widget.findChild(QWidget, 'chatLinkTool'))
        self.assert_visible_in_window(self.window.page_widget.findChild(QWidget, 'chatInput'))
        self.assert_visible_in_window(self.window.page_widget.findChild(QWidget, 'sendOrStop'))

    def test_63_home_announcements_scroll_pause_open_detail_and_handle_empty_data(self):
        ticker = self.window.page_widget.findChild(AnnouncementTicker, 'homeAnnouncementTicker')
        self.assertIsNotNone(ticker)
        self.assert_visible_in_window(ticker)
        ticker.timer.stop()
        ticker.hold_ticks = 0
        QApplication.sendEvent(ticker, QEvent(QEvent.Enter))
        ticker.tick()
        self.assertEqual(ticker.offset, 0)
        QApplication.sendEvent(ticker, QEvent(QEvent.Leave))
        ticker.tick()
        self.assertEqual(ticker.offset, 1)
        ticker.advance()
        self.assertEqual(ticker.index, 1)
        QTest.mouseClick(ticker, Qt.LeftButton)
        application.processEvents()
        self.assertEqual(self.window.dialog.windowTitle(), self.window.state.announcements[1]['title'])
        self.assertIn(self.window.state.announcements[1]['content'], '\n'.join(widget.text() for widget in self.window.dialog.findChildren(QLabel)))
        self.window.dialog.reject()
        self.window.state.announcements.clear()
        self.window.render()
        ticker = self.window.page_widget.findChild(AnnouncementTicker, 'homeAnnouncementTicker')
        self.assertFalse(ticker.timer.isActive())
        self.assertIn('暂无公告', ticker.accessibleName())


if __name__ == '__main__':
    unittest.main(verbosity=2)
