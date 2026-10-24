"""Native Qt components for a calm, document-focused desktop workspace."""
from PyQt5.QtCore import Qt, QSize, QPointF, QRectF, QTimer, pyqtSignal
from PyQt5.QtGui import QColor, QPainter, QPen, QFont, QPainterPath, QPixmap, QIcon
from PyQt5.QtWidgets import (QWidget, QLabel, QPushButton, QFrame, QVBoxLayout,
                             QHBoxLayout, QDialog, QLineEdit, QTextEdit, QComboBox, QSizePolicy)


def label(text='', kind='', wrap=True):
    w = QLabel(str(text))
    w.setTextFormat(Qt.PlainText)
    w.setWordWrap(wrap)
    if kind:
        w.setProperty('kind', kind)
    if kind in ('tag', 'chip', 'avatar', 'railBrand', 'contactAvatar'):
        w.setSizePolicy(QSizePolicy.Maximum, QSizePolicy.Fixed)
        w.setAlignment(Qt.AlignCenter)
    w.setTextInteractionFlags(Qt.TextSelectableByMouse)
    return w


def button(text, callback, kind='secondary', name=''):
    w = QPushButton(text)
    w.setProperty('kind', kind)
    w.setCursor(Qt.PointingHandCursor)
    w.setMinimumHeight(34)
    w.setAutoDefault(False)
    w.setDefault(False)
    w.setAccessibleName(text)
    if name:
        w.setObjectName(name)
    w.clicked.connect(lambda checked=False: callback())
    return w


def box(kind='card', margin=20, spacing=12):
    w = QFrame()
    w.setProperty('kind', kind)
    w.setAttribute(Qt.WA_StyledBackground, True)
    if kind in ('workCard', 'featuredWork', 'toolCard', 'artifact'):
        w.setAttribute(Qt.WA_Hover, True)
    layout = QVBoxLayout(w)
    layout.setContentsMargins(margin, margin, margin, margin)
    layout.setSpacing(spacing)
    return w, layout


def row(*widgets, stretch=False):
    w = QWidget()
    layout = QHBoxLayout(w)
    layout.setContentsMargins(0, 0, 0, 0)
    layout.setSpacing(10)
    for child in widgets:
        if child is None:
            layout.addStretch()
        elif isinstance(child, (QLabel, QPushButton)):
            layout.addWidget(child, 0, Qt.AlignVCenter)
        else:
            layout.addWidget(child)
    if stretch:
        layout.addStretch()
    return w


