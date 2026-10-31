'use strict';
// Tunable constants. The handbook does not fix these values, so they are defaults:
// agree them with your team and write the final numbers in Section 4.18.
module.exports = {
  speedKmph: 40,            // average delivery speed, converts km -> minutes
  workloadMinPerOrder: 2,   // extra ETA minutes per pending order at a warehouse
  costPerKm: 1,             // shipping cost per km
  splitPenalty: 50,         // extra cost for every additional shipment in a split order
  weights: { eta: 0.4, cost: 0.3, workload: 0.3 }, // Regular ranking (lower score is better)
  maxParts: 3,              // an order may be split across at most 3 warehouses
  topN: 3,                  // number of plans kept for failover
  maxRetries: 1,            // pick/pack is retried once before reallocating
  maxRounds: 2,             // initial planning + one re-evaluation if all 3 plans fail
  // Route rows are one per direction. "customer_to_warehouse" follows the handbook wording
  // (search from the customer's region); use "warehouse_to_customer" for the true delivery direction.
  routeDirection: 'customer_to_warehouse',
};
