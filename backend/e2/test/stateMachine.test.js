'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sm = require('../stateMachine');

test('stages only move forward one step at a time', () => {
  assert.equal(sm.checkTransition('ALLOCATED', 'PICKED').ok, true);
  assert.equal(sm.checkTransition('PICKED', 'PACKED').ok, true);
  assert.equal(sm.checkTransition('PACKED', 'SHIPPED').ok, true);
  assert.equal(sm.checkTransition('ALLOCATED', 'PACKED').ok, false); // skipping
  assert.equal(sm.checkTransition('PACKED', 'PICKED').ok, false);    // going back
  assert.equal(sm.checkTransition('SHIPPED', 'SHIPPED').ok, false);
});

test('pick/pack failure is only allowed before PACKED', () => {
  assert.equal(sm.failureAllowed('ALLOCATED'), true);
  assert.equal(sm.failureAllowed('PICKED'), true);
  assert.equal(sm.failureAllowed('PACKED'), false);
  assert.equal(sm.failureAllowed('SHIPPED'), false);
});

test('reallocation is blocked once any part is packed or shipped', () => {
  assert.equal(sm.canReallocate(['ALLOCATED', 'PICKED']), true);
  assert.equal(sm.canReallocate(['ALLOCATED', 'PACKED']), false);
  assert.equal(sm.canReallocate(['SHIPPED']), false);
});

test('order is shipped only when every part has shipped', () => {
  assert.equal(sm.allShipped(['SHIPPED', 'SHIPPED']), true);
  assert.equal(sm.allShipped(['SHIPPED', 'PACKED']), false);
  assert.equal(sm.allShipped([]), false);
});