def _draw_icon(painter, name):
    """Draw consistent native line icons in a 24 by 24 coordinate system."""
    aliases = {
        'workbench': 'home', 'workspace': 'home', 'dashboard': 'home',
        'message': 'chat', 'conversation': 'chat', 'assistant': 'chat',
        'documents': 'files', 'document': 'doc', 'file': 'doc',
        'tools': 'apps', 'tool': 'apps', 'grid': 'apps', 'skills': 'sparkles',
        'ai': 'sparkles', 'sparkle': 'sparkles', 'attachment': 'paperclip',
        'attach': 'paperclip', 'chevronRight': 'chevron', 'arrowRight': 'arrow',
        'arrow-right': 'arrow', 'history': 'clock', 'recent': 'clock',
        'knowledge': 'book', 'library': 'book', 'members': 'team',
        'users': 'team', 'integrations': 'plug', 'connection': 'plug',
        'more': 'dots', 'external': 'arrow', 'add': 'plus', 'close': 'x',
        'theme': 'moon', 'help': 'question', 'chevronDown': 'down',
    }
    name = aliases.get(name, name)

    def line(x1, y1, x2, y2):
        painter.drawLine(QPointF(x1, y1), QPointF(x2, y2))

    def path(points, close=False):
        curve = QPainterPath(QPointF(*points[0]))
        for point in points[1:]:
            curve.lineTo(QPointF(*point))
        if close:
            curve.closeSubpath()
        painter.drawPath(curve)

    def rect(x, y, width, height, radius=2):
        painter.drawRoundedRect(QRectF(x, y, width, height), radius, radius)

    if name == 'home':
        rect(3.5, 3.5, 17, 17, 3)
        line(9, 4, 9, 20)
        line(9, 10, 20, 10)
    elif name == 'calendar':
        rect(3, 5, 18, 16, 3)
        line(3, 10, 21, 10)
        line(7, 3, 7, 7)
        line(17, 3, 17, 7)
        line(7, 14, 10, 14)
        line(14, 14, 17, 14)
        line(7, 17, 10, 17)
    elif name == 'chat':
        path([(5, 4), (19, 4), (21, 6), (21, 15), (19, 17), (10, 17), (5, 21), (5, 17), (3, 15), (3, 6)], True)
        line(7, 9, 17, 9)
        line(7, 13, 13, 13)
    elif name in ('files', 'folder'):
        path([(3, 7), (3, 5), (10, 5), (12, 7), (21, 7), (21, 19), (3, 19)], True)
        line(3, 10, 21, 10)
    elif name == 'apps':
        for x, y in ((4, 4), (14, 4), (4, 14), (14, 14)):
            rect(x, y, 6, 6, 1.5)
    elif name == 'settings':
        painter.drawEllipse(QRectF(8, 8, 8, 8))
        painter.drawEllipse(QRectF(4, 4, 16, 16))
        for a, b, c, d in ((12, 2, 12, 4), (12, 20, 12, 22), (2, 12, 4, 12), (20, 12, 22, 12), (4.5, 4.5, 6, 6), (18, 18, 19.5, 19.5), (4.5, 19.5, 6, 18), (18, 6, 19.5, 4.5)):
            line(a, b, c, d)
    elif name == 'search':
        painter.drawEllipse(QRectF(4, 3.5, 12, 12))
        line(14, 14, 20.5, 20.5)
    elif name == 'plus':
        line(12, 5, 12, 19)
        line(5, 12, 19, 12)
    elif name == 'x':
        line(6, 6, 18, 18)
        line(18, 6, 6, 18)
    elif name == 'arrow':
        line(4, 12, 20, 12)
        path([(14, 6), (20, 12), (14, 18)])
    elif name == 'send':
        line(12, 20, 12, 4)
        path([(5, 11), (12, 4), (19, 11)])
    elif name == 'chevron':
        path([(9, 5), (16, 12), (9, 19)])
    elif name == 'down':
        path([(6, 9), (12, 15), (18, 9)])
    elif name == 'doc':
        path([(5, 3), (14, 3), (19, 8), (19, 21), (5, 21)], True)
        path([(14, 3), (14, 8), (19, 8)])
        line(8, 12, 16, 12)
        line(8, 16, 14, 16)
    elif name == 'sparkles':
        path([(10, 3), (12.5, 9.5), (19, 12), (12.5, 14.5), (10, 21), (7.5, 14.5), (1, 12), (7.5, 9.5)], True)
        line(19, 2, 19, 6)
        line(17, 4, 21, 4)
        line(20, 17, 20, 21)
        line(18, 19, 22, 19)
    elif name == 'clock':
        painter.drawEllipse(QRectF(3, 3, 18, 18))
        path([(12, 6), (12, 12), (16, 14)])
    elif name == 'check':
        path([(5, 12), (10, 17), (19, 7)])
    elif name == 'panel':
        rect(3, 4, 18, 16)
        line(15, 4, 15, 20)
        line(18, 8, 18, 16)
    elif name == 'paperclip':
        curve = QPainterPath(QPointF(9, 8))
        curve.lineTo(15, 2)
        curve.cubicTo(20, -2, 24, 5, 20, 9)
        curve.lineTo(10, 19)
        curve.cubicTo(4, 25, -2, 18, 3, 13)
        curve.lineTo(13, 3)
        curve.cubicTo(16, 0, 20, 4, 17, 7)
        curve.lineTo(8, 16)
        painter.save()
        painter.translate(1, 1)
        painter.scale(.85, .85)
        painter.drawPath(curve)
        painter.restore()
    elif name == 'team':
        painter.drawEllipse(QRectF(5, 4, 6, 6))
        painter.drawEllipse(QRectF(15, 5, 5, 5))
        curve = QPainterPath(QPointF(2, 20))
        curve.cubicTo(2, 10, 14, 10, 14, 20)
        painter.drawPath(curve)
        curve = QPainterPath(QPointF(15, 13))
        curve.cubicTo(20, 11, 22, 15, 22, 20)
        painter.drawPath(curve)
    elif name == 'globe':
        painter.drawEllipse(QRectF(3, 3, 18, 18))
        painter.drawEllipse(QRectF(8, 3, 8, 18))
        line(3, 12, 21, 12)
    elif name == 'download':
        path([(7, 10), (12, 15), (17, 10)])
        line(12, 3, 12, 15)
        path([(4, 16), (4, 21), (20, 21), (20, 16)])
    elif name == 'play':
        path([(8, 4), (20, 12), (8, 20)], True)
    elif name == 'book':
        path([(12, 6), (6, 4), (3, 4), (3, 19), (6, 19), (12, 21), (18, 19), (21, 19), (21, 4), (18, 4)], True)
        line(12, 6, 12, 21)
    elif name == 'plug':
        path([(7, 7), (17, 7), (17, 12), (15, 15), (9, 15), (7, 12)], True)
        line(9, 3, 9, 7)
        line(15, 3, 15, 7)
        path([(12, 15), (12, 19), (9, 22)])
    elif name == 'moon':
        curve = QPainterPath(QPointF(17, 3))
        curve.cubicTo(3, -1, 0, 19, 12, 21)
        curve.cubicTo(17, 22, 21, 18, 21, 14)
        curve.cubicTo(12, 17, 8, 8, 17, 3)
        painter.drawPath(curve)
    elif name == 'question':
        painter.drawEllipse(QRectF(3, 3, 18, 18))
        curve = QPainterPath(QPointF(9, 8))
        curve.cubicTo(10, 5, 16, 6, 15, 10)
        curve.cubicTo(15, 12, 12, 12, 12, 14)
        painter.drawPath(curve)
        line(12, 17, 12, 17.2)
    elif name == 'dots':
        for x in (5, 12, 19):
            painter.drawEllipse(QRectF(x - .8, 11.2, 1.6, 1.6))
    else:
        rect(4, 4, 16, 16, 4)
        line(8, 12, 16, 12)


