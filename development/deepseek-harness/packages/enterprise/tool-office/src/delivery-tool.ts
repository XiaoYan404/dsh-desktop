/** Submitted Office deliverables are checked through real parsers before an employee uses the existing work-delivery workflow. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-office'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, validateArgs } from '@deepseek-ai/dsh-tools'
import type { InferArgs, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { OfficeConversationFilesCapture, OfficeDriveId } from '@deepseek-ai/dsh-enterprise-office/types'
import { officeBffRequest, officeToolDriver } from './driver.ts'
import type { OfficeWorkReview } from './work-approval.ts'

/** Read-only verification; accepting the business task remains a separate existing employee action. */
export const CHECK_DELIVERY_TOOL = 'office_check_deliverable'
const parameters = {
  file_id: { type: 'string', required: true, description: 'Exact file_id of the submitted finished document.' },
  template: { type: 'string', enum: ['document', 'spreadsheet', 'presentation', 'pdf'], required: true,
    description: 'Original bundled document, spreadsheet, presentation or PDF workflow recipe.' },
  expected_text: { type: 'array', items: { type: 'string' }, required: true,
    description: 'Required actual document text; at least one independent content assertion. Source text must contain every value.' },
} as const

/**
 * Describe the immutable file and real content checks under the Native read approval policy.
 * @param input - Original tool arguments, without a caller-supplied source body.
 * @param capture - Actual selected file metadata from the human submission.
 * @returns Bilingual review or undefined for an invalid selection.
 */
export function reviewOfficeDelivery(input: unknown, capture: OfficeConversationFilesCapture): OfficeWorkReview | undefined {
  if (validateArgs(parameters, input).length) return undefined
  const args = input as InferArgs<typeof parameters>
  const file = capture.selection.files.find(row => row.id === args.file_id)
  if (!file || !args.expected_text.length) return undefined
  return { en: `Check submitted office deliverable\nFile: ${JSON.stringify(file.name)}\nVersion: ${JSON.stringify(file.versionId)}\nSHA-256: ${file.sha256}\nRequired text: ${JSON.stringify(args.expected_text)}`,
    zh: `检查已提交的办公交付文件\n文件：${JSON.stringify(file.name)}\n版本：${JSON.stringify(file.versionId)}\nSHA-256：${file.sha256}\n必需正文：${JSON.stringify(args.expected_text)}` }
}

/**
 * Construct the optional Native checker without replacing document authoring, present or task acceptance.
 * @param ctx - Exact live Native plugin scope and authenticated Office BFF.
 * @param capture - Immutable submitted coordinates; every execution rereads current authority.
 * @param lifetime - Owning plugin lifetime.
 * @returns A real structural/content tool result, logged through the original Native pipeline.
 */
export function officeDeliveryTool(ctx: Context, capture: OfficeConversationFilesCapture, lifetime: AbortSignal): ToolDefinition {
  return defineTool({ name: CHECK_DELIVERY_TOOL,
    description: 'Check an actual submitted DOCX, XLSX, PPTX or PDF output with the original bounded document parsers. '
      + 'Use an exact file_id and required document text from the employee request. A renamed text file cannot pass. '
      + 'This checks real structure and content, not visual layout, formula recalculation, external delivery or business acceptance. '
      + 'Use the existing Office skills for authoring, present for Native delivery, and explicit Drive/work actions for company delivery.',
    parameters,
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      result_json: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: value.result_json }] },
    async execute(args, exec) {
      officeToolDriver(ctx, exec, capture, lifetime)
      const result = await officeBffRequest(() => ctx.officeController.checkConversationDeliverable({
        captureId: capture.id, fileId: args.file_id as OfficeDriveId, template: args.template, expectedText: args.expected_text,
      }, AbortSignal.any([lifetime, exec.signal])))
      officeToolDriver(ctx, exec, capture, lifetime)
      if (!result.ok) throw new HarnessError(`Office deliverable was not verified (${result.code}).`, 'OFFICE_DELIVERY_CHECK_DENIED')
      return { result_json: JSON.stringify(result.value) }
    }, presentCall: args => ({ card: 'generic', title: 'Check office deliverable', kind: 'read', rawInput: args }),
  })
}
