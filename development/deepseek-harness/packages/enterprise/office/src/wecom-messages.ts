/** WeCom messages retain original operation outcomes separately from other providers. */
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { messageProviderState } from './message-provider.ts'

/** Provider-owned reservations never retain message text, raw recipient ids or credentials. */
export const officeWeComMessageDomain = defineDomain({ name: 'enterprise_office_wecom_messages', version: 1,
  global: { schema: messageProviderState, initial: { entries: [] } }, tables: {} })
