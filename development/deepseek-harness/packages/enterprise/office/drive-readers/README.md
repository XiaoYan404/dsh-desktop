# Drive images, knowledge and Office delivery checks

English | [中文](README.zh.md)

This reference covers the optional Drive readers and their current authorization. [Native Office tools](../../tool-office/README.md) own approval and Session logging; the [original Office skills](../../../skill/skill-office/README.md) own document authoring.

## Images

Omitting `imageRead` disables image reads and their advertised capability. Enabled deployments provide every source-byte, intrinsic-pixel, per-side, complete-response and MIME limit. The complete UTF-8 success envelope, including metadata and base64, cannot exceed 16 MiB. A source within its encoded-byte limit can still exceed the response limit after base64 expansion.

The employee Host prepares a metadata-only capability hint under the current connection, member and role before synchronous inbox registration. A hint grants no source access. The Native consumer requires its independent `image: true` switch, a positive safe integer `imageMaxNormalizedResultBytes`, a durable attachment provider and the model service. Model image input is resolved again before requesting source bytes. The original manual `readApproval` remains the default.

Every read and final recheck verifies the authenticated session, captured member/role, selected file, current ancestor permissions, latest version, byte length and digest. Source admission and Native normalization have independent limits. Animated input represents the first normalized frame. The actual immutable attachment reference is published as an original Native ImageBlock and tool result.

Started Sharp and `saveImage` operations must settle before cancellation can reject publication; neither has a per-call immediate abort or a process RSS guarantee. A final denial can leave an unreachable immutable attachment under existing retention. Earlier legally disclosed image blocks and Session history are retained after later Drive revocation.

## Knowledge

Omitting `knowledge` disables its domain and APIs. An enabled policy supplies `maxDocuments`, `maxIndexBytes`, `maxSourceBytes`, `maxDocumentCharacters`, `maxSections`, `chunkCharacters`, `maxChunksPerDocument`, `maxResults`, `maxResponseBytes` and `timeoutMs`. The index uses the additive `enterprise_office_knowledge` domain without changing Drive or Session generations.

Current administrators and managers publish an exact authorized Drive version with a reviewed publication revision and stable request UUID. Replacements update only that file's current index. The existing bounded workers parse selectable PDF pages, DOCX body text, saved XLSX cells and configured PPTX slide text; UTF-8 text remains plain data. XLSX formulas are retained as saved evidence and are never recalculated. Images, OCR and legacy DOC/XLS are unsupported.

Search matches literal normalized query terms. Only currently authorized, latest source versions contribute text, result counts or `hasMore`. Citations include file/version/digest, publication revision, chunk and source position; reopening repeats authorization. Deleted, revoked, withdrawn and superseded sources do not return indexed text. Withdrawal removes the current indexed body. Inaccessible or outdated index records are filtered rather than automatically physically erased; storage retention remains backend-owned.

The employee Drive page supports search, current citation reads and explicit publication review. Native knowledge tools are independently opt-in and scoped to turns carrying submitted file context; they do not enable unrestricted library tools in an otherwise unassociated Native conversation. Complete-response limits include both the HTTP success envelope and escaped Native text blocks. The Client clears private results on identity, role or capability withdrawal and retains the same UUID when a publication acknowledgement is uncertain.

The knowledge GUI distinguishes an untouched query, a running query and a completed empty result; Enter during an input-method composition does not submit. Search drafts reset when the employee or role changes. Long source names wrap and text regions scroll by keyboard. The citation download action selects its exact immutable version through the existing authorized version downloader.

Results name their submitted query even while the employee edits a newer unsent draft. Query failures have a separate Retry action that resubmits those original terms without publishing a document or replacing the draft. An unconfirmed publication keeps its own notice and recovery action during a later query; read failures cannot replace its status or its original mutation UUID. In-flight writes remain distinct from unknown write outcomes.

Closing a publication review dismisses its dialog. A closed read review cannot reopen from a late reply. Closing during a write does not cancel that write: an uncertain outcome retains its original file, operation, revision and UUID behind an explicit Retry action, even if the Drive selection changes. A confirmed index mutation invalidates prior search results without claiming that the old query has no matches.

## Office delivery

The existing document, spreadsheet, presentation and PDF request recipes retain their original Office skills. `templateSource` identifies the selected bundled workflow, not an attestation of the document's author. No imported sixteen-template library is claimed.

Omitting `deliveryChecks` keeps checking disabled. Enabled deployments provide `maxSourceBytes`, `maxDocumentCharacters`, `maxSections`, `timeoutMs`, `maxResultBytes`, `maxExpectedTexts` and `maxExpectedTextCharacters`. The Native `deliveries` switch independently enables `office_check_deliverable` under the original read approval. It reads one exact submitted file and uses the same parsers to verify actual DOCX/XLSX/PPTX/PDF structure and required document text. Renamed plain text and missing assertions are rejected. Results explicitly say `structure_and_text` and `visualLayout: not_checked`; formula recalculation, rendering fidelity and business acceptance are not inferred.

Author and present files through the original Office skills and Native delivery mechanism. Company delivery uses explicit Drive upload, reviewed immutable work attachments, employee submission and reviewer acceptance. Existing previews and authorized downloads retain their owners. There is no automatic foreign key or synchronization from Native deliverables to Drive, and a structural check alone does not complete a work item.
