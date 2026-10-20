// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the end-to-end
// tests, so the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the plants of the account (production, grid, battery).
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceUpdated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // OAuth2: the Connect button of the configuration, then iSolarCloud's return to Gladys.
  gladys.onOAuthAuthorizeUrl((key, redirectUri) => app.oauthAuthorizeUrl(key, redirectUri));
  gladys.onOAuthCallback((key, params) => app.oauthCallback(key, params));

  // Configuration screen buttons: the pasted return address, the test, the held indexes.
  gladys.onAction(ACTIONS.FINISH_SIGN_IN, (fields) => app.finishSignIn(fields));
  gladys.onAction(ACTIONS.TEST_CONNECTION, () => app.testConnection());
  gladys.onAction(ACTIONS.ACCEPT_INDEX, () => app.acceptIndex());

  // Configuration changed by the user.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Connection lifecycle: the first connection starts, a reconnection resends.
  gladys.on('connected', async () => {
    try {
      await app.connected(await gladys.getConfig());
    } catch (err) {
      logger?.error('Start failed', err);
    }
  });
}