def icon(name, color=None, size=20):
    """Return a crisp native icon, including selected and disabled states."""
    result = QIcon()
    colors = ((QIcon.Normal, color or '#727671'),
              (QIcon.Active, color or '#28736B'),
              (QIcon.Selected, color or '#28736B'),
              (QIcon.Disabled, '#A8AAA5'))
    for mode, tint in colors:
        pixmap = QPixmap(size * 2, size * 2)
        pixmap.setDevicePixelRatio(2)
        pixmap.fill(Qt.transparent)
        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.Antialiasing)
        painter.scale(size / 24, size / 24)
        painter.setPen(QPen(QColor(tint), 1.65, Qt.SolidLine, Qt.RoundCap, Qt.RoundJoin))
        painter.setBrush(Qt.NoBrush)
        _draw_icon(painter, name)
        painter.end()
        result.addPixmap(pixmap, mode, QIcon.Off)
        result.addPixmap(pixmap, mode, QIcon.On)
    return result


class FileTile(QWidget):
    """Paint a small editable-document cover without a bitmap dependency."""
    def __init__(self, kind='DOCX', dark=False):
        super().__init__()
        self.kind = str(kind).upper()
        self.dark = dark
        self.setMinimumSize(100, 90)
        self.setMaximumHeight(110)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.setAccessibleName(self.kind + ' 文档封面')

    def sizeHint(self):
        return QSize(140, 104)

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        colors = {'DOCX': ('#EDF1F4', '#658CA0'),
                  'PPTX': ('#F4EDE8', '#B1876C'),
                  'XLSX': ('#EAF0E9', '#71917B'),
                  'PDF': ('#F3ECEA', '#B57970')}
        background, accent = colors.get(self.kind, ('#EFEEEA', '#888B81'))
        p.setPen(Qt.NoPen)
        p.setBrush(QColor('#303431' if self.dark else background))
        p.drawRoundedRect(QRectF(0, 0, self.width(), self.height()), 9, 9)
        p.translate(self.width() / 2, self.height() / 2)
        p.rotate(-6 if self.kind == 'DOCX' else 4 if self.kind == 'PPTX' else -3)
        p.setBrush(QColor(0, 0, 0, 14 if not self.dark else 35))
        p.drawRoundedRect(QRectF(-26, -35, 57, 76), 3, 3)
        p.setBrush(QColor('#F7F7F3' if self.dark else '#FFFFFF'))
        p.drawRoundedRect(QRectF(-28, -38, 57, 76), 3, 3)
        p.setBrush(QColor(accent))
        p.drawRoundedRect(QRectF(-20, -29, 23, 5), 1.5, 1.5)
        p.setPen(QColor('#4D5B60'))
        font = QFont('Segoe UI')
        font.setPixelSize(5)
        font.setWeight(QFont.DemiBold)
        p.setFont(font)
        p.drawText(QRectF(-20, -17, 44, 8), Qt.AlignLeft, 'WORK / ' + self.kind)
        p.setPen(Qt.NoPen)
        if self.kind == 'PPTX':
            p.setBrush(QColor(background))
            p.drawRoundedRect(QRectF(-20, -5, 41, 25), 2, 2)
            for x, h in ((-12, 8), (-2, 15), (8, 11)):
                p.setBrush(QColor(accent))
                p.drawRoundedRect(QRectF(x, 15 - h, 6, h), 1, 1)
        elif self.kind == 'XLSX':
            p.setBrush(QColor(background))
            p.drawRect(QRectF(-20, -5, 41, 27))
            p.setPen(QPen(QColor('#CBD7CD'), .7))
            for x in (-7, 7):
                p.drawLine(QPointF(x, -5), QPointF(x, 22))
            for y in (2, 9, 16):
                p.drawLine(QPointF(-20, y), QPointF(21, y))
            p.setPen(Qt.NoPen)
        else:
            p.setBrush(QColor('#E7EBE9'))
            for y, width in ((-3, 40), (4, 40), (11, 32), (23, 40), (30, 25)):
                p.drawRoundedRect(QRectF(-20, y, width, 2), 1, 1)
        p.end()


