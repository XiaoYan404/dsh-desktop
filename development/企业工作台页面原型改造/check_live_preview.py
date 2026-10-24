"""Exercise reloads using disposable source files and supervised child processes."""
import os
from pathlib import Path
import tempfile
import time
import unittest

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
from PyQt5.QtCore import QProcess
from PyQt5.QtNetwork import QLocalServer
from PyQt5.QtTest import QTest
from PyQt5.QtWidgets import QApplication
from preview_live import LivePreview, SOURCE_NAMES, channel_name, notify_running


application = QApplication.instance() or QApplication([])
application.setQuitOnLastWindowClosed(False)


class LivePreviewReview(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='live-preview-check-')
        self.root = Path(self.temporary.name)
        for name in SOURCE_NAMES:
            (self.root / name).write_text('# disposable source\n', encoding='utf-8')
        self.write_app('first')
        self.exits = []
        self.preview = LivePreview(self.root, exit_callback=lambda: self.exits.append(True),
                                   show_errors=False, poll_ms=30, debounce_ms=120)

    def tearDown(self):
        self.preview.shutdown()
        self.assertEqual(self.preview.process.state(), QProcess.NotRunning)
        self.assertFalse(self.preview.poller.isActive())
        self.preview.deleteLater()
        application.processEvents()
        self.temporary.cleanup()

    def write_app(self, text):
        (self.root / 'app.py').write_text(
            f'import time\nprint({text!r}, flush=True)\nwhile True:\n    time.sleep(0.02)\n', encoding='utf-8')

    def until(self, predicate, seconds=7):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            application.processEvents()
            if predicate():
                return
            QTest.qWait(20)
        self.fail(f'Timed out: {self.preview.status}: {self.preview.error}; output={self.preview.output!r}')

    def start(self):
        self.preview.start()
        self.until(lambda: 'first' in self.preview.output)

    def test_save_restarts_once_with_latest_code(self):
        self.start()
        first_pid = self.preview.process.processId()
        self.write_app('second')
        (self.root / 'qt_widgets.py').write_text('# another file in the same save burst\n', encoding='utf-8')
        self.until(lambda: 'second' in self.preview.output and self.preview.launch_count == 2)
        self.assertNotEqual(self.preview.process.processId(), first_pid)
        QTest.qWait(350)
        self.assertEqual(self.preview.launch_count, 2)

    def test_syntax_error_keeps_window_then_recovers(self):
        self.start()
        first_pid = self.preview.process.processId()
        (self.root / 'app.py').write_text('def broken(:\n', encoding='utf-8')
        self.until(lambda: self.preview.status == 'error')
        self.assertIn('SyntaxError', self.preview.error)
        self.assertEqual(self.preview.process.processId(), first_pid)
        self.assertEqual(self.preview.launch_count, 1)
        self.write_app('recovered')
        self.until(lambda: 'recovered' in self.preview.output)
        self.assertEqual(self.preview.launch_count, 2)
        self.assertEqual(self.preview.error, '')

    def test_invalid_startup_recovers_after_save(self):
        (self.root / 'qt_widgets.py').write_text('if\n', encoding='utf-8')
        self.preview.start()
        self.assertEqual(self.preview.status, 'error')
        self.assertEqual(self.preview.launch_count, 0)
        (self.root / 'qt_widgets.py').write_text('# fixed\n', encoding='utf-8')
        self.until(lambda: 'first' in self.preview.output)
        self.assertEqual(self.preview.launch_count, 1)

    def test_logs_preferences_and_atomic_save(self):
        self.start()
        (self.preview.data_dir / 'preferences.json').write_text('{"dark":true}', encoding='utf-8')
        (self.preview.data_dir / 'preview.log').write_text('log update', encoding='utf-8')
        QTest.qWait(350)
        self.assertEqual(self.preview.launch_count, 1)
        replacement = self.root / 'app.py.new'
        replacement.write_text('import time\nprint("atomic",flush=True)\nwhile True: time.sleep(.02)\n', encoding='utf-8')
        os.replace(replacement, self.root / 'app.py')
        self.until(lambda: 'atomic' in self.preview.output)
        self.assertEqual(self.preview.launch_count, 2)

    def test_runtime_failure_is_reported_and_fix_restarts(self):
        (self.root / 'app.py').write_text('raise RuntimeError("demo startup failure")\n', encoding='utf-8')
        self.preview.start()
        self.until(lambda: self.preview.status == 'error')
        self.assertIn('demo startup failure', self.preview.error)
        self.assertTrue(self.preview.poller.isActive())
        self.write_app('fixed runtime')
        self.until(lambda: 'fixed runtime' in self.preview.output)

    def test_existing_supervisor_receives_activation(self):
        name = channel_name('LivePreviewTest-', self.root)
        server = QLocalServer()
        self.assertTrue(server.listen(name))
        received = []

        def activate():
            socket = server.nextPendingConnection()
            received.append(True)
            socket.disconnectFromServer()
            socket.deleteLater()

        server.newConnection.connect(activate)
        try:
            self.assertTrue(notify_running(name))
            self.until(lambda: bool(received), seconds=1)
        finally:
            server.close()

    def test_child_close_ends_supervisor(self):
        (self.root / 'app.py').write_text('print("closed",flush=True)\n', encoding='utf-8')
        self.preview.start()
        self.until(lambda: bool(self.exits))
        self.assertEqual(self.preview.status, 'stopped')
        self.assertEqual(len(self.exits), 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
