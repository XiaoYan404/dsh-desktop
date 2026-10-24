/** DingTalk keeps its original private domain identity while sharing provider reservation mechanics. */
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { messageProviderState } from './message-provider.ts'

/** No message text, credential, raw staff id or Native history is retained in this provider unit. */
export const officeDingTalkMessageDomain = defineDomain({ name: 'enterprise_office_dingtalk_messages', version: 1,
  global: { schema: messageProviderState, initial: { entries: [] } }, tables: {} })
export { OfficeMessageProviderRepository as OfficeDingTalkMessageRepository } from './message-provider.ts'
