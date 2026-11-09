// Read-only migration advice. Native session IDs and saved settings are never rewritten here.
import { RETIRED_DRIVERS as replacements } from './builtin.mjs';
export function executorMigration({ execution, tickets = [], coordinator, child } = {}) {
  const target = replacements[execution?.driver] ?? null;
  const affected = tickets.filter(ticket => !ticket.ended && replacements[ticket.executionConfig?.driver ?? ticket.driverSession?.driver ?? ((ticket.runId || ticket.driverSession) ? execution?.driver : null)])
    .map(ticket => ({ id: ticket.id, driver: ticket.executionConfig?.driver ?? ticket.driverSession?.driver ?? execution?.driver, action: 'replace-session' }));
  const coordinatorChange = replacements[coordinator?.driver] ? { driver: coordinator.driver, action: 'reconfigure-coordinator' } : null;
  const childChange = replacements[child?.driver] ? { driver: child.driver, action: 'reconfigure-jobs' } : null;
  return { required: !!target || !!affected.length || !!coordinatorChange || !!childChange,
    from: execution?.driver ?? null, target, tickets: affected, coordinator: coordinatorChange, child: childChange };
}
