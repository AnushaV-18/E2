'use strict';
// Fulfilment stage machine for one warehouse part: ALLOCATED -> PICKED -> PACKED -> SHIPPED (FAILED on pick/pack failure).
const NEXT = { ALLOCATED: 'PICKED', PICKED: 'PACKED', PACKED: 'SHIPPED' };
const FAILURE_STAGES = new Set(['ALLOCATED', 'PICKED']); // a failing pick happens in ALLOCATED, a failing pack in PICKED
const LOCKED = new Set(['PACKED', 'SHIPPED']);

function checkTransition(current, requested) {
  if (NEXT[current] === requested) return { ok: true };
  return { ok: false, error: `invalid stage change ${current} -> ${requested}` };
}
const failureAllowed = (current) => FAILURE_STAGES.has(current);
// Reallocation is blocked once any (non-failed) part is packed or shipped.
const canReallocate = (partStages) => !partStages.some((s) => LOCKED.has(s));
const allShipped = (partStages) => partStages.length > 0 && partStages.every((s) => s === 'SHIPPED');

module.exports = { checkTransition, failureAllowed, canReallocate, allShipped };
