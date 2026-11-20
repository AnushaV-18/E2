'use strict';
// Ready queue: Plus orders are served before Regular orders; first-come-first-served inside each tier.
class ReadyQueue {
  constructor() { this.tiers = { PLUS: [], REGULAR: [] }; }
  get size() { return this.tiers.PLUS.length + this.tiers.REGULAR.length; }
  push(item) { this.tiers[item.task.tier].push(item); }
  pushFront(item) { this.tiers[item.task.tier].unshift(item); }
  // Remove and return the first item (Plus first) for which canRun(item) is true, else null.
  takeFirst(canRun) {
    for (const tier of ['PLUS', 'REGULAR']) {
      const q = this.tiers[tier];
      const i = q.findIndex(canRun);
      if (i !== -1) return q.splice(i, 1)[0];
    }
    return null;
  }
}
module.exports = { ReadyQueue };
