'use strict';
// One shared E2 engine for the whole backend, using the same database pool as the rest of ecart.
const pool = require('../config/db');
const { PgRepo } = require('./pgRepo');
const { E2Service } = require('./service');
const { createLocalE3 } = require('./e3Local');

module.exports = new E2Service({ repo: new PgRepo(pool), e3: createLocalE3(pool) });
