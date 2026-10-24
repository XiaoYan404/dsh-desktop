import { downloadOfficeAudit } from './audit-download.ts'
import { OfficeCollaborationModel } from './collaboration-model.ts'
import { OfficeCollaboration } from './OfficeCollaboration.tsx'
import type { OfficeCollaborationInjected } from './collaboration-contracts.ts'
import { collaborationZh, collaborationEn } from './collaboration-copy.ts'
import { downloadOfficeGroupFile } from './group-download.ts'
import { randomUUID as newCollaborationId } from '@deepseek-ai/dsh-util-crypto'
/** Optional employee rail and workbench pages; native panels keep their owners. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { OfficeOutcome } from '../types.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { OfficeConversationId, OfficeConversationLinksInput, OfficeDriveId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { IconNewChatOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { OfficeModel } from './model.ts'
import { installOfficeExperienceClient } from './experience/register.ts'
import { OfficeChatModel } from './chat-model.ts'
import { OfficeChatFilesModel } from './chat-files-model.ts'
import { OfficeFileDraftModel } from './file-draft-model.ts'
import { OfficeConnectorsModel } from './connectors-model.ts'
import { OfficeExecutionsModel } from './executions-model.ts'
import { OfficeAutomationModel } from './automation-model.ts'
import { OfficeAutomationOverlay } from './OfficeAutomationOverlay.tsx'
import type { OfficeAutomationInjected } from './OfficeAutomationOverlay.tsx'
import { officeAutomationDictionary } from './automation-copy.ts'
import { OfficeAuditModel } from './audit-model.ts'
import { OfficeAudit } from './OfficeAudit.tsx'
import { OfficeConnectorSyncModel } from './connector-sync-model.ts'
import { OfficeIntegrationPluginsModel } from './integration-plugins-model.ts'
import { OfficeCustomizationsModel } from './customizations-model.ts'
import { OfficeCustomizations } from './OfficeCustomizations.tsx'
import { OfficeSubmissionsModel } from './submissions-model.ts'
import { OfficeToolsModel } from './tools-model.ts'
import { OfficeSearchModel } from './search-model.ts'
import { OfficeSearch } from './OfficeSearch.tsx'
import { OfficeAssociationsModel } from './associations-model.ts'
import { OfficeInputOwnership } from './input-ownership.ts'
import { createOfficeViewStore } from './store.ts'
import { OfficeChatDraftModel } from './draft-model.ts'
import { OfficeDriveModel } from './drive-model.ts'
import { OfficeKnowledgeModel } from './knowledge-model.ts'
import { OfficeDriveLifecycleModel } from './drive-lifecycle-model.ts'
import { OfficeDriveTransfers } from './drive-transfers.ts'
import { OfficeDrivePreviewModel } from './drive-preview-model.ts'
import { OfficeFileAssociationsModel } from './file-associations-model.ts'
import { OfficeFileAssociations } from './OfficeFileAssociations.tsx'
import { OfficeConnectionModel } from './connection-model.ts'
import { OfficeMemberInvitesModel } from './member-invites-model.ts'
import { OfficeMemberInvites } from './OfficeMemberInvites.tsx'
import { OfficeHomeInputModel } from './home-input-model.ts'
import { OfficeAssistanceModel } from './assistance-model.ts'
import { OfficeConversationModel } from './conversation-model.ts'
import { OfficeNavigationModel } from './navigation-model.ts'
import { officeHomeInputProvider } from './home-resource.ts'
import { OfficeHomeConversation } from './OfficeHomeConversation.tsx'
import { isOfficeConversation } from './session-list.ts'
import { OfficeItemContext } from './OfficeItemContext.tsx'
import { OfficeAssociations } from './OfficeAssociations.tsx'
import { OfficeConversationHeader } from './OfficeConversationHeader.tsx'
import { OfficeSessionBrowser, OfficeSessionBrowserTitle } from './OfficeSessionBrowser.tsx'
import { OfficeNavigation, OfficeNonHomePage, OfficePage, OfficeToast } from './OfficePage.tsx'
import { en, zh } from './locales.ts'
import type { OfficeKey } from './locales.ts'
import type { OfficeAuditInjected, OfficeConversationInjected, OfficeFileAssociationsInjected, OfficeInjected, OfficeSection,
  OfficeMemberInvitesInjected,
  OfficeSearchInjected } from './contracts.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    office: OfficeKey
  }
}
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** Office item inputs retained across navigation during one employee's mounted lifetime. */
    officeAssistance: unknown
    /** Ordinary office inputs retained only while their employee remains active. */
    officeConversation: unknown
    /** Discovery and draft preparation retain the exact native Conversation until their callback settles. */
    officeTools: unknown
    /** File-reference preparation retains the exact native input until its callback settles. */
    officeFiles: unknown
  }
}

async function searchValue<T>(operation: Promise<RemoteResult<OfficeOutcome<T>>>): Promise<T> {
  const result = await operation
  if (!result.ok || !result.value.ok) throw new Error('Office search is unavailable')
  return result.value.value
}

export const inject = [
  'slots',
  'locale',
  'layout',
  'uiWorkspace',
  'conversation',
  'sessions',
  'workspaces',
  'resources',
  'sidebarRight',
  'sidebarRightTabs',
  'remote',
  'remote.office',
  'remote.skills',
  'shortcuts',
]

