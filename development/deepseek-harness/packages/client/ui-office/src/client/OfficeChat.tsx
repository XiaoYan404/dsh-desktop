/** Human messaging uses private office history, independent drafts and a toolbar above the composer. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeMemberId, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import { avatarInitial, recordValue } from './values.ts'
import css from './OfficePage.module.css'

type ChatProps = OfficeProps & {
  view: OfficeView
  initialPeer: OfficeMemberId
  onClose(this: void): void
  onCreate(this: void, kind: 'task' | 'todo' | 'schedule', peer: OfficeMemberId): void
}
const emojis = ['😀', '👍', '✅', '🎉', '🙏', '📌'] as const

/** Keep conversation switching, scrolling and composition separate from confirmed message state. */
export function OfficeChat(props: ChatProps) {
  const { t, view: office, initialPeer, onClose, onCreate } = props
  const [peer, setPeer] = useState(initialPeer)
  const [query, setQuery] = useState('')
  const [showEmojis, setShowEmojis] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const snapshot = props.useChat(value => value)
  const files = props.useChatFiles(value => value)
  const fileDrafts = props.useFileDrafts(value => value)
  const durable = fileDrafts.mode === 'durable'
  const fileDraft = durable ? recordValue(fileDrafts.contacts, peer) : undefined
  const selectedFiles = durable ? fileDraft : recordValue(files.contacts, peer)
  const draft = props.useChatDrafts(state => recordValue(state, peer) ?? '')
  const draftStatus = props.useChatDraftStatus(state => state)
  const scroller = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const selectedPeer = useRef(peer)
  selectedPeer.current = peer
  const anchor = useRef<{ peer: OfficeMemberId; height: number; top: number; first: number | undefined } | null>(null)
  const view = snapshot.view?.peer?.id === peer ? snapshot.view : null
  const last = view?.messages.at(-1)
  const first = view?.messages[0]
  const busy = snapshot.pending.includes(peer) || Boolean(selectedFiles?.sending || fileDraft?.saving)
  const current = view?.peer ?? office.members.find(member => member.id === peer) ?? fileDraft?.peer
  const threads = snapshot.view?.threads ?? []
  const draftPeers = Object.values(fileDrafts.contacts).flatMap(contact => contact.files.length > 0 && contact.peer ? [contact.peer] : [])
  const peers = [
    ...threads.map(thread => thread.peer),
    ...draftPeers.filter(member => !threads.some(thread => thread.peer.id === member.id)),
    ...office.members.filter(
      member => member.id !== office.me.id && !threads.some(thread => thread.peer.id === member.id) &&
        !draftPeers.some(peer => peer.id === member.id),
    ),
  ]
  const sendError = recordValue(snapshot.sendErrors, peer)
  const draftError = recordValue(draftStatus.errors, peer)
  const pendingChanged = Boolean(fileDraft?.pendingSend && fileDraft.pendingSend.text !== draft)
  const cannotSend = busy || !draftStatus.ready || !current?.active || Boolean(fileDraft?.dirty) || pendingChanged ||
    (!draft.trim() && !selectedFiles?.files.length)
  const cannotSelectFiles = !current?.active || busy || !files.limits || Boolean(fileDraft?.blocked) ||
    (fileDrafts.mode !== 'durable' && fileDrafts.mode !== 'local')

  useEffect(() => {
    anchor.current = null
    props.loadChat(peer)
    setAtBottom(true)
    setShowEmojis(false)
  }, [peer, props.loadChat])
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element || !view) return
    if (anchor.current?.peer === peer && !snapshot.loadingOlder) {
      element.scrollTop = anchor.current.top + element.scrollHeight - anchor.current.height
      anchor.current = null
    } else if (atBottom && !anchor.current) element.scrollTop = element.scrollHeight
  }, [peer, first?.sequence, last?.sequence, atBottom, snapshot.loadingOlder, view])
  useEffect(() => {
    if (
      view &&
      last &&
      atBottom &&
      document.visibilityState === 'visible' &&
      view.messages.some(message => message.recipientId === office.me.id && message.sequence > view.readThrough)
    )
      void props.readChat(peer, last.sequence)
  }, [peer, last, atBottom, view, office.me.id, props.readChat])

  const send = async () => {
    const target = peer
    const text = draft
    if (cannotSend) return
    if (await props.sendChat(target, text)) {
      props.clearChatDraft(target, text, office.me.id)
      if (selectedPeer.current === target) {
        setAtBottom(true)
        textarea.current?.focus()
      }
    }
  }
  const older = () => {
    const element = scroller.current
    if (element) anchor.current = { peer, height: element.scrollHeight, top: element.scrollTop, first: first?.sequence }
    void props.olderChat()
  }
  return (
    <Modal open headless title={t('memberChat')} className={clsx(css.chatDialog)} onClose={onClose}>
      <div className={css.chatWindow}>
        <aside className={css.chatPeople} aria-label={t('chatPeople')}>
          <Input
            aria-label={t('search')}
            placeholder={t('search')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
            }}
          />
          <div className={css.chatPeers}>
            {peers
              .filter(member => member.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
              .map((member) => {
                const thread = threads.find(entry => entry.peer.id === member.id)
                const retained = durable ? recordValue(fileDrafts.contacts, member.id) : undefined
                return (
                  <Button
                    key={member.id}
                    className={css.chatPeer}
                    aria-label={member.name}
                    aria-pressed={peer === member.id}
                    onClick={() => {
                      setPeer(member.id)
                    }}
                  >
                    <span className={css.avatar}>{avatarInitial(member.name)}</span>
                    <span>
                      <span>{member.name}</span>
                      <small>{retained?.files.length ? `${t('chatFileDraft')}: ${retained.files.map(file => file.name).join(', ')}` :
                        thread?.latest.text.replace(/\s+/g, ' ').slice(0, 55)}</small>
                    </span>
                    {Boolean(thread?.unread) && <span className={css.badge}>{thread?.unread}</span>}
                  </Button>
                )
              })}
          </div>
        </aside>
        <section className={css.chatConversation}>
          <header className={css.chatHeader}>
            <h2>{current?.name ?? peer}</h2>
            {view &&
              view.messages.some(
                message => message.recipientId === office.me.id && message.sequence > view.readThrough,
              ) && (
              <Button
                size="sm"
                onClick={() => {
                  if (last) void props.readChat(peer, last.sequence)
                }}
              >
                {t('markChatRead')}
              </Button>
            )}
            <Button onClick={onClose}>{t('close')}</Button>
          </header>
          {snapshot.error && (
            <div role="alert" className={css.error}>
              {t(snapshot.error)}{' '}
              <Button
                onClick={() => {
                  props.loadChat(peer)
                }}
              >
                {t('retry')}
              </Button>
            </div>
          )}
          <div
            ref={scroller}
            className={css.chatMessages}
            role="log"
            aria-label={t('chatHistory')}
            onScroll={(event) => {
              const element = event.currentTarget
              setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 24)
            }}
          >
            {!view ? (
              <progress aria-label={t('loading')} />
            ) : (
              <>
                {view.hasMore && (
                  <Button disabled={snapshot.loadingOlder} onClick={older}>
                    {t('olderMessages')}
                  </Button>
                )}
                {view.messages.length === 0 && <p className={css.empty}>{t('noMessages')}</p>}
                {view.messages.map(message => (
                  <article
                    key={message.id}
                    className={css.chatMessage}
                    data-own={message.senderId === office.me.id}
                    data-office-message={message.id}
                  >
                    <span className={css.avatar}>
                      {avatarInitial(message.senderId === office.me.id
                        ? office.me.name
                        : (current?.name ?? message.senderName),
                      )}
                    </span>
                    <div>
                      <small>
                        {message.senderId === office.me.id ? office.me.name : (current?.name ?? message.senderName)} ·{' '}
                        {new Intl.DateTimeFormat(undefined, {
                          timeZone: office.timeZone,
                          dateStyle: 'short',
                          timeStyle: 'short',
                        }).format(message.createdAt)}
                      </small>
                      <p className={css.chatBubble}>{message.text}</p>
                      {message.attachments?.map((file) => {
                        const error = recordValue(files.downloadErrors, file.id)
                        return <div key={file.id} className={css.chatFileCard} data-office-chat-file={file.id}>
                          <span>{file.name}<small>{new Intl.NumberFormat(undefined).format(file.byteLength)} B</small></span>
                          <Button size="sm" disabled={files.downloads.includes(file.id)}
                            aria-label={`${t('chatDownloadFile')} · ${file.name}`}
                            onClick={() => { void props.downloadChatFile({ messageId: message.id, attachmentId: file.id }, file) }}>
                            {t(files.downloads.includes(file.id) ? 'driveDownloading' : 'chatDownloadFile')}
                          </Button>
                          {error && <p role="alert" className={css.error}>{t(error)}</p>}
                        </div>
                      })}
                      {message.senderId === office.me.id && (
                        <small>{t(message.sequence <= view.peerReadThrough ? 'read' : 'unread')}</small>
                      )}
                    </div>
                  </article>
                ))}
              </>
            )}
          </div>
          {!atBottom && (
            <Button
              onClick={() => {
                setAtBottom(true)
              }}
            >
              {t('backToLatest')}
            </Button>
          )}
          <div className={css.chatComposer}>
            <div className={css.row} role="toolbar" aria-label={t('memberChat')}>
              <Button size="sm" disabled={cannotSelectFiles}
                onClick={() => { picker.current?.click() }}>{t('chatAttachFiles')}</Button>
              <Button
                size="sm"
                disabled={!current?.active}
                aria-expanded={showEmojis}
                onClick={() => {
                  setShowEmojis(value => !value)
                }}
              >
                {t('emoji')}
              </Button>
              <Button
                size="sm"
                disabled={!current?.active}
                onClick={() => {
                  onCreate('task', peer)
                }}
              >
                {t('newTask')}
              </Button>
              <Button
                size="sm"
                disabled={!current?.active}
                onClick={() => {
                  onCreate('schedule', peer)
                }}
              >
                {t('newSchedule')}
              </Button>
              <Button
                size="sm"
                disabled={!current?.active}
                onClick={() => {
                  onCreate('todo', peer)
                }}
              >
                {t('newTodo')}
              </Button>
            </div>
            <input ref={picker} type="file" multiple className={css.hiddenPicker} aria-label={t('chatChooseFiles')}
              disabled={cannotSelectFiles}
              onChange={(event) => {
                props.addChatFiles(peer, Array.from(event.target.files ?? []))
                event.target.value = ''
              }} />
            {files.loading && <progress aria-label={t('loading')} />}
            {files.policyError && <div className={css.error} role="alert">
              {t('chatFilePolicyUnavailable')} <Button size="sm" onClick={props.loadChatFileLimits}>{t('retry')}</Button>
            </div>}
            {fileDrafts.error && <div className={css.error} role="alert">
              {t('chatFileDraftUnavailable')} <Button size="sm" onClick={props.loadChatFileDrafts}>{t('retry')}</Button>
            </div>}
            {files.limits && <small className={css.chatFilePolicy}>
              <span>{t('chatFileTotalLimit')}: {new Intl.NumberFormat(undefined).format(files.limits.maxMessageBytes)} B</span>{' · '}
              {t('chatFileCountLimit')}: {files.limits.maxFilesPerMessage}
            </small>}
            {Boolean(selectedFiles?.files.length) && <>
              <ul className={css.chatFileSelections} aria-label={t('chatSelectedFiles')}>
                {selectedFiles?.files.map(file => <li key={file.id}>
                  <span>{file.name}<small>{new Intl.NumberFormat(undefined).format(file.byteLength)} B</small></span>
                  <Button size="sm" disabled={busy || Boolean(fileDraft?.blocked)} aria-label={`${t('chatRemoveFile')} · ${file.name}`}
                    onClick={() => { props.removeChatFile(peer, file.id) }}>{t('chatRemoveFile')}</Button>
                </li>)}
              </ul>
              {files.limits && <small className={css.chatFilePolicy}>
                {t('chatFileQuota')}: {new Intl.NumberFormat(undefined).format(files.limits.ownerUsedBytes)} /{' '}
                {new Intl.NumberFormat(undefined).format(files.limits.ownerQuotaBytes)} B
              </small>}
              <small className={css.chatFilePolicy}>{t(durable ? 'chatFileDraftDurableHint' : 'chatFileDraftHint')}</small>
            </>}
            {fileDraft && (fileDraft.files.length > 0 || fileDraft.dirty || fileDraft.saving || fileDraft.saveError) &&
              <div role="group" aria-label={t('chatFileDraft')} className={css.fileDraftActions}>
                <small aria-live="polite" className={css.chatFilePolicy}>
                  {t(fileDraft.saving ? 'chatFileDraftSaving' : fileDraft.dirty ? 'chatFileDraftUnsaved' : 'chatFileDraftSaved')}
                </small>
                <small className={css.chatFilePolicy}>
                  {t('chatFileDraftQuota')}: {new Intl.NumberFormat(undefined).format(fileDrafts.ownerUsedBytes)} /{' '}
                  {new Intl.NumberFormat(undefined).format(fileDrafts.ownerQuotaBytes)} B
                </small>
                {!fileDraft.pendingSend && fileDraft.files.length > 0 && <Button size="sm" disabled={busy}
                  onClick={() => { void props.clearChatFileDraft(peer) }}>{t('chatFileDraftClear')}</Button>}
                {fileDraft.saveError && <div className={css.error} role="alert">
                  {t(fileDraft.saveError === 'conflict' ? 'chatFileDraftConflict' :
                    fileDraft.saveError === 'invalid_input' ? 'chatFileDraftInvalid' : 'chatFileDraftUnsaved')}
                  <div className={css.row}>
                    {fileDraft.saveError === 'conflict' ? <Button size="sm" disabled={busy}
                      onClick={() => { void props.resolveChatFileDraft(peer, true) }}>{t('chatFileDraftKeep')}</Button> :
                      <Button size="sm" disabled={busy} onClick={() => { void props.retryChatFileDraft(peer) }}>{t('chatFileDraftRetry')}</Button>}
                    <Button size="sm" disabled={busy} onClick={() => { void props.resolveChatFileDraft(peer, false) }}>
                      {t('chatFileDraftLoad')}
                    </Button>
                  </div>
                </div>}
                {fileDraft.pendingSend && <div>
                  <p className={css.chatFilePolicy}>{t('chatFileDraftPending')}</p>
                  <p className={css.chatBubble}>{fileDraft.pendingSend.text || t('chatFileWithoutCaption')}</p>
                  <div className={css.row}>
                    <Button size="sm" disabled={busy} onClick={() => { void props.retryChatFileSend(peer) }}>{t('chatFileRetrySend')}</Button>
                    <Button size="sm" disabled={busy} onClick={() => { void props.clearChatFileDraft(peer) }}>{t('chatFileDraftClear')}</Button>
                  </div>
                  <small className={css.chatFilePolicy}>{t('chatFileDraftClearHint')}</small>
                </div>}
              </div>}
            {selectedFiles?.error && <p role="alert" className={css.error}>{t(selectedFiles.error)}</p>}
            {showEmojis && (
              <div className={css.row}>
                {emojis.map(emoji => (
                  <Button
                    key={emoji}
                    aria-label={`${t('insertEmoji')} ${emoji}`}
                    onClick={() => {
                      props.setChatDraft(peer, draft + emoji)
                      setShowEmojis(false)
                      textarea.current?.focus()
                    }}
                  >
                    {emoji}
                  </Button>
                ))}
              </div>
            )}
            {!current?.active && <p>{t('chatInactive')}</p>}
            {sendError && (
              <p role="alert" className={css.error}>
                {t(sendError)}
              </p>
            )}
            {draftStatus.error && (
              <p role="alert" className={css.error}>
                {t(draftStatus.error)} <Button onClick={props.loadChatDrafts}>{t('retry')}</Button>
              </p>
            )}
            {draftError && (
              <div role="alert" className={css.error}>
                {t(draftError === 'conflict' ? 'draftConflict' : 'draftFailed')}{' '}
                {draftError === 'conflict' ? (
                  <>
                    <Button
                      size="sm"
                      onClick={() => {
                        void props.resolveChatDraft(peer, false)
                      }}
                    >
                      {t('draftLoad')}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        void props.resolveChatDraft(peer, true)
                      }}
                    >
                      {t('draftKeep')}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => {
                      void props.retryChatDraft(peer)
                    }}
                  >
                    {t('retry')}
                  </Button>
                )}
              </div>
            )}
            <textarea
              ref={textarea}
              data-modal-autofocus
              value={draft}
              maxLength={16000}
              disabled={!current?.active || !draftStatus.ready}
              placeholder={t('messagePlaceholder')}
              aria-label={t('messagePlaceholder')}
              onChange={(event) => {
                props.setChatDraft(peer, event.target.value)
              }}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.nativeEvent.isComposing &&
                  // oxlint-disable-next-line typescript/no-deprecated -- Some IMEs send legacy 229 before isComposing updates.
                  event.nativeEvent.keyCode !== 229
                ) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            <div className={css.chatSend}>
              <small role="status">
                {draftStatus.ready &&
                  !draftError &&
                  t(draftStatus.unsaved.includes(peer) ? 'draftSaving' : 'draftSaved')}
              </small>
              <Button
                variant="primary"
                disabled={cannotSend}
                onClick={() => {
                  void send()
                }}
              >
                {t(fileDraft?.saving ? 'chatFileDraftSaving' : busy ? 'messageSending' : 'send')}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </Modal>
  )
}
