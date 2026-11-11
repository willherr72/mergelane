import type { Actor, Facts, PrDetails, Settings, Snapshot } from './model';

export function deriveFacts(snapshot: Snapshot, ignoredLogins: string[]): Facts {
  const ignored = new Set(ignoredLogins.map(s => s.toLowerCase()));
  const author = snapshot.details.user?.login.toLowerCase();
  const human = (actor: Actor | null): boolean => !!actor && actor.type === 'User' && !!actor.login && actor.login.toLowerCase() !== author && !actor.login.toLowerCase().endsWith('[bot]') && !ignored.has(actor.login.toLowerCase());
  const reviews = snapshot.reviews.filter(r => human(r.user) && r.state !== 'PENDING' && r.submitted_at && Number.isFinite(Date.parse(r.submitted_at))).sort((a, b) => Date.parse(a.submitted_at!) - Date.parse(b.submitted_at!) || a.id - b.id);
  const decisive = new Map<string, string>();
  for (const review of reviews) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) decisive.set(review.user!.login.toLowerCase(), review.state);
  const changes = [...decisive.values()].includes('CHANGES_REQUESTED');
  return {
    labels: snapshot.details.labels.map(l => l.name.toLowerCase()), draft: snapshot.details.draft,
    feedback: [...snapshot.comments, ...snapshot.reviewComments].some(c => human(c.user)) || reviews.length > 0,
    approval: !changes && [...decisive.values()].includes('APPROVED'), changes,
  };
}

export function classify(facts: Facts, settings: Settings): string {
  for (const id of settings.priority) {
    const category = settings.categories.find(c => c.id === id);
    if (!category?.enabled || category.fallback) continue;
    const matches = category.conditions.map(rule => {
      const result = rule.kind === 'label' ? facts.labels.some(l => l.toLowerCase() === rule.value!.toLowerCase()) : facts[rule.kind];
      return rule.negate ? !result : result;
    });
    if (matches.length && (category.mode === 'all' ? matches.every(Boolean) : matches.some(Boolean))) return id;
  }
  return settings.categories.find(c => c.fallback)!.id;
}

export function shouldClose(details: PrDetails, now: number): boolean {
  if (details.state !== 'closed') return false;
  if (details.merged === true) return true;
  if (details.merged !== false || !details.closed_at) return false;
  const time = Date.parse(details.closed_at);
  return Number.isFinite(time) && now - time > 60 * 60 * 1000;
}
