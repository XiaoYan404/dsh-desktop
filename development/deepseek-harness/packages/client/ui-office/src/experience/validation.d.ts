import type { OfficeAppearance, OfficeAssistant, OfficeExperienceDocument } from './types.ts';
/** Reject credential-bearing, local-only, or non-HTTPS phone links.
 * @param value - Deployment address, without credentials, query or fragment.
 * @returns A canonical HTTPS address or the empty unconfigured value.
 */
export declare function mobileAddress(value: string): string;
/** @returns Default office-only appearance; the user's native theme remains inherited. */
export declare function officeAppearanceDefaults(): OfficeAppearance;
/** @param value - Untrusted appearance input. @returns Validated, canonical values. */
export declare function parseOfficeAppearance(value: unknown): OfficeAppearance;
/** @param value - Untrusted assistant fields. @returns Validated assistant. */
export declare function parseOfficeAssistant(value: unknown): OfficeAssistant;
/** @param value - Untrusted durable JSON. @returns Validated current document; no predecessor fallback. */
export declare function parseOfficeExperienceDocument(value: unknown): OfficeExperienceDocument;
/** @param text - UTF-8 JSON export, limited before parsing. @returns An assistant without adopting its exported identity. */
export declare function importOfficeAssistant(text: string): OfficeAssistant;
/** @param assistant - Validated saved assistant. @returns A portable configuration without credentials or Session history. */
export declare function exportOfficeAssistant(assistant: OfficeAssistant): string;
//# sourceMappingURL=validation.d.ts.map