/** @param ctx - Client services for the office mode. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('office', { zh, en }), 'office.locale')
  ctx.effect(() => ctx.locale.register('officeAutomation', officeAutomationDictionary), 'office.automationLocale')
  const remote = ctx.remote.office
  const resetPanels = new Set<() => void>()
  let navigated = false
  let officeInputSurface = false
  let navigationIdentity: OfficeMemberId | null | undefined
  const visitedSessions = new Set<SessionId>()
  const automaticHistory = new Set<SessionId>()
  const conversations = new OfficeConversationModel(
    (sessionId) => {
      const reference = ctx.sessions.retain(sessionId, { source: 'officeConversation' })
      return () => { reference.release() }
    },
    (sessionId) => {
      const list = ctx.sessions.list.getSnapshot()
      return list.ids.includes(sessionId) && Object.hasOwn(list.byId, sessionId) && isOfficeConversation(list.byId[sessionId]) &&
        !ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(sessionId)
    },
    (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
    (signal) => {
      if (ctx.workspaces.list.getSnapshot().items.length === 0) {
        ctx.uiWorkspace.startSession()
        return Promise.resolve(true)
      }
      return ctx.uiWorkspace.startPreparedSession(undefined, { prompt: '', files: [], submit: false }, signal)
    },
    (reason) => { model.notify(reason === 'storage' ? 'conversationStorageUnavailable'
      : reason === 'notification' ? 'conversationSyncUnavailable' : 'unavailable', false) },
  )
  ctx.effect(() => {
    const synchronize = (event: StorageEvent) => { void conversations.synchronize(event.key) }
    window.addEventListener('storage', synchronize)
    return () => { window.removeEventListener('storage', synchronize) }
  }, 'office.conversationStorage')
  const assistance = new OfficeAssistanceModel(
    remote,
    () => model.state.getSnapshot().view,
    (key, prompt, signal) => ctx.uiWorkspace.openLinkedSession(key, prompt, signal),
    ctx.locale.bind('office'),
    (key) => {
      if (key === 'unauthenticated') model.clear()
      model.notify(key, false)
    },
    (sessionId) => {
      const principal = model.state.getSnapshot().view?.me.id
      if (principal) void conversations.observe(sessionId, principal, 'item')
      const reference = ctx.sessions.retain(sessionId, { source: 'officeAssistance' })
      return () => { reference.release() }
    },
  )
  const homeInput = new OfficeHomeInputModel((prompt, files, submit, signal) => {
    officeInputSurface = true
    if (!prompt.trim() && files.length === 0 && !submit) {
      return navigation.open(signal)
    }
    return ctx.uiWorkspace.startPreparedSession(undefined, { prompt, files, submit }, signal)
  })
  const chats = new OfficeChatModel(remote)
  const connectors = new OfficeConnectorsModel(remote, (key, success) => {
    if (key === 'unauthenticated') model.clear()
    model.notify(key, success)
  })
  const associations = new OfficeAssociationsModel(remote, (key, success) => {
    if (key === 'unauthenticated' || key === 'forbidden') model.clear()
    model.notify(key, success)
  })
  const inputOwnership = new OfficeInputOwnership(remote)
  const automations = new OfficeAutomationModel(remote)
  const executions = new OfficeExecutionsModel(remote, (key) => {
    if (key === 'unauthenticated') model.clear()
    model.notify(key, false)
  })
  const submissions = new OfficeSubmissionsModel(remote, (key) => {
    if (key === 'unauthenticated' || key === 'forbidden') model.clear()
    model.notify(key, false)
  })
  const connectorSync = new OfficeConnectorSyncModel(remote, (key) => {
    if (key === 'unauthenticated') model.clear()
    model.notify(key, false)
  })
  const integrationPlugins = new OfficeIntegrationPluginsModel(remote, (key) => {
    if (key === 'unauthenticated') model.clear()
    model.notify(key, false)
  })
  const customizations = new OfficeCustomizationsModel(remote, (key) => {
    if (key === 'unauthenticated' || key === 'forbidden') model.clear()
    model.notify(key, false)
  }, (record) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'office-customization-request',
      version: 1, delivery: 'not_sent', record }, null, 2) + '\n'], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `customization-${record.id}-v${record.revision}.json`
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
  })
  ctx.effect(() => connectors.state.subscribe(() => {
    const snapshot = connectors.state.getSnapshot()
    submissions.synchronize(snapshot.view, snapshot.catalogue?.view)
    connectorSync.synchronize(snapshot.view, snapshot.catalogue?.view ?? null)
  }), 'office.submissionConfiguration')
  const associationId = (id: SessionId): OfficeConversationId => String(id) as OfficeConversationId
  const refreshAssociations = () => {
    const id = conversations.current()
    if (id) void associations.load(associationId(id))
  }
  const tools = new OfficeToolsModel(
    (id, signal) => ctx.sessions.using(id, { source: 'officeTools', signal }, async (reference) => {
      await reference.ready
      signal.throwIfAborted()
      if (conversations.current() !== id) throw new Error('Office Conversation changed')
      const result = await ctx.remote.skills.list({ sessionId: id }, signal)
      signal.throwIfAborted()
      if (!result.ok) throw new Error('Native skill catalog is unavailable')
      return result.value.skills
    }),
    async (id, prompt, signal, tool) => {
      homeInput.cancel()
      assistance.cancel()
      cancelConversationNavigation()
      if (!id) return ctx.uiWorkspace.startPreparedSession(undefined, { prompt, files: [], submit: false }, signal,
        async (created, lifetime) => {
          if (!await associations.addTool(associationId(created), tool, lifetime)) throw new Error('Office association was not confirmed')
        })
      return ctx.sessions.using(id, { source: 'officeTools', signal }, async (reference) => {
        await reference.ready
        signal.throwIfAborted()
        if (conversations.current() !== id) return false
        const input = ctx.conversation.input.for(reference.binding.ctx)
        if (input.state.getSnapshot().phase !== 'plain') return false
        if (!await associations.addTool(associationId(id), tool, signal)) return false
        signal.throwIfAborted()
        if (conversations.current() !== id) return false
        const snapshot = input.state.getSnapshot()
        if (snapshot.phase !== 'plain') return false
        const text = `${prompt}${snapshot.draft ? '\n\n' : ''}`
        const applied = reference.binding.ctx.bail(reference.binding.ctx, 'slash/input-insert-text', {
          text, span: { start: 0, end: 0, draftRev: snapshot.draftRev },
        }) === true
        if (!applied) return false
        ctx.uiWorkspace.openSession(id)
        input.focus()
        return true
      })
    },
    (key, success) => { model.notify(key, success) },
  )
  const saveOfficeFile = (file: { readonly name: string }, content: Blob) => {
    const url = URL.createObjectURL(content)
    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
  }
  const audits = new OfficeAuditModel(remote, (key, success) => {
    if (key === 'unauthenticated' || key === 'forbidden') model.clear()
    model.notify(key, success)
  }, (content) => { saveOfficeFile({ name: 'office-audit.ndjson' }, new Blob([content], { type: 'application/x-ndjson;charset=utf-8' })) })
  const chatFiles = new OfficeChatFilesModel(remote, (key, success) => {
    if (key === 'unauthenticated') model.clear()
    model.notify(key, success)
  }, () => chats.load(), saveOfficeFile)
  const chatDrafts = new OfficeChatDraftModel(remote)
  const fileDrafts = new OfficeFileDraftModel(remote, () => chatFiles.state.getSnapshot().limits, (key, success) => {
    if (key === 'unauthenticated') model.clear()
    model.notify(key, success)
  }, async () => { void chatFiles.load(); await chats.load() })
  const connection = new OfficeConnectionModel(
    remote,
    (initial) => {
      const confirmed = connection.state.getSnapshot().connection
      const visible = model.state.getSnapshot().view?.me
      if (initial && confirmed?.connected && confirmed.member?.id === visible?.id && confirmed.member?.role === visible?.role) return
      if (initial && confirmed?.connected && !visible) {
        // Initial connection and employee-view reads may finish in either order; no previous employee exists to revoke here.
        void model.load()
        return
      }
      model.clear()
      if (!initial) ctx.layout.selectPanel('office.home' as MainPanelId)
      void model.load()
    },
    (key, success) => {
      model.notify(key, success)
    },
  )
  const knowledge = new OfficeKnowledgeModel(remote, (key, success) => { model.notify(key, success) })
  const drive = new OfficeDriveModel(remote, (key, success) => {
    model.notify(key, success)
  })
  const memberInvites = new OfficeMemberInvitesModel(remote, (memberId) => { connection.prepareInvitedSignIn(memberId) },
    (key, success) => { model.notify(key, success) })
  const drivePreview = new OfficeDrivePreviewModel(remote, (key, success) => {
    if (key === 'unauthenticated') model.clear()
    model.notify(key, success)
  })
  const fileAssociations = new OfficeFileAssociationsModel(remote, async (file, signal): Promise<boolean> => {
    tools.cancel()
    homeInput.cancel()
    assistance.cancel()
    cancelConversationNavigation()
    const id = conversations.current()
    if (!id) return ctx.uiWorkspace.startPreparedSession(undefined, { prompt: '', files: [], submit: false }, signal,
      async (created, lifetime) => {
        if (!await fileAssociations.add(associationId(created), file, lifetime)) throw new Error('Office file association was not confirmed')
      })
    return ctx.sessions.using(id, { source: 'officeFiles', signal }, async (reference) => {
      await reference.ready
      signal.throwIfAborted()
      if (conversations.current() !== id || !await fileAssociations.add(associationId(id), file, signal)) return false
      signal.throwIfAborted()
      if (conversations.current() !== id) return false
      ctx.uiWorkspace.openSession(id)
      return true
    })
  }, (key, success) => {
    if (key === 'unauthenticated') model.clear()
    model.notify(key, success)
  })
  const transfers = new OfficeDriveTransfers(
    remote,
    (key, success) => {
      if (key === 'unauthenticated') model.clear()
      model.notify(key, success)
    },
    () => drive.load(),
    saveOfficeFile,
  )
  const driveLifecycle = new OfficeDriveLifecycleModel(remote, () => drive.load(), () => { model.clear() })
  ctx.effect(() => drive.state.subscribe(() => {
    transfers.configure(drive.state.getSnapshot().view?.transfers)
  }), 'office.driveTransfers')
  const model = new OfficeModel(remote, (principal) => {
    // The first confirmed identity may satisfy startup; every later identity event revokes its earlier intent.
    if (navigationIdentity !== undefined) navigation.cancel()
    navigationIdentity = principal
    inputOwnership.bind(principal)
    homeInput.bind(principal)
    assistance.bind(principal)
    void conversations.bind(principal)
    visitedSessions.clear()
    automaticHistory.clear()
    for (const reset of resetPanels) reset()
    chatDrafts.bind(principal)
    chats.bind(principal)
    chatFiles.bind(principal)
    fileDrafts.bind(principal)
    transfers.bind(principal)
    drivePreview.bind(principal)
    drive.bind(principal)
    if (!principal) knowledge.bind(null)
    if (principal) void chats.load()
    else if (
      connection.state.getSnapshot().connection?.mode === 'gateway' &&
      connection.state.getSnapshot().connection?.connected
    )
      void connection.load()
  })
  const navigation = new OfficeNavigationModel((principal, signal) => {
    signal.throwIfAborted()
    // Native startup may still be connecting a blank; this explicit, now-ready entry supersedes that navigation.
    ctx.layout.beginNavigation()
    if (principal === null) { ctx.layout.selectPanel(null); return Promise.resolve(true) }
    return conversations.restore(signal)
  }, () => { model.notify('unavailable', false) })
  const cancelConversationNavigation = () => { navigation.cancel(); conversations.cancel() }
  ctx.effect(() => {
    const bind = () => {
      const snapshot = connection.state.getSnapshot()
      memberInvites.bind(snapshot.connection, snapshot.memberInvitations, model.state.getSnapshot().view?.members ?? [])
    }
    const stopConnection = connection.state.subscribe(bind)
    const stopOffice = model.state.subscribe(bind)
    bind()
    return () => { stopConnection(); stopOffice() }
  }, 'office.memberInvitesAuthority')
  ctx.effect(() => ctx.resources.register(officeHomeInputProvider(ctx.sessions, conversations)), 'office.homeInputResource')
  ctx.effect(() => ctx.on('conversation/input-prepare', ({ sessionId, signal }, next) => {
    if (ctx.layout.panelInfo.getSnapshot().activePanelId === 'office.home') officeInputSurface = true
    if (!officeInputSurface) return next()
    const member = model.state.getSnapshot().view?.me
    const ready = member ? inputOwnership.prepare(associationId(sessionId), signal, member.id) : Promise.resolve(undefined)
    const remaining = next()
    return Promise.resolve(remaining).then(() => ready).then((approve) => {
      if (!approve?.()) throw new Error(ctx.locale.bind('office')('officeInputUnavailable'))
    })
  }), 'office.inputOwnership')
  ctx.effect(() => ctx.on('conversation/input-submitted', (sessionId) => {
    const scope = conversations.ordinaryScope()
    if (scope?.sessionId === sessionId && ctx.layout.panelInfo.getSnapshot().activePanelId === 'office.home') {
      ctx.uiWorkspace.openSession(sessionId)
    }
  }), 'office.homeInputSubmission')
  ctx.effect(() => {
    let catalog = ctx.sessions.list.getSnapshot()
    let previousHomePanel = ctx.layout.panelInfo.getSnapshot().activePanelId
    let homeVisit = 0
    let preparedHome = ''
    const synchronize = () => {
      const office = model.state.getSnapshot()
      const nextCatalog = ctx.sessions.list.getSnapshot()
      if (catalog !== nextCatalog) { catalog = nextCatalog; conversations.catalogChanged() }
      const panel = ctx.layout.panelInfo.getSnapshot().activePanelId
      if (previousHomePanel !== panel) { previousHomePanel = panel; homeVisit++ }
      const workspacesReady = ctx.workspaces.list.getSnapshot().phase === 'ready'
      navigation.configure({
        employee: office.view?.me.id ?? (office.loading ? undefined : null),
        sessionsReady: catalog.phase === 'ready',
        workspacesReady,
      })
      const state = conversations.state.getSnapshot()
      const homeKey = `${state.generation}:${homeVisit}`
      if (panel === 'office.home' && office.view && catalog.phase === 'ready' && workspacesReady &&
        state.phase === 'ready' && !state.restoring && preparedHome !== homeKey) {
        preparedHome = homeKey
        void conversations.restore(undefined, false)
      }
    }
    const stopOffice = model.state.subscribe(synchronize)
    const stopSessions = ctx.sessions.list.subscribe(synchronize)
    const stopWorkspaces = ctx.workspaces.list.subscribe(synchronize)
    const stopConversations = conversations.state.subscribe(synchronize)
    let previousPanel = ctx.layout.panelInfo.getSnapshot().activePanelId
    const stopPanel = ctx.layout.panelInfo.subscribe(() => {
      const next = ctx.layout.panelInfo.getSnapshot().activePanelId
      if (next !== previousPanel) {
        previousPanel = next
        navigation.cancelWaiting()
        if (next !== 'office.drive') { drivePreview.close(); driveLifecycle.close() }
        if (next !== 'office.integrations') connectorSync.close()
        customizations.close()
        audits.close()
      }
      synchronize()
    })
    synchronize()
    return () => { stopOffice(); stopSessions(); stopWorkspaces(); stopConversations(); stopPanel(); navigation.dispose() }
  }, 'office.navigationReadiness')
  ctx.effect(() => model.state.subscribe(() => {
    const member = model.state.getSnapshot().view?.me ?? null
    connectors.bind(member)
    executions.bind(member)
    automations.bind(member)
    audits.bind(member)
    connectorSync.bind(member)
    integrationPlugins.bind(member)
    customizations.bind(member)
    submissions.bind(member)
    tools.bind(member)
    driveLifecycle.bind(member)
    knowledge.bind(member, model.state.getSnapshot().view?.knowledge)
    transfers.bind(member?.id ?? null, member?.role)
    transfers.configure(drive.state.getSnapshot().view?.transfers)
    associations.bind(member)
    fileAssociations.bind(member, model.state.getSnapshot().view?.conversationFiles)
  }), 'office.connectorIdentity')
  ctx.effect(() => conversations.state.subscribe(() => {
    const id = conversations.current()
    if (!id) associations.clear()
    else if (associations.state.getSnapshot().conversationId !== associationId(id)) refreshAssociations()
    fileAssociations.observe(id ? associationId(id) : null)
  }), 'office.associationTarget')
  const sections: readonly OfficeSection[] = [
    'home',
    'calendar',
    'contacts',
    'drive',
    'work',
    'integrations',
    'tools',
    'team',
  ]
  const panel = (section: OfficeSection): MainPanelId =>
    `office.${section}` as MainPanelId
  const sessionBrowserId = '@deepseek-ai/dsh-client-ui-office:sessions'
  const sessionBrowserKind = 'office.sessions'
  const hasResourceTabs = (sessionId: SessionId): boolean => ctx.sidebarRight.openTabs.getSnapshot().some(tab =>
    tab.sessionId === sessionId && tab.kind !== 'guide' && tab.kind !== sessionBrowserKind)
  const shrinkAutomaticHistory = (): void => {
    const sessionId = ctx.sidebarRight.mounted.getSnapshot()
    if (window.innerWidth >= 1040 || !sessionId || !automaticHistory.has(sessionId)) return
    automaticHistory.delete(sessionId)
    if (!hasResourceTabs(sessionId) && ctx.sidebarRight.active()?.kind === sessionBrowserKind && ctx.sidebarRight.isExpanded()) {
      ctx.sidebarRight.toggleExpanded()
    }
  }
  ctx.effect(() => {
    window.addEventListener('resize', shrinkAutomaticHistory)
    return () => { window.removeEventListener('resize', shrinkAutomaticHistory) }
  }, 'office.responsiveHistory')
  const conversationFace = (): OfficeConversationInjected => ({
    hooks: {
      office: model.state, assistance: assistance.state,
      sidebarSession: ctx.sidebarRight.mounted, conversations: conversations.state,
    },
    observeConversation: (sessionId, principal) => {
      const state = assistance.state.getSnapshot()
      if (state.openingId || model.state.getSnapshot().view?.me.id !== principal) return
      void conversations.observe(sessionId, principal, Object.hasOwn(state.contexts, sessionId) ? 'item' : 'ordinary')
    },
    showConversationHistory: (sessionId, automatic) => {
      if (!model.state.getSnapshot().view || ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return
      if (automatic) {
        shrinkAutomaticHistory()
        if (visitedSessions.has(sessionId)) return
        visitedSessions.add(sessionId)
        if (window.innerWidth < 1040) return
        if (hasResourceTabs(sessionId)) return
        automaticHistory.add(sessionId)
      } else {
        navigated = true
        automaticHistory.delete(sessionId)
      }
      ctx.sidebarRight.openTab(sessionBrowserKind)
    },
    newConversation: () => {
      officeInputSurface = true
      navigated = true
      fileAssociations.cancelPreparation()
      homeInput.cancel()
      assistance.cancel()
      cancelConversationNavigation()
      ctx.uiWorkspace.startSession()
    },
    selectConversation: (sessionId) => {
      officeInputSurface = true
      fileAssociations.cancelPreparation()
      const list = ctx.sessions.list.getSnapshot()
      if (conversations.state.getSnapshot().phase !== 'ready' || !list.ids.includes(sessionId) ||
        conversations.state.getSnapshot().hidden.includes(sessionId) ||
        ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(sessionId)) {
        model.notify('not_found', false)
        return
      }
      navigated = true
      homeInput.cancel()
      assistance.cancel()
      cancelConversationNavigation()
      ctx.uiWorkspace.openSession(sessionId)
    },
    refreshConversations: () => {
      void conversations.synchronize(null)
      void ctx.sessions.refresh().catch(() => { model.notify('unavailable', false) })
    },
    openOfficeHome: () => {
      officeInputSurface = true
      navigated = true
      ctx.layout.selectPanel(panel('home'))
      void model.load(null)
    },
    updateProfile: profile => model.mutate(() => remote.updateProfile(profile)),
    openAudit: () => audits.open(),
    openCollaboration: navigate => { void collaboration.open(navigate) },
  })
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: sessionBrowserId, kind: sessionBrowserKind, priority: 'builtin',
    title: () => ctx.locale.bind('office')('sessionHistory'),
    guide: [{ id: 'sessions', order: 5, title: () => ctx.locale.bind('office')('sessionHistory'), icon: IconNewChatOutlineRegular }],
  }), 'office.conversationTab')
  ctx.slots.inject('sidebar.right.pane.tab', function* () {
    const owned = new Set<() => void>()
    yield ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: sessionBrowserId, locale: 'office',
      store: createOfficeViewStore((reset) => { resetPanels.add(reset); owned.add(reset) }),
      inject: conversationFace,
    }, OfficeSessionBrowser)
    yield () => { for (const reset of owned) resetPanels.delete(reset) }
  })
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: sessionBrowserId, locale: 'office',
  }, OfficeSessionBrowserTitle))
  ctx.slots.inject('conversation.header.trailing', () => ctx.slots.register({
    name: 'conversation.header.trailing', id: 'office.conversations', order: 900, locale: 'office', inject: conversationFace,
  }, OfficeConversationHeader))
  const search = new OfficeSearchModel(async (query, signal) => {
    const before = await searchValue(remote.view(undefined))
    signal.throwIfAborted()
    const sessionId = conversations.current()
    const [privateFiles, sharedFiles, skills] = await Promise.allSettled([
      searchValue(remote.drive({ space: 'private', folderId: null, search: query })),
      searchValue(remote.drive({ space: 'shared', folderId: null, search: query })),
      sessionId ? ctx.sessions.using(sessionId, { source: 'officeTools', signal }, async (reference) => {
        await reference.ready
        signal.throwIfAborted()
        if (conversations.current() !== sessionId) throw new Error('Office Conversation changed')
        const result = await ctx.remote.skills.list({ sessionId }, signal)
        if (!result.ok) throw new Error('Skill search is unavailable')
        return result.value.skills
      }) : Promise.resolve([]),
    ])
    signal.throwIfAborted()
    const view = await searchValue(remote.view(undefined))
    signal.throwIfAborted()
    if (view.me.id !== before.me.id || view.me.role !== before.me.role)
      throw new Error('Office search identity changed')
    return { view, sessionId: conversations.current() === sessionId ? sessionId : null,
      files: [privateFiles, sharedFiles].flatMap(result => result.status === 'fulfilled' && result.value.meId === view.me.id
        ? result.value.entries : []),
      skills: skills.status === 'fulfilled' ? skills.value : [],
      failures: [...(privateFiles.status === 'rejected' ? ['searchPrivateUnavailable' as const] : []),
        ...(sharedFiles.status === 'rejected' ? ['searchSharedUnavailable' as const] : []),
        ...(skills.status === 'rejected' ? ['searchSkillsUnavailable' as const] : [])],
    }
  }, async (result, signal) => {
    const original = model.state.getSnapshot().view?.me
    const view = await searchValue(remote.view(undefined))
    signal.throwIfAborted()
    if (!original || view.me.id !== original.id || view.me.role !== original.role) return false
    if (result.kind === 'page') {
      face('home').navigate(result.page.section)
      return true
    }
    if (result.kind === 'item') {
      const item = [...view.items, ...(view.inactiveWork ?? [])].find(item => item.id === result.item.id)
      if (!item) return false
      await model.load(item.date)
      signal.throwIfAborted()
      face('home').navigate('work')
    } else if (result.kind === 'member') {
      if (!view.members.some(member => member.id === result.member.id)) return false
      await model.load()
      signal.throwIfAborted()
      face('home').navigate('contacts')
    } else if (result.kind === 'file') {
      const file = result.file
      const location = { space: file.space, folderId: file.kind === 'folder' ? file.id : file.parentId }
      const folder = await searchValue(remote.drive({ ...location, search: '' }))
      signal.throwIfAborted()
      if (file.kind === 'file' && !folder.entries.some(entry => entry.id === file.id)) return false
      face('home').navigate('drive')
      void drive.navigate(location)
    } else {
      if (conversations.current() !== result.sessionId) return false
      await tools.load(result.sessionId)
      signal.throwIfAborted()
      const catalogue = tools.state.getSnapshot()
      if (catalogue.error || catalogue.loading || catalogue.sessionId !== result.sessionId
        || !catalogue.skills.some(skill => skill.name === result.skill.name)) return false
      face('home').navigate('tools')
    }
    return true
  })
  const openOfficeSearch = () => {
    const t = ctx.locale.bind('office')
    const destinations = ['home', 'ai', 'contacts', 'drive', 'work', 'integrations', 'tools', 'calendar', 'team', 'settings'] as const
    search.open(destinations.map(section => ({ section, title: t(section) })))
  }
  ctx.effect(() => {
    const synchronize = () => { search.bind(model.state.getSnapshot().view?.me ?? null) }
    synchronize()
    return model.state.subscribe(synchronize)
  }, 'office.searchIdentity')
  ctx.effect(() => ctx.shortcuts.register({
    id: 'office.search' as ShortcutCommandId,
    label: () => ctx.locale.bind('office')('globalSearch'), aliases: ['office search'],
    defaults: {
      'desktop:macos': { code: 'KeyK', modifiers: ['primary', 'alt'] },
      'desktop:windows': { code: 'KeyK', modifiers: ['primary', 'alt'] },
      'desktop:linux': { code: 'KeyK', modifiers: ['primary', 'alt'] },
      'web:macos': { code: 'KeyK', modifiers: ['primary'] },
      'web:windows': { code: 'KeyK', modifiers: ['primary'] },
      'web:linux': { code: 'KeyK', modifiers: ['primary'] },
    },
    regions: ['page', 'editable'], modals: [],
    resolve: context => context.modal === null && context.region !== 'terminal' && model.state.getSnapshot().view
      ? { status: 'handled', run: openOfficeSearch } : { status: 'pass' },
  }), 'office.searchShortcut')
  ctx.on('ui-workspace/search-request', (context) => {
    if (context.modal !== null || context.region === 'terminal' || !model.state.getSnapshot().view
      || !ctx.layout.panelInfo.getSnapshot().activePanelId?.startsWith('office.')) return
    openOfficeSearch()
    return true
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'office.search', locale: 'office',
    inject: (): OfficeSearchInjected => ({ hooks: { search: search.state },
      closeSearch: () => { search.close() },
      querySearch: (query) => { void search.query(query) },
      selectSearch: (key) => { void search.select(key) },
    }),
  }, OfficeSearch))
  const experience = installOfficeExperienceClient(ctx, {
    office: model.state,
    view: async () => { const result = await remote.experienceView(); if (!result.ok) throw new Error('unavailable'); if (!result.value.ok) throw new Error(result.value.code); return result.value.value },
    saveAssistant: async (revision, input) => { const result = await remote.saveExperienceAssistant(revision, input); if (!result.ok) throw new Error('unavailable'); if (!result.value.ok) throw new Error(result.value.code); return result.value.value },
    saveAppearance: async (revision, input) => { const result = await remote.saveExperienceAppearance(revision, input); if (!result.ok) throw new Error('unavailable'); if (!result.value.ok) throw new Error(result.value.code) },
    prepare: (prompt, presetId, signal) => {
      officeInputSurface = true
      navigated = true
      tools.cancel(); homeInput.cancel(); assistance.cancel(); cancelConversationNavigation()
      return ctx.uiWorkspace.startPreparedSession(undefined, { prompt, files: [], submit: false }, signal, async (id, preparation) => {
        const owner = await remote.prepareNativeInput(associationId(id))
        preparation.throwIfAborted()
        if (!owner.ok || !owner.value.ok) throw new Error('unauthenticated')
        if (presetId) {
          const selected = await ctx.remote.agentPresets.select(id, presetId)
          preparation.throwIfAborted()
          if (!selected.ok) throw new Error('not_found')
        }
      })
    },
    download: (name, text) => { saveOfficeFile({ name }, new Blob([text], { type: 'application/json;charset=utf-8' })) },
  })
  ctx.effect(() => ctx.locale.register('office.collaboration', { zh: collaborationZh, en: collaborationEn }), 'office.collaborationLocale')
  const desktopDevice = newCollaborationId()
  const groupDownloads = new Set<AbortController>()
  const collaboration = new OfficeCollaborationModel(remote, {
    permission: () => typeof Notification === 'undefined' ? 'denied' : Notification.permission,
    requestPermission: async () => typeof Notification === 'undefined' ? 'denied' : Notification.requestPermission(),
    show: (notice, open) => {
      const presentation = new Notification(notice.title, { tag: notice.key })
      presentation.onclick = open
      return { close: () => { presentation.close() } }
    },
  })
  ctx.effect(() => {
    let previous = ''
    const bind = () => {
      const view = model.state.getSnapshot().view
      const key = view ? JSON.stringify([view.me.id, view.me.role, view.me.active]) : ''
      if (key !== previous) { for (const download of groupDownloads) download.abort(); previous = key }
      collaboration.bind(view?.me ?? null, view?.managedMembers ?? view?.members ?? [])
    }
    bind()
    const stop = model.state.subscribe(bind)
    return () => { stop(); for (const download of groupDownloads) download.abort(); collaboration.dispose() }
  }, 'office.collaborationIdentity')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'office.collaboration', locale: 'office.collaboration',
    inject: (): OfficeCollaborationInjected => ({
      hooks: { collaboration: collaboration.state, groupDrive: drive.state },
      closeCollaboration: () => { collaboration.close() }, refreshCollaboration: () => { void collaboration.refresh() },
      filterCollaboration: (source, unread) => collaboration.filter(source, unread), moreCollaboration: () => collaboration.moreInbox(),
      saveCollaborationPreferences: value => collaboration.savePreferences(value), enableCollaborationDesktop: () => collaboration.allowDesktop(),
      openCollaborationNotice: (key, jump) => collaboration.openNotice(key, jump),
      retryCollaborationDesktop: key => collaboration.showDesktop(key, desktopDevice, true),
      createCollaborationGroup: value => collaboration.createGroup(value), updateCollaborationGroup: value => collaboration.updateGroup(value),
      loadCollaborationGroup: (id, older, search) => collaboration.loadGroup(id, older, search), leaveCollaborationGroup: () => collaboration.leaveGroup(),
      sendCollaborationMessage: (id, text, mentions, files) => collaboration.send(id, text, mentions, files),
      createCollaborationMeetings: value => collaboration.createMeetings(value), loadCollaborationGovernance: () => collaboration.loadGovernance(),
      offboardCollaborationMember: value => collaboration.offboard(value), saveCollaborationPolicy: value => collaboration.savePolicy(value),
      restoreCollaborationMember: value => collaboration.restore(value),
      resolveCollaborationFile: async id => {
        const snapshot = collaboration.state.getSnapshot()
        const result = await remote.driveFileInfo(id)
        const current = collaboration.state.getSnapshot()
        return result.ok && result.value.ok && current.visible && snapshot.epoch === current.epoch && snapshot.group?.group.id === current.group?.group.id
          ? { fileId: id, versionId: result.value.value.versionId } : null
      },
      downloadCollaborationFile: async (groupId, messageId, file) => {
        const snapshot = collaboration.state.getSnapshot()
        const memberId = snapshot.principal?.id
        const limits = drive.state.getSnapshot().view?.transfers
        if (!memberId || !limits || !snapshot.visible) return
        const controller = new AbortController()
        groupDownloads.add(controller)
        try {
          await downloadOfficeGroupFile({ remote, groupId, messageId, file, memberId, limits, signal: controller.signal,
            current: () => { const current = collaboration.state.getSnapshot(); return current.visible && current.epoch === snapshot.epoch },
            notify: (key, success) => { model.notify(key, success) }, save: saveOfficeFile })
        } finally { groupDownloads.delete(controller) }
      },
      fieldCollaborationAudit: (key, value) => { collaboration.fieldAudit(key, value) },
      searchCollaborationAudit: () => collaboration.searchAudit(),
      moreCollaborationAudit: () => collaboration.moreAudit(),
      exportCollaborationAudit: async () => {
        await downloadOfficeAudit(collaboration, { save: saveOfficeFile, notify: (key, success) => { model.notify(key, success) } })
      },
    }),
  }, OfficeCollaboration))
  const face = (section: OfficeSection): OfficeInjected => ({
    hooks: {
      office: model.state,
      search: search.state,
      navigation: navigation.state,
      conversations: conversations.state,
      notice: model.notice,
      chat: chats.state,
      chatFiles: chatFiles.state,
      fileDrafts: fileDrafts.state,
      connectors: connectors.state,
      executions: executions.state,
      connectorSync: connectorSync.state,
      integrationPlugins: integrationPlugins.state,
      customizations: customizations.state,
      submissions: submissions.state,
      tools: tools.state,
      chatDrafts: chatDrafts.state,
      chatDraftStatus: chatDrafts.status,
      drive: drive.state,
      knowledge: knowledge.state,
      driveLifecycle: driveLifecycle.state,
      driveTransfers: transfers.state,
      drivePreview: drivePreview.state,
      fileAssociations: fileAssociations.state,
      connection: connection.state,
      homeInput: homeInput.state,
      assistance: assistance.state,
      experience: experience.state,
    },
    section,
    searchKnowledge: query => knowledge.search(query),
    openKnowledgeCitation: citation => knowledge.open(citation),
    reviewKnowledgeFile: id => knowledge.review(id),
    saveKnowledge: kind => knowledge.save(kind),
    closeKnowledgeReview: () => { knowledge.closeReview() },
    openSearch: openOfficeSearch,
    consumeSearchTarget: (key) => { search.consume(key) },
    navigate: (target) => {
      navigated = true
      fileAssociations.cancelPreparation()
      fileAssociations.endChoosing()
      tools.cancel()
      homeInput.cancel()
      assistance.cancel()
      cancelConversationNavigation()
      if (target === 'ai') {
        void navigation.open()
      }
      else if (target === 'settings') ctx.emit('settings/ui-open')
      else {
        ctx.layout.selectPanel(panel(target))
        if (target === 'home') void model.load(null)
        if (target === 'integrations') void connectors.load(true)
        if (target === 'tools') { void tools.load(conversations.current()); void connectors.load() }
      }
    },
    load: (date) => {
      void model.load(date)
    },
    createWork: input => model.mutate(() => remote.createWork(input)),
    createSchedule: input => model.mutate(() => remote.createSchedule(input)),
    updateSchedule: (item, input) => model.mutate(() => remote.updateSchedule(item.id, item.revision, input)),
    checkScheduleAvailability: async (input) => {
      const result = await remote.scheduleAvailability(input)
      return result.ok && result.value.ok ? result.value.value : null
    },
    decideTask: (item, input) => model.mutate(() => remote.decideTask(item.id, item.revision, input)),
    updateWork: (item, input) => model.mutate(() => remote.updateWork(item.id, item.revision, input)),
    updateWorkSubtasks: (item, input) => model.mutate(() => remote.updateWorkSubtasks(item.id, item.revision, input)),
    reviewTaskDelivery: (item, input) => model.mutate(() => remote.reviewTaskDelivery(item.id, item.revision, input)),
    updateWorkAttachments: (item, input) => model.mutate(() => remote.updateWorkAttachments(item.id, item.revision, input)),
    changeWorkLifecycle: (item, input) => model.mutate(() => remote.changeWorkLifecycle(item.id, item.revision, input)),
    loadWorkAttachments: async (id) => {
      const result = await remote.workAttachments(id)
      return result.ok && result.value.ok ? result.value.value : null
    },
    resolveWorkAttachmentFile: async (id) => {
      const result = await remote.driveFileInfo(id)
      return result.ok && result.value.ok ? result.value.value : null
    },
    browseAttachmentFiles: (location) => { void drive.navigate(location) },
    downloadWorkAttachment: async (item, id) => {
      const original = model.state.getSnapshot().view
      const result = await remote.workAttachmentInfo(item.id, id)
      if (!result.ok || !result.value.ok) { model.notify('workAttachmentUnavailable', false); return }
      const info = result.value.value
      if (!drive.state.getSnapshot().view?.transfers) await drive.load()
      const current = model.state.getSnapshot().view
      if (!original || current?.me.id !== original.me.id || current.me.role !== original.me.role ||
        ![...current.items, ...(current.inactiveWork ?? [])].some(value => value.id === item.id && value.attachments?.some(file =>
          file.id === id && file.versionId === info.versionId))) return
      await transfers.downloadFile(id, info.versionId)
    },
    startHome: (prompt, submit) => {
      fileAssociations.cancelPreparation()
      tools.cancel()
      cancelConversationNavigation()
      return homeInput.start(prompt, submit)
    },
    addHomeFiles: (files) => { homeInput.add(files) },
    removeHomeFile: (id) => { homeInput.remove(id) },
    cancelHome: () => { homeInput.cancel() },
    assistItem: (item) => {
      fileAssociations.cancelPreparation()
      homeInput.cancel()
      cancelConversationNavigation()
      return assistance.open(item.id, section)
    },
    cancelAssistance: () => { assistance.cancel() },
    importIntegration: input => model.mutate(() => remote.importIntegration(input)),
    loadConnections: () => connectors.load(true),
    loadConnectorActions: id => connectors.loadActions(id),
    readConnectorAction: actionId => connectors.readAction(actionId),
    loadIntegrationPlugins: () => integrationPlugins.load(),
    openCustomization: (target = '') => {
      const view = model.state.getSnapshot().view
      if (view?.customizations?.protocol === 1) customizations.create(target, view.me.name)
    },
    openCustomizationRequests: () => customizations.list(),
    editCustomization: id => customizations.edit(id),
    fieldCustomization: (key, value) => { customizations.field(key, value) },
    saveCustomization: () => customizations.save(),
    moreCustomizations: () => customizations.more(),
    exportCustomization: () => customizations.export(),
    closeCustomization: () => { customizations.close() },
    manageIntegrationPlugin: (adapterId) => {
      const view = integrationPlugins.state.getSnapshot().view
      const entry = view?.packages.find(value => value.adapterId === adapterId)
      if (!entry || view?.mode !== 'local' || !view.managementAvailable) return
      const navigation = ctx.get('pluginNavigation')
      if (!navigation) { model.notify('integrationPluginManagerUnavailable', false); return }
      tools.cancel()
      if (entry.bundle?.availability !== 'missing') navigation.openBundle(entry.packageName)
      else if (navigation.openInstall) navigation.openInstall(entry.packageName)
      else model.notify('integrationPluginManagerUnavailable', false)
    },
    beginConnectorSync: (actionId) => {
      const directory = connectors.state.getSnapshot().catalogue?.view
      if (directory) connectorSync.begin(directory, actionId)
    },
    submitConnectorSync: () => connectorSync.submit(),
    openConnectorSyncHistory: id => connectorSync.open(id),
    moreConnectorSyncHistory: () => connectorSync.more(),
    openConnectorSyncDetail: id => connectorSync.detail(id),
    backConnectorSyncHistory: () => { connectorSync.back() },
    closeConnectorSync: () => { connectorSync.close() },
    openExecutionRecords: id => executions.open(id),
    loadMoreExecutions: () => executions.more(),
    openExecutionDetail: id => executions.detail(id),
    closeExecutionRecords: () => { executions.close() },
    closeExecutionDetail: () => { executions.closeDetail() },
    checkExecutionOutcome: () => executions.check(),
    beginConnectorSubmission: (actionId) => {
      const directory = connectors.state.getSnapshot().catalogue?.view
      const system = model.state.getSnapshot().view?.integrations?.entries.find(entry => entry.id === directory?.integrationId)
      if (directory && system) submissions.begin(directory, system.system, actionId)
    },
    updateSubmissionField: (name, value) => { submissions.field(name, value) },
    reviewSubmission: () => { submissions.review() },
    editSubmission: () => { submissions.edit() },
    submitConnectorAction: () => submissions.submit(),
    closeSubmission: () => { submissions.close() },
    saveConnection: input => connectors.save(input),
    probeConnection: (id, revision) => connectors.probe(id, revision),
    loadTools: () => { void tools.load(conversations.current()); void connectors.load() },
    useTool: (request) => { fileAssociations.cancelPreparation(); return tools.use(request) },
    cancelTool: () => { tools.cancel() },
    setStatus: (item, status) =>
      model.mutate(() => remote.setStatus(item.id, item.revision, status)),
    reply: (item, reply) =>
      model.mutate(() => remote.reply(item.id, item.revision, reply)),
    markRead: id => model.mutate(() => remote.markRead(id)),
    markReminderRead: id => model.mutate(() => remote.markReminderRead(id)),
    publishAnnouncement: input => model.mutate(() => remote.publishAnnouncement(input)),
    markAnnouncementRead: id => model.mutate(() => remote.markAnnouncementRead(id)),
    withdrawAnnouncement: (id, revision) => model.mutate(() => remote.withdrawAnnouncement(id, revision)),
    updateProfile: profile =>
      model.mutate(() => remote.updateProfile(profile)),
    openAudit: () => audits.open(),
    openCollaboration: navigate => { void collaboration.open(navigate) },
    saveMember: (member, expected) =>
      model.mutate(() => remote.saveMember(member, expected)),
    initializeOrganization: revision => model.mutate(() => remote.initializeOrganization(revision)),
    saveOrganizationUnit: input => model.mutate(() => remote.saveOrganizationUnit(input)),
    savePosition: input => model.mutate(() => remote.savePosition(input)),
    assignOrganization: input => model.mutate(() => remote.assignOrganization(input)),
    loadChat: (peer) => {
      void chats.load(peer ?? null)
    },
    olderChat: () => chats.older(),
    sendChat: (peer, text) => {
      if (chats.state.getSnapshot().pending.includes(peer)) return Promise.resolve(false)
      if (fileDrafts.state.getSnapshot().mode === 'durable' &&
        Object.hasOwn(fileDrafts.state.getSnapshot().contacts, peer) && fileDrafts.state.getSnapshot().contacts[peer]?.files.length)
        return fileDrafts.send(peer, text)
      if (Object.hasOwn(chatFiles.state.getSnapshot().contacts, peer) &&
        chatFiles.state.getSnapshot().contacts[peer]?.files.length) return chatFiles.send(peer, text)
      return chats.send(peer, text)
    },
    addChatFiles: (peer, files) => {
      if (fileDrafts.state.getSnapshot().mode === 'local') chatFiles.add(peer, files)
      else fileDrafts.add(peer, files)
    },
    removeChatFile: (peer, id) => {
      if (fileDrafts.state.getSnapshot().mode === 'local') chatFiles.remove(peer, id)
      else fileDrafts.remove(peer, id)
    },
    loadChatFileLimits: () => { void chatFiles.load() },
    loadChatFileDrafts: () => { void fileDrafts.load() },
    retryChatFileDraft: peer => fileDrafts.retry(peer),
    resolveChatFileDraft: (peer, keepLocal) => fileDrafts.resolve(peer, keepLocal),
    clearChatFileDraft: peer => fileDrafts.clear(peer),
    retryChatFileSend: async (peer) => {
      const principal = model.state.getSnapshot().view?.me.id
      const contact = fileDrafts.state.getSnapshot().contacts
      const pending = Object.hasOwn(contact, peer) ? contact[peer]?.pendingSend : null
      if (principal && pending && await fileDrafts.send(peer, pending.text)) chatDrafts.clearFor(principal, peer, pending.text)
    },
    downloadChatFile: (coordinates, expected) => chatFiles.download(coordinates, expected),
    readChat: (peer, through) => chats.read(peer, through),
    setChatDraft: (peer, text) => {
      chatDrafts.set(peer, text)
    },
    clearChatDraft: (peer, expected, principal) => {
      chatDrafts.clearFor(principal, peer, expected)
    },
    retryChatDraft: peer => chatDrafts.retry(peer),
    resolveChatDraft: (peer, keepLocal) => chatDrafts.resolve(peer, keepLocal),
    loadChatDrafts: () => {
      void chatDrafts.load()
    },
    loadDrive: () => {
      void drive.load()
      void transfers.refresh()
      drivePreview.refresh()
      const id = conversations.current()
      if (id) void fileAssociations.load(associationId(id), true)
    },
    useDriveFile: id => fileAssociations.useFile(id),
    cancelFilePreparation: () => { fileAssociations.cancelPreparation() },
    returnToFileConversation: () => {
      fileAssociations.cancelPreparation()
      fileAssociations.endChoosing()
      const target = fileAssociations.state.getSnapshot().conversationId
      const nativeId = ctx.sessions.list.getSnapshot().ids.find(id => String(id) === target)
      if (nativeId) ctx.uiWorkspace.openSession(nativeId)
    },
    retryFileAssociations: () => fileAssociations.retry(),
    navigateDrive: (location) => {
      fileAssociations.cancelPreparation()
      void drive.navigate(location)
    },
    stepDrive: (direction) => {
      fileAssociations.cancelPreparation()
      void drive.step(direction)
    },
    searchDrive: (search) => {
      fileAssociations.cancelPreparation()
      void drive.search(search)
    },
    createDriveFolder: input => drive.createFolder(input),
    renameDriveEntry: input => drive.rename(input),
    saveDrivePermissions: input => drive.permissions(input),
    uploadDriveFile: input => drive.upload(input),
    startDriveUpload: (file, location, ticketId) => transfers.start(file, location, ticketId),
    openDriveHistory: (id) => { driveLifecycle.openHistory(id) },
    openDriveTrash: () => { driveLifecycle.openTrash() },
    closeDriveLifecycle: () => { driveLifecycle.close() },
    refreshDriveLifecycle: () => { void driveLifecycle.refresh() },
    reviewDriveHistory: async () => await driveLifecycle.refresh() ? driveLifecycle.state.getSnapshot().history?.entry ?? null : null,
    changeDriveLifecycle: input => driveLifecycle.change(input),
    openDrivePurge: (id) => { driveLifecycle.openPurge(id) },
    closeDrivePurge: () => { driveLifecycle.closePurge() },
    reviewDrivePurge: () => { void driveLifecycle.reviewPurge() },
    confirmDrivePurge: (retry) => { void driveLifecycle.confirmPurge(retry) },
    startDriveVersionUpload: (file, entry) => transfers.startVersion(file, entry),
    downloadDriveVersion: (id, versionId) => transfers.downloadVersion(id, versionId),
    retryDriveUpload: () => { transfers.retry() },
    reselectDriveUpload: (file) => { transfers.reselect(file) },
    cancelDriveUpload: () => { transfers.cancel() },
    cancelPendingDriveUpload: (id) => { transfers.cancelPending(id) },
    dismissDriveUpload: () => { transfers.dismissUpload() },
    refreshDriveUploads: () => { void transfers.refresh() },
    cancelDriveDownload: () => { transfers.cancelDownload() },
    retryDriveDownload: () => { transfers.retryDownload() },
    dismissDriveDownload: () => { transfers.dismissDownload() },
    previewDriveFile: (id) => { void drivePreview.open(id) },
    closeDrivePreview: () => { drivePreview.close() },
    retryDrivePreview: () => { drivePreview.retry() },
    downloadDriveFile: async (id) => {
      if (drive.state.getSnapshot().view?.transfers) {
        await transfers.downloadFile(id)
        return
      }
      const principal = model.state.getSnapshot().view?.me.id
      const file = await drive.download(id)
      if (!file || model.state.getSnapshot().view?.me.id !== principal) return
      try {
        const bytes = Uint8Array.from(atob(file.dataBase64), character =>
          character.charCodeAt(0),
        )
        if (bytes.byteLength !== file.byteLength)
          throw new Error('Downloaded length mismatch')
        const url = URL.createObjectURL(
          new Blob([bytes], { type: file.mediaType }),
        )
        const link = document.createElement('a')
        link.href = url
        link.download = file.name
        document.body.append(link)
        link.click()
        link.remove()
        setTimeout(() => {
          URL.revokeObjectURL(url)
        }, 1000)
      } catch {
        model.notify('unavailable', false)
      }
    },
    startChat: (prompt, send) => {
      officeInputSurface = true
      tools.cancel()
      homeInput.cancel()
      assistance.cancel()
      cancelConversationNavigation()
      if (send && !prompt.trim()) return
      if (prompt.trim()) {
        ctx.layout.selectPanel(null)
        ctx.uiWorkspace.startSession(undefined, { prompt, submit: send })
      } else ctx.layout.selectPanel(null)
    },
    openNative: () => {
      officeInputSurface = false
      fileAssociations.cancelPreparation()
      fileAssociations.endChoosing()
      tools.cancel()
      homeInput.cancel()
      assistance.cancel()
      cancelConversationNavigation()
      ctx.layout.selectPanel(null)
      ctx.emit('layout/expand-sidebar')
    },
    openAutomations: () => { if (model.state.getSnapshot().view?.automations?.protocol === 1) void automations.open() },
    automationTitle: ctx.locale.bind('officeAutomation')('title'),
    openPlugins: () => {
      tools.cancel()
      ctx.layout.selectPanel('plugins' as MainPanelId)
    },
    dismissNotice: () => {
      model.dismiss()
    },
    signIn: (input) => { audits.close(); memberInvites.close(); return connection.signIn(input) },
    signOut: () => { audits.close(); memberInvites.close(); return connection.signOut() },
    changePassword: input => connection.changePassword(input),
    loadSessions: () => {
      void connection.loadSessions()
    },
    revokeSession: id => connection.revoke(id),
    loadEnrollment: () => {
      void connection.loadEnrollment()
    },
    enrollMember: (id, password) => connection.enroll(id, password),
    openMemberInvites: (memberId) => { memberInvites.open(memberId) },
  })
  ctx.slots.inject('main', function* () {
    const ownedResets = new Set<() => void>()
    for (const section of sections) {
      const registration = {
        name: 'main' as const,
        key: panel(section),
        locale: 'office' as const,
        store: createOfficeViewStore((reset) => { resetPanels.add(reset); ownedResets.add(reset) }),
        inject: () => face(section),
      }
      if (section === 'home') yield ctx.slots.register({ ...registration,
        children: { 'office.home.conversation': { kind: 'single', scope: 'session' }, 'office.home.experience': { kind: 'single', scope: 'root' } },
      }, OfficePage)
      else yield ctx.slots.register(registration, OfficeNonHomePage)
    }
    if (!navigated && ctx.layout.panelInfo.getSnapshot().activePanelId === null) ctx.layout.selectPanel(panel('home'))
    yield () => { for (const reset of ownedResets) resetPanels.delete(reset) }
  })
  ctx.slots.inject('office.home.conversation', () => ctx.slots.register({ name: 'office.home.conversation' }, OfficeHomeConversation))
  ctx.slots.inject('shell.navigation', () =>
    ctx.slots.register(
      {
        name: 'shell.navigation',
        locale: 'office',
        inject: () => face('home'),
      },
      OfficeNavigation,
    ),
  )
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'office.item-context',
    locale: 'office',
    inject: () => ({
      hooks: { assistance: assistance.state, office: model.state },
      returnToItem: (source: OfficeSection, date: string) => {
        assistance.cancel()
        homeInput.cancel()
        ctx.layout.selectPanel(panel(source))
        void model.load(date)
      },
    }),
  }, OfficeItemContext))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'office.associations', order: 100, locale: 'office',
    inject: () => ({
      hooks: { office: model.state, conversations: conversations.state, associations: associations.state,
        tools: tools.state, connectors: connectors.state },
      loadAssociations: (id: OfficeConversationId) => {
        if (id === String(conversations.current())) void associations.load(id)
      },
      loadAssociationCatalog: (id: SessionId) => {
        if (conversations.current() !== id) return
        void tools.load(id)
        void connectors.load()
      },
      saveAssociations: (input: OfficeConversationLinksInput) => associations.save(input),
    }),
  }, OfficeAssociations))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'office.files', order: 110, locale: 'office',
    inject: (): OfficeFileAssociationsInjected => ({
      hooks: { office: model.state, conversations: conversations.state, fileAssociations: fileAssociations.state },
      loadFileAssociations: (id: OfficeConversationId, refresh = false) => {
        if (id === String(conversations.current())) void fileAssociations.load(id, refresh)
      },
      chooseFileAssociations: async (id: OfficeConversationId) => {
        if (id !== String(conversations.current())) return
        if (await fileAssociations.choose(id) && id === String(conversations.current())) ctx.layout.selectPanel(panel('drive'))
      },
      removeFileAssociation: (id: OfficeDriveId | null) => fileAssociations.remove(id),
      retryFileAssociations: () => fileAssociations.retry(),
    }),
  }, OfficeFileAssociations))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'office.customizations', locale: 'office', inject: () => face('integrations'),
  }, OfficeCustomizations))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'office.automations', locale: 'officeAutomation',
    inject: (): OfficeAutomationInjected => ({ hooks: { automations: automations.state, office: model.state },
      closeAutomation: () => { automations.close() },
      createAutomation: () => {
        const systems = model.state.getSnapshot().view?.integrations?.entries ?? []
        const saved = connectors.state.getSnapshot().view?.entries ?? []
        const system = systems.find(value => saved.some(entry => entry.integrationId === value.id &&
          (entry.status === 'unverified' || entry.status === 'connected')))
        if (system) void automations.edit(system.id)
        else model.notify('unavailable', false)
      },
      editAutomation: (rule) => {
        const { ownerId: _owner, ownerRole: _role, createdAt: _created, ...draft } = rule
        void automations.edit(rule.action.integrationId, draft)
      },
      selectAutomationSystem: (id, draft) => automations.edit(id, draft), saveAutomation: draft => automations.save(draft),
      closeAutomationEditor: () => { automations.closeEditor() }, toggleAutomation: rule => automations.toggle(rule),
      triggerAutomationForm: rule => automations.triggerForm(rule), refreshAutomations: () => automations.refresh(),
      reviewAutomation: (id, part) => automations.review(id, part), confirmAutomation: review => automations.confirm(review),
      closeAutomationReview: () => { automations.closeReview() }, manageAutomation: (run, command) => automations.manage(run, command),
      recoverAutomation: (id, part) => automations.recover(id, part),
    }),
  }, OfficeAutomationOverlay))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'office.audit', locale: 'office',
    inject: (): OfficeAuditInjected => ({ hooks: { audit: audits.state },
      closeAudit: () => { audits.close() },
      fieldAudit: (key, value) => { audits.field(key, value) },
      searchAudit: () => audits.search(), moreAudit: () => audits.more(), exportAudit: () => audits.export(),
    }),
  }, OfficeAudit))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'office.memberInvites', locale: 'office',
    inject: (): OfficeMemberInvitesInjected => ({ hooks: { memberInvites: memberInvites.state },
      closeMemberInvites: () => { memberInvites.close() }, refreshMemberInvites: () => { void memberInvites.load() },
      issueMemberInvite: (expiresAt, retry) => memberInvites.issue(expiresAt, retry),
      revokeMemberInvite: () => memberInvites.revoke(), acceptMemberInvite: (code, password) => memberInvites.accept(code, password),
    }),
  }, OfficeMemberInvites))
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'office.toast',
        locale: 'office',
        inject: () => face('home'),
      },
      OfficeToast,
    ),
  )
  ctx.effect(() => {
    void model.load()
    void connection.load()
    const stop = ctx.on('connection/reset', () => {
      memberInvites.close()
      executions.bind(null)
      audits.bind(null)
      connectorSync.bind(null)
      integrationPlugins.bind(null)
      customizations.bind(null)
      submissions.bind(null)
      refreshAssociations()
      void tools.load(conversations.current())
      void connectors.load(true)
      void connection.load()
      void model.load()
      void chats.load()
      void chatDrafts.load()
      void fileDrafts.load()
      void drive.load()
    })
    const changed = ctx.remote.$on('office/changed', () => {
      void model.load()
      void chats.load()
      void fileDrafts.load()
      void drive.load()
    })
    const chatChanged = ctx.remote.$on('office/chat-changed', () => {
      void chats.load()
    })
    const draftsChanged = ctx.remote.$on('office/chat-drafts-changed', () => {
      void chatDrafts.load()
      void fileDrafts.load()
    })
    const driveChanged = ctx.remote.$on('office/drive-changed', () => {
      void drive.load()
    })
    const organizationChanged = ctx.remote.$on('office/organization-changed', () => {
      void model.load()
    })
    const integrationsChanged = ctx.remote.$on('office/integrations-changed', () => {
      refreshAssociations()
      void model.load()
      void connectors.load()
    })
    const pluginsChanged = ctx.remote.$on('plugin-manager/changed', () => {
      if (integrationPlugins.state.getSnapshot().view) void integrationPlugins.load()
      void connectors.load(true)
    })
    const announcementsChanged = ctx.remote.$on('office/announcements-changed', () => {
      void model.load()
    })
    const remindersChanged = ctx.remote.$on('office/reminders-changed', () => {
      void model.load()
    })
    const presetChanged = ctx.remote.$on('agent-preset/selected', (id) => {
      if (tools.state.getSnapshot().sessionId === id) void tools.load(conversations.current())
    })
    const associationsChanged = ctx.remote.$on('office/conversation-links-changed', () => {
      refreshAssociations()
      const id = conversations.current()
      if (id) void fileAssociations.load(associationId(id))
    })
    const flushDrafts = () => {
      if (document.visibilityState === 'hidden') void chatDrafts.flush()
    }
    document.addEventListener('visibilitychange', flushDrafts)
    const poll = setInterval(() => {
      const snapshot = connection.state.getSnapshot()
      if (document.visibilityState !== 'visible' || snapshot.busy) return
      void connection.load()
      if (!snapshot.connection?.connected) return
      if (memberInvites.state.getSnapshot().mode === 'member') void memberInvites.load()
      void model.load()
      void chats.load()
      void chatDrafts.load()
      void fileDrafts.load()
      void drive.load()
      void connectors.load()
      refreshAssociations()
      const id = conversations.current()
      if (id) void fileAssociations.load(associationId(id))
    }, 5000)
    return () => {
      clearInterval(poll)
      presetChanged()
      associationsChanged()
      document.removeEventListener('visibilitychange', flushDrafts)
      driveChanged()
      organizationChanged()
      integrationsChanged()
      pluginsChanged()
      announcementsChanged()
      remindersChanged()
      draftsChanged()
      chatChanged()
      changed()
      stop()
      model.dispose()
      homeInput.dispose()
      inputOwnership.dispose()
      assistance.dispose()
      conversations.dispose()
      chats.dispose()
      chatFiles.dispose()
      fileDrafts.dispose()
      connectors.dispose()
      executions.dispose()
      automations.close()
      audits.dispose()
      connectorSync.dispose()
      integrationPlugins.dispose()
      customizations.dispose()
      submissions.dispose()
      tools.dispose()
      search.dispose()
      associations.dispose()
      fileAssociations.dispose()
      chatDrafts.dispose()
      drive.dispose()
      knowledge.dispose()
      driveLifecycle.dispose()
      transfers.dispose()
      drivePreview.dispose()
      connection.dispose()
      memberInvites.dispose()
    }
  }, 'office.projection')
}
