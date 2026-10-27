// Library entry point: require('max68he')
const { Keyboard, BOARD_ID } = require('./src/keyboard');
const { Transport } = require('./src/hid');
const protocol = require('./src/protocol');
const keys = require('./src/keys');

module.exports = { Keyboard, Transport, BOARD_ID, protocol, keys };