class HeroArt(FileTile):
    """Keep the earlier decorative component available to existing pages."""
    def __init__(self, dark=False):
        super().__init__('DOCX', dark)
        self.setFixedSize(170, 140)
        self.setMaximumHeight(140)


class FormDialog(QDialog):
    def __init__(self, parent, title, description=''):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.setWindowModality(Qt.ApplicationModal)
        self.setMinimumWidth(500)
        self.setMaximumWidth(720)
        self.setAttribute(Qt.WA_DeleteOnClose, True)
        self.setObjectName('prototypeDialog')
        self.layout = QVBoxLayout(self)
        self.layout.setContentsMargins(28, 26, 28, 26)
        self.layout.setSpacing(15)
        self.layout.addWidget(label(title, 'section'))
        if description:
            self.layout.addWidget(label(description, 'muted'))
        self.fields = {}
        self.error = label('', 'error')
        self.error.setObjectName('formError')
        self.error.hide()
        self.actions = QHBoxLayout()
        self.actions.addStretch()
        self.finished.connect(parent.dialog_closed)

    def field(self, key, title, value='', multiline=False, options=None, limit=None):
        name = label(title, 'field')
        if options is not None:
            widget = QComboBox()
            widget.addItems(options)
            if value in options:
                widget.setCurrentText(value)
        elif multiline:
            widget = QTextEdit()
            widget.setAcceptRichText(False)
            widget.setPlainText(value)
            widget.setFixedHeight(100)
        else:
            widget = QLineEdit(value)
            widget.setMaxLength(limit or 160)
        widget.setObjectName(key)
        widget.setAccessibleName(title)
        name.setBuddy(widget)
        self.fields[key] = widget
        self.layout.addWidget(name)
        self.layout.addWidget(widget)
        return widget

    def value(self, key):
        w = self.fields[key]
        if isinstance(w, QComboBox):
            return w.currentText()
        return w.toPlainText().strip() if isinstance(w, QTextEdit) else w.text().strip()

    def fail(self, message):
        self.error.setText(str(message))
        self.error.show()

    def finish(self, save=None, text='保存演示配置'):
        self.layout.addWidget(self.error)
        self.actions.addWidget(button('关闭' if save is None else '取消', self.reject, name='dialogCancel'))
        if save:
            self.actions.addWidget(button(text, save, 'primary', 'dialogSave'))
        self.layout.addLayout(self.actions)
        self.show()
        if self.fields:
            next(iter(self.fields.values())).setFocus()
        return self


class ChatMessageInput(QTextEdit):
    sendRequested = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.preedit_active = False
        self.setAcceptRichText(False)

    def inputMethodEvent(self, event):
        self.preedit_active = bool(event.preeditString())
        super().inputMethodEvent(event)

    def keyPressEvent(self, event):
        if event.key() in (Qt.Key_Return, Qt.Key_Enter) and not event.modifiers() & Qt.ShiftModifier and not self.preedit_active:
            self.sendRequested.emit()
            event.accept()
        else:
            super().keyPressEvent(event)


