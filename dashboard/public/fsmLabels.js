/**
 * Display names for companion states. Keys stay the state ids.
 * Unknown ids are shown as-is so a new state is visible before it is translated.
 */

export function stateLabel(fsmStates, id) {
  return fsmStates?.[id]?.label || id;
}

export function stateNote(fsmStates, fsm, id) {
  if (id === 'normal' && fsm?.preferredMode) {
    return `${stateLabel(fsmStates, fsm.preferredMode)}モードの動き`;
  }
  return fsmStates?.[id]?.note ?? id;
}
