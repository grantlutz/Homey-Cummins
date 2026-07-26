'use strict';

/**
 * App Web API, consumed by the settings page (settings/index.html).
 * Endpoint declarations live in .homeycompose/app.json under "api".
 */

module.exports = {

  async getDiagnostics({ homey }) {
    return homey.app.getDiagnostics();
  },

  async refreshAll({ homey }) {
    return homey.app.refreshAll();
  },

};
