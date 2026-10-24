/** Private messaging has its own durable unit and never adds messages to Agent Session logs. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import type {
  OfficeChatMessage,
  OfficeChatPeer,
  OfficeChatView,
  OfficeMember,
  OfficeMemberId,
  OfficeMessageId,
} from './types.ts'

const messageId = z.uuid().transform(value => brandString<OfficeMessageId>(value))
const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.number().int().nonnegative()
const text = z
  .string()
  .max(16_000)
  .refine(value => value.trim().length > 0, 'A message must contain text')

/** Validate the retry identity, recipient and original text without removing formatting. */
export const officeChatInput = z.object({ id: messageId, recipientId: officeMemberId, text }).strict()

const message = z
  .object({
    id: messageId,
    sequence,
    senderId: officeMemberId,
    recipientId: officeMemberId,
    senderName: z.string().min(1).max(100),
    recipientName: z.string().min(1).max(100),
    text,
    createdAt: timestamp,
  })
  .refine(value => value.senderId !== value.recipientId, 'A private message needs two distinct members')
const receipt = z.object({ readerId: officeMemberId, peerId: officeMemberId, through: sequence, readAt: timestamp })
const state = z
  .object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    messages: z.array(message).readonly(),
    receipts: z.array(receipt).readonly(),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.messages.map(entry => entry.id)).size !== value.messages.length ||
      new Set(value.receipts.map(entry => `${entry.readerId}:${entry.peerId}`)).size !== value.receipts.length ||
      value.messages.some(
        (entry, index) =>
          entry.sequence > value.revision ||
          (index > 0 && entry.sequence <= (value.messages.at(index - 1)?.sequence ?? 0)),
      )
    ) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate or unordered chat identities' })
    }
    if (
      value.receipts.some(
        entry =>
          !value.messages.some(
            item => item.sequence === entry.through && inConversation(item, entry.readerId, entry.peerId),
          ),
      )
    ) {
      ctx.addIssue({ code: 'custom', message: 'Read receipt does not reference its own conversation' })
    }
  })

/** Authoritative chat unit, stored separately from office work and Agent histories. */
export const officeChatDomain = defineDomain({
  name: 'enterprise_office_chat',
  version: 1,
  global: { schema: state, initial: { revision: 0, messages: [], receipts: [] } },
  tables: {},
})

/** Internal state admitted at the durable boundary. Never return it through a Remote. */
export type OfficeChatState = z.infer<typeof state>

/**
 * Check whether a message belongs to exactly this pair; administrators get no private-history bypass.
 * @param message - Stored message.
 * @param actor - Current authenticated employee.
 * @param peer - Other participant.
 * @returns Whether both endpoints match the requested pair.
 */
export function inConversation(message: OfficeChatMessage, actor: OfficeMemberId, peer: OfficeMemberId): boolean {
  return (
    (message.senderId === actor && message.recipientId === peer) ||
    (message.senderId === peer && message.recipientId === actor)
  )
}

/**
 * Project only one employee's threads and an optional page of one private conversation.
 * @param state - Confirmed chat unit.
 * @param me - Active employee checked by the office service.
 * @param members - Retained directory used only for active peer names.
 * @param peerId - Optional conversation to open.
 * @param before - Exclusive message sequence for older history.
 * @param knownPeer - Optional contact independently authorized through this employee's retained private draft.
 * @returns Safe private projection; missing or inaccessible peers share one denial.
 */
export function projectChat(
  state: OfficeChatState,
  me: OfficeMember,
  members: readonly OfficeMember[],
  peerId?: OfficeMemberId,
  before?: number,
  knownPeer?: OfficeChatPeer,
): OfficeChatView {
  if ((before !== undefined && (!sequence.safeParse(before).success || peerId === undefined)) || peerId === me.id)
    throw new OfficeError('invalid_input', 'Invalid conversation or history cursor')
  const own = state.messages.filter(entry => entry.senderId === me.id || entry.recipientId === me.id)
  const peers = new Map<OfficeMemberId, OfficeChatMessage[]>()
  for (const entry of own) {
    const id = entry.senderId === me.id ? entry.recipientId : entry.senderId
    const thread = peers.get(id) ?? []
    thread.push(entry)
    peers.set(id, thread)
  }
  const through = (reader: OfficeMemberId, peer: OfficeMemberId) =>
    state.receipts.find(entry => entry.readerId === reader && entry.peerId === peer)?.through ?? 0
  const peer = (id: OfficeMemberId, latest?: OfficeChatMessage): OfficeChatPeer => {
    const active = members.find(entry => entry.id === id && entry.active)
    if (active) return { id, name: active.name, active: true }
    if (!latest && knownPeer?.id === id) return knownPeer
    if (!latest) throw new OfficeError('not_found', 'Conversation is unavailable')
    return { id, name: latest.senderId === id ? latest.senderName : latest.recipientName, active: false }
  }
  const threads = [...peers.entries()]
    .map(([id, messages]) => {
      const latest = messages.at(-1)
      if (!latest) throw new OfficeError('not_found', 'Conversation is unavailable')
      return {
        peer: peer(id, latest),
        latest,
        unread: messages.filter(entry => entry.recipientId === me.id && entry.sequence > through(me.id, id)).length,
      }
    })
    .sort((a, b) => b.latest.sequence - a.latest.sequence)
  const conversation = peerId ? (peers.get(peerId) ?? []) : []
  const eligible = conversation.filter(entry => before === undefined || entry.sequence < before)
  return {
    revision: state.revision,
    meId: me.id,
    threads,
    peer: peerId ? peer(peerId, conversation.at(-1)) : null,
    messages: eligible.slice(-100),
    hasMore: eligible.length > 100,
    readThrough: peerId ? through(me.id, peerId) : 0,
    peerReadThrough: peerId ? through(peerId, me.id) : 0,
  }
}
