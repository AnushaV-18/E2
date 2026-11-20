'use strict';
// One shared scheduler for the whole backend.
const { OrderScheduler } = require('./scheduler');
module.exports = new OrderScheduler();
