'use strict';

/* Shared loader for the i18n table. js/i18n.js is a self-contained IIFE that publishes window.I18N;
   several suites need the table without re-implementing the sandbox. */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sandbox = {
  console, URLSearchParams,
  location: { search: '' },
  document: { documentElement: {}, querySelectorAll: () => [], title: '' },
  localStorage: { getItem: () => null, setItem: () => {} },
  navigator: { language: 'en' },
  window: {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'i18n.js'), 'utf8'), sandbox);

module.exports = sandbox.window.I18N;