class AnnouncementTicker(QWidget):
    activated = pyqtSignal(int)

    def __init__(self, announcements, parent=None):
        super().__init__(parent)
        self.announcements = list(announcements)
        self.index = 0
        self.offset = 0
        self.hold_ticks = 45
        self.paused = False
        self.setObjectName('homeAnnouncementTicker')
        self.setMinimumWidth(40)
        self.setFixedHeight(28)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setCursor(Qt.PointingHandCursor)
        self.timer = QTimer(self)
        self.timer.setInterval(30)
        self.timer.timeout.connect(self.tick)
        self.update_description()
        if self.announcements:
            self.timer.start()

    def text_at(self, index):
        record = self.announcements[index % len(self.announcements)]
        return record['title'] + '：' + record['content']

    def stride(self):
        return max(self.width() + 24, self.fontMetrics().horizontalAdvance(self.text_at(self.index)) + 42)

    def update_description(self):
        description = self.text_at(self.index) if self.announcements else '暂无公告'
        self.setToolTip(description + ('\n点击查看完整公告 · 悬停暂停滚动' if self.announcements else ''))
        self.setAccessibleName('公司公告：' + description)

    def advance(self):
        if self.announcements:
            self.index = (self.index + 1) % len(self.announcements)
        self.offset = 0
        self.hold_ticks = 45
        self.update_description()
        self.update()

    def tick(self):
        if self.paused or not self.isVisible() or not self.announcements:
            return
        if len(self.announcements) == 1 and self.fontMetrics().horizontalAdvance(self.text_at(0)) <= self.width():
            return
        if self.hold_ticks:
            self.hold_ticks -= 1
            return
        self.offset += 1
        if self.offset >= self.stride():
            self.advance()
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setClipRect(self.rect())
        painter.setPen(self.palette().color(self.foregroundRole()))
        if not self.announcements:
            painter.drawText(self.rect(), Qt.AlignVCenter | Qt.AlignLeft, '暂无公告')
            return
        baseline = (self.height() + self.fontMetrics().ascent() - self.fontMetrics().descent()) / 2
        painter.drawText(QPointF(-self.offset, baseline), self.text_at(self.index))
        painter.drawText(QPointF(self.stride() - self.offset, baseline), self.text_at(self.index + 1))

    def enterEvent(self, event):
        self.paused = True
        super().enterEvent(event)

    def leaveEvent(self, event):
        self.paused = False
        super().leaveEvent(event)

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.LeftButton and self.announcements:
            index = self.index + (event.pos().x() + self.offset >= self.stride())
            self.activated.emit(index % len(self.announcements))
        super().mouseReleaseEvent(event)

    def keyPressEvent(self, event):
        if event.key() in (Qt.Key_Return, Qt.Key_Enter, Qt.Key_Space) and self.announcements:
            self.activated.emit(self.index)
            event.accept()
        else:
            super().keyPressEvent(event)


