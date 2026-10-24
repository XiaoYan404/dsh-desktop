"""A local development supervisor. Restarts only its own preview child."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import tokenize

from PyQt5.QtCore import QObject, QProcess, QProcessEnvironment, QTimer
from PyQt5.QtGui import QFont
from PyQt5.QtNetwork import QLocalServer, QLocalSocket
from PyQt5.QtWidgets import QApplication, QDialog, QVBoxLayout, QLabel, QTextEdit, QPushButton


ROOT = Path(__file__).resolve().parent
SOURCE_NAMES = ('app.py', 'workbench_ui.py', 'prototype_model.py', 'qt_widgets.py')


def channel_name(prefix, directory):
    return prefix + hashlib.sha256(str(Path(directory).resolve()).encode()).hexdigest()[:18]


def notify_running(name):
    socket = QLocalSocket()
    socket.connectToServer(name)
    if not socket.waitForConnected(200):
        return False
    socket.write(b'activate')
    socket.waitForBytesWritten(200)
    socket.disconnectFromServer()
    return True


class PreviewError(QDialog):
    def __init__(self, retry, stop):
        super().__init__()
        self.stop = stop
        self.setWindowTitle('实时预览 · 开发提示')
        self.resize(660, 360)
        layout = QVBoxLayout(self)
        message = QLabel('代码暂时无法载入。修改并保存后会自动重试；语法错误不会关闭仍在运行的预览。')
        message.setWordWrap(True)
        layout.addWidget(message)
        self.details = QTextEdit()
        self.details.setReadOnly(True)
        layout.addWidget(self.details)
        retry_button = QPushButton('重新检查')
        retry_button.clicked.connect(retry)
        layout.addWidget(retry_button)
        stop_button = QPushButton('结束实时预览')
        stop_button.clicked.connect(stop)
        layout.addWidget(stop_button)

    def closeEvent(self, event):
        self.stop()
        event.accept()


class LivePreview(QObject):
    def __init__(self, root=ROOT, data_dir=None, exit_callback=None, show_errors=True,
                 poll_ms=250, debounce_ms=650):
        super().__init__()
        self.root = Path(root).resolve()
        self.data_dir = Path(data_dir or self.root / '.preview-data' / 'live').resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.exit_callback = exit_callback or QApplication.instance().quit
        self.show_errors = show_errors
        self.debounce_ms = debounce_ms
        self.process = QProcess(self)
        self.process.setWorkingDirectory(str(self.root))
        environment = QProcessEnvironment.systemEnvironment()
        environment.insert('PYTHONIOENCODING', 'utf-8')
        self.process.setProcessEnvironment(environment)
        self.process.setProcessChannelMode(QProcess.MergedChannels)
        self.process.readyReadStandardOutput.connect(self.read_output)
        self.process.started.connect(self.started)
        self.process.finished.connect(self.finished)
        self.process.errorOccurred.connect(self.process_error)
        self.output = ''
        self.status = 'starting'
        self.error = ''
        self.launch_count = 0
        self.restarting = False
        self.stopping = False
        self.error_dialog = None
        self.signature = self.fingerprint()
        self.changed_at = None
        self.poller = QTimer(self)
        self.poller.setInterval(poll_ms)
        self.poller.timeout.connect(self.poll)
        self.kill_timer = QTimer(self)
        self.kill_timer.setSingleShot(True)
        self.kill_pid = 0
        self.kill_timer.timeout.connect(lambda: self.kill_if_owned(self.kill_pid))

    def fingerprint(self):
        values = []
        for name in SOURCE_NAMES:
            try:
                stat = (self.root / name).stat()
                values.append((name, stat.st_mtime_ns, stat.st_size))
            except OSError:
                values.append((name, None, None))
        return tuple(values)

    def validate_sources(self):
        for name in SOURCE_NAMES:
            path = self.root / name
            with tokenize.open(str(path)) as source:
                compile(source.read(), str(path), 'exec')

    def start(self):
        self.poller.start()
        self.reload()

    def poll(self):
        signature = self.fingerprint()
        now = time.monotonic()
        if signature != self.signature:
            self.signature = signature
            self.changed_at = now
        if self.changed_at is not None and (now - self.changed_at) * 1000 >= self.debounce_ms:
            self.changed_at = None
            self.reload()

    def publish_status(self):
        data = dict(watcher_pid=os.getpid(), child_pid=int(self.process.processId()),
                    launch_count=self.launch_count, status=self.status, error=self.error)
        try:
            path = self.data_dir / 'live-status.json'
            temporary = path.with_suffix('.tmp')
            temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
            os.replace(temporary, path)
        except OSError:
            pass

    def report_error(self, message):
        self.status = 'error'
        self.error = message
        self.publish_status()
        if self.show_errors:
            if self.error_dialog is None:
                self.error_dialog = PreviewError(self.reload, self.shutdown)
            self.error_dialog.details.setPlainText(message)
            self.error_dialog.show()
            self.error_dialog.raise_()

    def reload(self):
        if self.stopping:
            return
        try:
            self.validate_sources()
        except (OSError, SyntaxError, UnicodeError) as error:
            self.report_error(f'{type(error).__name__}: {error}')
            return
        self.error = ''
        if self.error_dialog:
            self.error_dialog.hide()
        if self.process.state() != QProcess.NotRunning:
            self.restarting = True
            self.status = 'restarting'
            old_pid = self.process.processId()
            self.publish_status()
            self.kill_pid = old_pid
            self.kill_timer.start(1800)
            self.process.terminate()
        else:
            self.launch()

    def kill_if_owned(self, pid):
        if pid and self.process.processId() == pid and self.process.state() != QProcess.NotRunning:
            self.process.kill()

    def launch(self):
        if self.stopping:
            return
        self.restarting = False
        self.output = ''
        self.status = 'starting'
        self.process.start(sys.executable, [str(self.root / 'app.py'), '--data-dir',
                                          str(self.data_dir), '--live-preview'])

    def started(self):
        self.launch_count += 1
        self.status = 'running'
        self.publish_status()

    def read_output(self):
        text = bytes(self.process.readAllStandardOutput()).decode('utf-8', errors='replace')
        self.output = (self.output + text)[-12000:]
        if text:
            try:
                with (self.data_dir / 'live-preview.log').open('a', encoding='utf-8') as log:
                    log.write(text)
            except OSError:
                pass

    def process_error(self, error):
        if error == QProcess.FailedToStart and not self.stopping:
            self.report_error('无法启动预览：' + self.process.errorString())

    def finished(self, exit_code, exit_status):
        self.kill_timer.stop()
        self.read_output()
        if self.stopping:
            return
        if self.restarting:
            # Validate again in case another save happened while the child closed.
            self.reload()
        elif exit_code == 0 and exit_status == QProcess.NormalExit:
            self.shutdown()
        else:
            self.report_error(self.output or f'预览进程退出，退出码 {exit_code}。修改代码后会自动重试。')

    def activate(self):
        if self.error_dialog and self.error_dialog.isVisible():
            self.error_dialog.raise_()
            self.error_dialog.activateWindow()
        else:
            notify_running(channel_name('EnterprisePrototype-', self.data_dir))

    def shutdown(self):
        if self.stopping:
            return
        self.stopping = True
        self.poller.stop()
        self.kill_timer.stop()
        if self.process.state() != QProcess.NotRunning:
            self.process.terminate()
            if not self.process.waitForFinished(1500):
                self.process.kill()
                self.process.waitForFinished(1500)
        self.status = 'stopped'
        self.publish_status()
        if self.error_dialog:
            self.error_dialog.hide()
        self.exit_callback()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, default=ROOT / '.preview-data' / 'live')
    args = parser.parse_args()
    application = QApplication(sys.argv[:1])
    application.setFont(QFont('Microsoft YaHei UI', 10))
    application.setQuitOnLastWindowClosed(False)
    name = channel_name('EnterprisePrototypeLive-', args.data_dir)
    if notify_running(name):
        return 0
    server = QLocalServer()
    QLocalServer.removeServer(name)
    if not server.listen(name):
        raise RuntimeError('无法建立实时预览激活通道')
    preview = LivePreview(data_dir=args.data_dir)

    def activate():
        connection = server.nextPendingConnection()
        if connection:
            connection.disconnectFromServer()
            connection.deleteLater()
        preview.activate()

    server.newConnection.connect(activate)
    application.aboutToQuit.connect(preview.shutdown)
    preview.start()
    result = application.exec_()
    server.close()
    return result


if __name__ == '__main__':
    sys.exit(main())
