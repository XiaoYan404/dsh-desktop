/** Unsent private text has its own versioned unit, independent of sent message history. */
import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { officeMemberId } from './spec.ts'

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** A client can update only a contact's reviewed draft version, with an idempotent retry id. */
export const officeChatDraftInput = z
  .object({
    peerId: officeMemberId,
    text: z.string().max(16_000),
    revision,
    requestId: z.uuid(),
  })
  .strict()

const draft = z
  .object({
    ownerId: officeMemberId,
    peerId: officeMemberId,
    text: z.string().max(16_000),
    revision: revision.refine(value => value > 0),
    requestId: z.uuid(),
  })
  .strict()
  .refine(value => value.ownerId !== value.peerId)
const state = z
  .object({ drafts: z.array(draft).readonly() })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.drafts.map(entry => `${entry.ownerId}:${entry.peerId}`)).size !== value.drafts.length) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate private draft identity' })
    }
  })

/** Version tombstones prevent a stale window from resurrecting a cleared draft. */
export const officeChatDraftDomain = defineDomain({
  name: 'enterprise_office_chat_drafts',
  version: 1,
  global: { schema: state, initial: { drafts: [] } },
  tables: {},
})
