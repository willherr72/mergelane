export const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const;
export type GroupColor = typeof COLORS[number];
export type ConditionKind = 'label' | 'feedback' | 'approval' | 'changes' | 'draft';
export interface Condition { kind: ConditionKind; value?: string; negate: boolean }
export interface Category { id: string; name: string; color: GroupColor; enabled: boolean; fallback: boolean; mode: 'all' | 'any'; conditions: Condition[] }
export interface OwnerConnection { owner: string; token: string }
export interface Settings { version: 1; enabled: boolean; token: string; connections: OwnerConnection[]; ignoredLogins: string[]; categories: Category[]; priority: string[] }
export const hasCredentials = (settings: Settings): boolean => !!settings.token || settings.connections.some(c => !!c.token);
export interface PrRef { owner: string; repo: string; number: number; key: string }
export interface Actor { login: string; type: string }
export interface PrDetails { state: string; merged: boolean; closed_at: string | null; draft: boolean; user: Actor | null; labels: { name: string }[]; title?: string }
export interface Comment { user: Actor | null }
export interface Review extends Comment { id: number; state: string; submitted_at: string | null }
export interface Snapshot { details: PrDetails; comments: Comment[]; reviewComments: Comment[]; reviews: Review[] }
export interface Facts { labels: string[]; feedback: boolean; approval: boolean; changes: boolean; draft: boolean }
export interface Ownership { groups: Record<string, number>; tabs: Record<string, { key: string; categoryId: string }> }
export interface RunStatus { checkedAt: number | null; attemptedAt: number | null; counts: Record<string, number>; errors: { pr: string; message: string }[]; tracked: number; closed: number; retryAt: number | null; running: boolean }
export const emptyOwnership = (): Ownership => ({ groups: {}, tabs: {} });
export const emptyStatus = (): RunStatus => ({ checkedAt: null, attemptedAt: null, counts: {}, errors: [], tracked: 0, closed: 0, retryAt: null, running: false });
