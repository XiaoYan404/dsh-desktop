/** Session artifact collection from raw JSONL directories or a live persistence observer. */
import { type SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
/** One collected Session artifact and its immutable identifying metadata. */
export interface HarvestedLog {
    /** Recorded Session identity from its header. */
    id: string;
    /** Creation time used to order children. */
    createdAt: number;
    /** Parent identity when the Session is a subagent child. */
    parentSession?: string;
    /** Original raw JSONL bytes as text, or a current-format artifact encoded from a service read. */
    content: string;
}
/** Read-only operations needed from a separately owned persistence observer. */
export type SessionLogPersistence = Pick<SessionPersistence, 'list' | 'open'>;
/** A raw JSONL sessions root or a live observer containing only this scenario's Sessions. */
export type SessionLogSource = string | SessionLogPersistence;
/**
 * Collect complete Session artifacts, primary first, then children by creation time and identity.
 * Directory reads retain exact raw bytes and select the highest canonical physical generation.
 * Service reads require the provider's typed current logical header and events, then encode that
 * generation; they never flush writers, acquire write ownership, or fall back after a service failure.
 * Every opened read handle is closed, including when reading or encoding fails. Concurrent read
 * and close failures are retained in an AggregateError. The caller owns the observer's lifetime
 * and isolates its store; collection does not discover or select another backend or store.
 * @param source - Raw JSONL sessions root, or a live scenario-specific persistence observer.
 * @returns Complete artifacts ordered consistently with replay's child fixture order.
 */
export declare function harvestSessionLogs(source: SessionLogSource): Promise<HarvestedLog[]>;
//# sourceMappingURL=harvest.d.ts.map