const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

// SDK 52+ configures monorepo resolution automatically.
const config = getDefaultConfig(__dirname);

module.exports = withNativeWind(config, { input: './global.css' });
