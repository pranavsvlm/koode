/**
 * Drop the push entitlement for free Apple ID ("personal team") builds.
 *
 * Personal teams can't sign `aps-environment`, so a build that keeps it can't be
 * installed on a device. Without it the app runs normally but gets no
 * notifications or VoIP pushes (registration fails and is ignored). Applied only
 * when KOODE_PERSONAL_TEAM is set (app.config.ts).
 */
const { withEntitlementsPlist } = require('expo/config-plugins');

module.exports = function withoutPushEntitlement(config) {
  return withEntitlementsPlist(config, (c) => {
    delete c.modResults['aps-environment'];
    return c;
  });
};
