/** Process-local image capability hints contain metadata only and never authorize a source read. */
import type { OfficeConversationFilesCapture, OfficeConversationFilesView, OfficeConversationFileLimits } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConnection } from './types.ts'

/** One authenticated connection's most recently prepared capability; execution always rereads authority. */
export class OfficeImageAdmissions {
  private value: { readonly memberId: string; readonly role: string; readonly image: NonNullable<OfficeConversationFileLimits['image']> } | undefined
  private epoch = 0

  /** Current epoch captured before awaiting preparation or a connection check. */
  get generation(): number { return this.epoch }

  /** Withdraw hints before sign-in/out, password/session changes and controller disposal. */
  clear(): void { this.epoch++; this.value = undefined }

  /**
   * Drop a hint when a fresh connection observes identity withdrawal or replacement.
   * @param connection - Fresh Host-owned current connection, or null after a failed lookup.
   */
  observe(connection: OfficeConnection | null): void {
    const member = connection?.connected ? connection.member : null
    if (!member?.active || this.value && (this.value.memberId !== member.id || this.value.role !== member.role)) this.clear()
  }

  /**
   * Publish only the capability verified during the original asynchronous Host preparation.
   * @param generation - Epoch captured before the awaited connection lookup.
   * @param connection - Fresh sanitized current connection, never browser input.
   * @param capture - Exact submitted file attribution.
   * @param view - Authenticated source capability and matching employee/role.
   * @returns True when a raster capability was published for this employee.
   */
  prepare(generation: number, connection: OfficeConnection, capture: OfficeConversationFilesCapture,
    view: OfficeConversationFilesView): boolean {
    if (generation !== this.epoch) return false
    const member = connection.connected ? connection.member : null
    if (!member?.active || member.id !== capture.memberId || member.role !== capture.role
      || view.meId !== member.id || view.role !== member.role || view.conversationId !== capture.selection.conversationId) {
      this.clear()
      return false
    }
    const image = view.limits.image
    this.value = image?.protocol === 1 ? { memberId: member.id, role: member.role,
      image: { ...image, mediaTypes: [...image.mediaTypes] } } : undefined
    return this.value !== undefined
  }

  /**
   * Obtain a synchronous schema-admission hint; it conveys no permission to read source bytes.
   * @param capture - Actual claimed submission, checked against the prepared identity and role.
   * @returns The last prepared limits, or undefined for an unknown/withdrawn/different identity.
   */
  forCapture(capture: OfficeConversationFilesCapture): OfficeConversationFileLimits['image'] {
    return this.value?.memberId === capture.memberId && this.value.role === capture.role ? this.value.image : undefined
  }
}
