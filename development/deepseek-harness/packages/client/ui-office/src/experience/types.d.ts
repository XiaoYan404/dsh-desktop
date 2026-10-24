/** Account-scoped office configuration; native Sessions retain their own history and permissions. */
import type { Branded } from '@deepseek-ai/dsh-brand';
/** UUID minted by the Host after validating a new assistant. */
export type OfficeAssistantId = Branded<'OfficeAssistantId'>;
export type OfficeScene = 'sales' | 'documents' | 'presentations' | 'knowledge' | 'quotes' | 'projects';
/** Offline brand choices select semantic theme aliases, never remote assets. */
export interface OfficeAppearance {
    readonly companyName: string;
    readonly monogram: string;
    readonly brand: 'default' | 'blue' | 'green' | 'violet';
    readonly scheme: 'inherit' | 'light' | 'dark';
    readonly density: 'comfortable' | 'compact';
    readonly mobileUrl: string;
}
/** A saved assistant clones a real installed composition and prepares an unsent native draft. */
export interface OfficeAssistant {
    readonly id: OfficeAssistantId;
    readonly name: string;
    readonly scene: OfficeScene;
    readonly basePreset: string;
    readonly instructions: string;
}
/** Reviewed fields; null identity creates a separate native assistant. */
export interface OfficeAssistantInput {
    readonly id: OfficeAssistantId | null;
    readonly name: string;
    readonly scene: OfficeScene;
    readonly basePreset: string;
    readonly instructions: string;
}
/** One profile's committed, versioned configuration. */
export interface OfficeExperienceDocument {
    readonly format: 1;
    readonly revision: number;
    readonly accounts: readonly {
        readonly principal: string;
        readonly appearance: OfficeAppearance;
        readonly assistants: readonly OfficeAssistant[];
    }[];
}
/** A registry observation never represents tool authorization or completed work. */
export interface OfficeExperienceView {
    readonly revision: number;
    readonly appearance: OfficeAppearance;
    readonly assistants: readonly (OfficeAssistant & {
        readonly presetId: string;
        readonly available: boolean;
    })[];
    readonly presets: readonly {
        readonly id: string;
        readonly name: string;
        readonly available: boolean;
    }[];
}
/** Stable failures mapped to typed locale copy by the Client. */
export type OfficeExperienceErrorCode = 'invalid' | 'conflict' | 'unauthenticated' | 'unavailable' | 'not_found';
/** Stable BFF failures never contain file paths, YAML, credentials or raw backend errors. */
export type ExperienceOutcome<T> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly code: OfficeExperienceErrorCode;
};
//# sourceMappingURL=types.d.ts.map