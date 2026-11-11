import { hasCredentials, type Settings } from './model';
import { validateSettings } from './settings';

// Operational state is changed only by explicit controls, never by saving an
// old copy of the category editor. All actions apply to the persisted state.
export function applySettingsAction(current: Settings, action: Record<string, unknown>): Settings {
  switch (action.type) {
    case 'saveSettings': {
      if (!action.settings || typeof action.settings !== 'object') throw new Error('Invalid settings.');
      return validateSettings({ ...action.settings, token: current.token, connections: current.connections, enabled: current.enabled });
    }
    case 'setEnabled': {
      if (typeof action.enabled !== 'boolean') throw new Error('Invalid enabled state.');
      if (action.enabled && !hasCredentials(current)) throw new Error('Connect a GitHub token before enabling MergeLane.');
      return { ...current, enabled: action.enabled };
    }
    case 'disconnect': return { ...current, token: '', connections: [], enabled: false };
    case 'removeConnection': {
      if (typeof action.owner !== 'string') throw new Error('Choose an owner to disconnect.');
      const next = { ...current, token: action.owner ? current.token : '', connections: current.connections.filter(c => c.owner.toLowerCase() !== String(action.owner).toLowerCase()) };
      return { ...next, enabled: next.enabled && hasCredentials(next) };
    }
    case 'setToken': {
      if (typeof action.token !== 'string' || !action.token.trim() || action.token.length > 1000) throw new Error('Enter a valid GitHub token.');
      const owner = typeof action.owner === 'string' ? action.owner.trim() : '';
      const exists = owner ? current.connections.some(c => c.owner.toLowerCase() === owner.toLowerCase()) : !!current.token;
      if (action.mode === 'add' && !owner) throw new Error('Enter the organization or account to connect.');
      if (action.mode === 'add' && exists) throw new Error('This owner already has a connection. Choose Replace token on its saved connection.');
      if (action.mode === 'replace' && !exists) throw new Error('This connection was removed. Use Add connection to connect it again.');
      if (!owner) return { ...current, token: action.token.trim() };
      const connection = { owner, token: action.token.trim() };
      const connections = [...current.connections];
      const index = connections.findIndex(c => c.owner.toLowerCase() === owner.toLowerCase());
      if (index < 0) connections.push(connection); else connections[index] = connection;
      return validateSettings({ ...current, connections });
    }
    default: throw new Error('Unknown settings action.');
  }
}