def stylesheet(dark=False, compact=False):
    c = dict(bg='#242625', surface='#2D302E', side='#292C29', rail='#202321',
             ink='#EEEFEA', muted='#A1A79F', subtle='#7D867E', line='#414741',
             green='#90BFB5', primary='#377F74', soft='#35413B', hero='#303A34',
             input='#292D2A', inset='#292D2A', featured='#333B35', focus='#688F83') if dark else dict(
        bg='#F6F5F1', surface='#FFFFFF', side='#EFEEEA', rail='#E7E8E2',
        ink='#282D29', muted='#7A8178', subtle='#9A9F96', line='#E3E5DE',
        green='#28736B', primary='#28736B', soft='#E3ECE6', hero='#EEF1EA',
        input='#FBFBF8', inset='#F7F8F4', featured='#F0F3EC', focus='#C0D3C8')
    padding = 6 if compact else 9
    return f'''
    QWidget {{font-family:"Microsoft YaHei UI","Segoe UI";font-size:13px;color:{c['ink']};background:transparent;}}
    QMainWindow, QWidget#shell, QWidget#page, QWidget#pageScrollContent, QWidget#workCanvas {{background:{c['bg']};}}
    QWidget#sidebar, QWidget#workspaceSidebar {{background:{c['side']};border-right:1px solid {c['line']};}}
    QWidget#appRail {{background:{c['rail']};border-right:1px solid {c['line']};}}
    QWidget#topbar, QWidget#workTopbar {{background:{c['bg']};border-bottom:1px solid {c['line']};}}
    QDialog {{background:{c['surface']};}}
    QDialog#contactChatWindow, QWidget#peerChatHistoryBody {{background:{c['inset'] if dark else '#F2F2F2'};}}
    QFrame#contactChatSidebar {{background:{c['side']};border-right:1px solid {c['line']};}}
    QFrame#peerChatHeader {{background:{c['bg']};border-bottom:1px solid {c['line']};}}
    QFrame#peerChatComposer {{background:{c['surface']};border-top:1px solid {c['line']};}}
    QLabel {{background:transparent;border:none;}}
    QLabel[kind="display"] {{font-size:36px;font-weight:600;color:{c['ink']};}}
    QLabel[kind="title"] {{font-size:28px;font-weight:600;}}
    QLabel[kind="section"] {{font-size:18px;font-weight:600;}}
    QLabel[kind="workTitle"] {{font-size:16px;font-weight:600;}}
    QLabel[kind="cardTitle"] {{font-size:14px;font-weight:600;}}
    QLabel[kind="timelineTime"] {{font-size:13px;font-weight:600;color:{c['muted']};}}
    QLabel[kind="timelineDot"] {{color:{c['green']};font-size:11px;}}
    QLabel[kind="itemBadge"] {{background:{c['soft']};color:{c['green']};font-size:14px;border-radius:10px;}}
    QLabel[kind="itemBadge"][itemKind="schedule"] {{background:{'#353A46' if dark else '#ECEFF6'};color:{'#B0BCD7' if dark else '#7383A5'};}}
    QLabel[kind="itemBadge"][itemKind="system"] {{background:{'#423A2D' if dark else '#F6F0E4'};color:{'#D4B88A' if dark else '#A18450'};}}
    QLabel[kind="body"] {{font-size:13px;color:{c['muted']};}}
    QLabel[kind="muted"], QLabel[kind="eyebrow"] {{color:{c['muted']};}}
    QLabel[kind="heroHint"] {{font-size:14px;color:{c['muted']};}}
    QLabel[kind="caption"] {{font-size:11px;color:{c['muted']};}}
    QLabel[kind="overline"], QLabel[kind="eyebrow"] {{font-size:11px;color:{c['muted']};}}
    QLabel[kind="field"] {{font-size:12px;font-weight:600;}}
    QLabel[kind="tag"], QLabel[kind="chip"] {{font-size:10px;color:{c['green']};background:{c['soft']};border-radius:4px;padding:3px 6px;}}
    QLabel[kind="statusDot"] {{color:{c['green']};font-size:11px;}}
    QLabel[kind="avatar"] {{font-size:11px;font-weight:600;color:{c['green']};background:{c['soft']};border-radius:15px;min-width:30px;min-height:30px;}}
    QLabel[kind="contactAvatar"] {{font-size:16px;font-weight:600;color:{c['green']};background:{c['soft']};border-radius:7px;}}
    QLabel[kind="chatError"] {{color:{'#E4AA97' if dark else '#A65C44'};font-size:12px;}}
    QPushButton[kind="avatarButton"] {{font-size:16px;font-weight:600;color:{c['green']};background:{c['soft']};border:1px solid {c['line']};border-radius:18px;padding:0;}}
    QPushButton[kind="avatarButton"]:hover {{border-color:{c['green']};background:{c['hero']};}}
    QWidget#loginProfile {{border-left:1px solid {c['line']};}}
    QLabel[kind="railBrand"], QLabel[kind="brandMark"] {{font-size:22px;font-weight:600;color:#FFFFFF;background:{c['primary']};border-radius:11px;min-width:38px;min-height:38px;}}
    QLabel[kind="error"] {{color:{'#E4AA97' if dark else '#A65C44'};padding:9px;background:{'#40352E' if dark else '#FBF0E9'};border-radius:7px;}}
    QLabel[kind="logo"] {{font-size:24px;background:{c['primary']};color:white;border-radius:11px;padding:7px;}}
    QLabel[kind="notice"] {{color:{c['muted']};background:{c['inset']};padding:13px;border-radius:9px;}}
    QLabel[kind="metric"] {{font-size:28px;font-weight:600;}}
    QFrame {{border:none;}}
    QFrame[kind="card"], QFrame[kind="workCard"] {{background:{c['surface']};border:1px solid {c['line']};border-radius:12px;}}
    QFrame[kind="contactBubble"] {{background:{c['surface']};border:1px solid {c['line']};border-radius:7px;}}
    QFrame[kind="contactBubble"][outgoing="true"] {{background:{'#36533D' if dark else '#A9E67A'};border-color:{'#496A50' if dark else '#9ADA6E'};}}
    QFrame[kind="association"] {{background:{c['soft']};border:1px solid {c['focus']};border-radius:6px;}}
    QFrame[kind="workCard"]:hover {{border-color:{c['focus']};}}
    QFrame[kind="workCard"]:focus {{border-color:{c['green']};}}
    QFrame[kind="featuredWork"] {{background:{c['featured']};border:1px solid {c['focus']};border-radius:12px;}}
    QFrame[kind="composer"] {{background:{c['surface']};border:1px solid {c['focus']};border-radius:16px;}}
    QFrame[kind="toolCard"] {{background:{c['surface']};border:1px solid {c['line']};border-radius:11px;}}
    QFrame[kind="toolCard"]:hover {{background:{c['inset']};border-color:{c['focus']};}}
    QFrame[kind="tray"] {{background:{c['inset']};border:1px solid {c['line']};border-radius:12px;}}
    QFrame[kind="inset"] {{background:{c['inset']};border:0;border-radius:9px;}}
    QFrame[kind="artifact"] {{background:{c['surface']};border:1px solid {c['line']};border-radius:9px;}}
    QFrame[kind="divider"] {{background:{c['line']};min-height:1px;max-height:1px;border:0;}}
    QFrame[kind="brandMark"] {{background:{c['primary']};border-radius:11px;}}
    QFrame[kind="hero"] {{background:{c['hero']};border:1px solid {c['line']};border-radius:12px;}}
    QFrame[kind="approval"] {{background:{'#3B352B' if dark else '#FCF8EF'};border:1px solid {'#63553E' if dark else '#E8DCC5'};border-radius:10px;}}
    QPushButton {{background:{c['surface']};border:1px solid {c['line']};border-radius:7px;padding:{padding}px 12px;font-size:12px;}}
    QPushButton:hover {{background:{c['inset']};border-color:{c['focus']};}}
    QPushButton:focus {{border-color:{c['green']};}}
    QPushButton[kind="calendarDay"] {{background:{c['surface']};font-size:12px;}}
    QPushButton[kind="calendarDay"]:checked {{background:{c['soft']};color:{c['green']};border-color:{c['focus']};font-weight:600;}}
    QPushButton[kind="homeDay"] {{background:{c['surface']};padding:3px 2px;}}
    QPushButton[kind="homeDay"]:checked {{background:{c['soft']};color:{c['green']};border-color:{c['focus']};font-weight:600;}}
    QPushButton:disabled {{color:{c['subtle']};background:{c['inset']};}}
    QPushButton[kind="primary"], QPushButton[kind="send"] {{background:{c['primary']};color:#FFFFFF;border-color:{c['primary']};}}
    QPushButton[kind="primary"]:hover, QPushButton[kind="send"]:hover {{background:{'#458F82' if dark else '#22675F'};}}
    QPushButton[kind="send"] {{border-radius:10px;padding:7px;}}
    QPushButton[kind="nav"], QPushButton[kind="workspaceNav"] {{text-align:left;background:transparent;border:0;border-radius:7px;padding:10px 12px;color:{c['muted']};}}
    QPushButton[kind="workspaceNav"] {{font-size:13px;}}
    QPushButton[kind="nav"]:checked, QPushButton[kind="workspaceNav"]:checked {{background:{c['soft']};color:{c['green']};font-weight:600;}}
    QPushButton[kind="nav"]:hover, QPushButton[kind="workspaceNav"]:hover {{background:{c['soft']};}}
    QPushButton[kind="text"], QPushButton[kind="quiet"] {{background:transparent;color:{c['muted']};border:0;padding:5px 7px;}}
    QPushButton[kind="text"]:hover, QPushButton[kind="quiet"]:hover {{background:{c['soft']};color:{c['green']};}}
    QPushButton[kind="chatAction"] {{background:transparent;border:0;padding:5px 7px;color:{c['muted']};}}
    QPushButton[kind="chatAction"]:hover {{background:{c['soft']};color:{c['green']};}}
    QPushButton[kind="associationText"] {{background:transparent;color:{c['green']};border:0;padding:3px 5px;font-size:11px;}}
    QPushButton[kind="chip"] {{background:{c['inset']};border:1px solid {c['line']};border-radius:6px;padding:5px 9px;color:{c['muted']};font-size:11px;}}
    QPushButton[kind="chip"]:hover {{background:{c['soft']};color:{c['green']};}}
    QPushButton[kind="tab"]:checked {{background:{c['soft']};color:{c['green']};border-color:{c['focus']};}}
    QPushButton[kind="danger"] {{color:{'#DAA38E' if dark else '#A45C45'};}}
    QToolButton[kind="rail"] {{background:transparent;border:0;border-radius:9px;padding:7px 2px;color:{c['muted']};font-size:10px;}}
    QToolButton[kind="rail"]:checked {{background:{c['soft']};color:{c['green']};font-weight:600;}}
    QToolButton[kind="rail"]:hover {{background:{c['soft']};}}
    QToolButton[kind="railAux"] {{background:transparent;border:0;border-radius:8px;padding:8px;color:{c['muted']};}}
    QToolButton[kind="railAux"]:hover {{background:{c['soft']};}}
    QLineEdit, QTextEdit, QComboBox, QDateEdit, QTimeEdit {{background:{c['input']};color:{c['ink']};border:1px solid {c['line']};border-radius:8px;padding:10px;selection-background-color:{c['primary']};selection-color:white;}}
    QLineEdit:focus, QTextEdit:focus, QComboBox:focus, QDateEdit:focus, QTimeEdit:focus {{border-color:{c['focus']};}}
    QLineEdit:disabled {{color:{c['muted']};}}
    QLineEdit[kind="search"] {{background:{c['inset']};border:0;border-radius:7px;padding:8px 10px;font-size:12px;}}
    QTextEdit[kind="composer"], QTextEdit[kind="prompt"], QTextEdit#workPrompt, QTextEdit#taskPrompt {{background:transparent;border:0;border-radius:0;padding:0;font-size:16px;}}
    QTextEdit#peerChatInput {{background:transparent;border:0;border-radius:0;padding:2px;font-size:14px;}}
    QComboBox::drop-down {{border:0;width:23px;}}
    QScrollArea {{border:none;background:transparent;}}
    QScrollArea>QWidget>QWidget {{background:transparent;}}
    QScrollBar:vertical {{width:6px;background:transparent;margin:2px;}}
    QScrollBar::handle:vertical {{background:{'#545D54' if dark else '#CDD1C7'};border-radius:3px;min-height:30px;}}
    QScrollBar::add-line:vertical,QScrollBar::sub-line:vertical {{height:0;}}
    QScrollBar::add-page:vertical,QScrollBar::sub-page:vertical {{background:transparent;}}
    QScrollBar:horizontal {{height:6px;background:transparent;}}
    QScrollBar::handle:horizontal {{background:{'#545D54' if dark else '#CDD1C7'};border-radius:3px;min-width:30px;}}
    QScrollBar::add-line:horizontal,QScrollBar::sub-line:horizontal {{width:0;}}
    QTableWidget {{background:{c['surface']};alternate-background-color:{c['inset']};gridline-color:{c['line']};border:none;selection-background-color:{c['soft']};selection-color:{c['ink']};}}
    QTableWidget::item {{padding:10px;border-bottom:1px solid {c['line']};}}
    QTableWidget#drivePermissionTable::item {{padding:0 6px;}}
    QTableWidget#drivePermissionTable QComboBox {{padding:4px 6px;border-radius:6px;}}
    QHeaderView::section {{background:{c['inset']};color:{c['muted']};padding:11px;border:0;}}
    QListWidget {{background:{c['surface']};border:1px solid {c['line']};border-radius:8px;}}
    QListWidget::item {{padding:13px;border-bottom:1px solid {c['line']};}}
    QListWidget::item:selected {{background:{c['soft']};color:{c['ink']};}}
    QTreeWidget {{background:{c['surface']};alternate-background-color:{c['inset']};border:none;border-radius:6px;selection-background-color:{c['soft']};selection-color:{c['ink']};}}
    QTreeWidget::item {{padding:8px 4px;min-height:23px;border:0;}}
    QTreeWidget::item:selected {{background:{c['soft']};color:{c['ink']};}}
    QTreeWidget#driveFolderTree, QTreeWidget#organizationTree {{background:transparent;}}
    QTreeWidget#driveFileList::item {{padding:7px 4px;}}
    QTreeWidget#driveFileList QHeaderView::section {{padding:9px 5px;font-size:11px;}}
    QTabWidget::pane {{border:0;background:transparent;}}
    QTabBar::tab {{background:transparent;color:{c['muted']};padding:9px 12px;border-bottom:2px solid transparent;}}
    QTabBar::tab:selected {{color:{c['green']};border-bottom:2px solid {c['green']};}}
    QListWidget#conversationList {{background:transparent;border:0;}}
    QListWidget#conversationList::item {{padding:11px 5px;border:0;border-radius:5px;}}
    QListWidget#peerChatList {{background:transparent;border:0;}}
    QListWidget#peerChatList::item {{padding:13px 8px;border:0;border-radius:4px;min-height:38px;}}
    QWidget#homeAnnouncementTicker {{font-size:11px;color:{c['muted']};}}
    QListWidget#scheduleMembers::item {{padding:7px 10px;}}
    QListWidget#homeAgenda {{border:none;background:transparent;}}
    QListWidget#homeAgenda::item {{padding:6px 3px;font-size:12px;}}
    QProgressBar#homeCompletion {{background:{c['line']};border:0;border-radius:4px;}}
    QProgressBar#homeCompletion::chunk {{background:{c['primary']};border-radius:4px;}}
    QCheckBox {{spacing:9px;}} QCheckBox::indicator {{width:17px;height:17px;}}
    QStatusBar {{background:{c['side']};color:{c['muted']};font-size:10px;border-top:1px solid {c['line']};}}
    QMenuBar {{background:{c['bg']};color:{c['ink']};}}
    QMenuBar::item:selected {{background:{c['soft']};}}
    QMenu {{background:{c['surface']};color:{c['ink']};border:1px solid {c['line']};padding:5px;}}
    QMenu::item {{padding:7px 20px;}}
    QMenu::item:selected {{background:{c['soft']};}}
    QToolTip {{background:{c['surface']};color:{c['ink']};border:1px solid {c['line']};padding:7px;}}
    '''
