module.exports = function (RED) {
  const util = require('util');
  const _ = require('lodash');
  const fs = require('fs-extra');
  const path = require('path');

  function LoggerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.on('input', function (msg, send, done) {
      const name = config.name;
      const PAYLOAD_LOGS_PATH = process.env.PAYLOAD_LOGS_PATH || './logs';
      const folder = config.folder || msg.folder;
      if (_.isNil(folder)) {
        node.error(`folder is undefined`);
        return;
      }
      let prefix = config.prefix || msg.prefix || msg.type;
      if (_.isNil(prefix)) {
        node.error(`prefix is undefined`);
        return;
      }
      const identifierPath = config.identifier || msg.identifier;
      const identifier = _.get(msg, identifierPath);
      let extension = config.extensionHidden;
      if (_.isNil(extension)) {
        node.error(`extension is undefined`);
        return;
      }
      const debugWindow = config.debugWindow;
      const console = config.console;

      function sendDebug(msg) {
        msg = RED.util.encodeObject(msg);
        RED.comms.publish('debug', msg);
      }

      function sendConsole(msg) {
        if (typeof msg === 'string') {
          node.log((msg.indexOf('\n') !== -1 ? '\n' : '') + msg);
        } else if (typeof msg === 'object') {
          node.log('\n' + util.inspect(msg));
        } else {
          node.log(util.inspect(msg));
        }
      }

      if (config.extensionHidden === 'str') {
        extension = config.extension || msg.extension;
      }
      let dir
      if (!_.isNil(identifier)) {
        dir = path.join(`${PAYLOAD_LOGS_PATH}`, `${folder}`, `${prefix}_${identifier}_${msg._msgid}.${extension}`);
      } else {
        dir = path.join(`${PAYLOAD_LOGS_PATH}`, `${folder}`, `${prefix}_${msg._msgid}.${extension}`);
      }
      try {
        fs.ensureDirSync(path.dirname(dir));
      } catch (err) {
        node.status({fill: 'red', shape: 'ring', text: `Can't create File (msgid: ${msg._msgid}).`});
        node.error(err);
        return;
      }
      let logText;
      try {
        //using Writestream for future feature to appending payloads to one file.
        const wstream = fs.createWriteStream(dir, {encoding: 'binary', flags: 'w', autoClose: true});
        node.wstream = wstream;
        wstream.on('error', function (err) {
          node.error(err);
        });
        wstream.on('open', function () {

          if (config.logContent === 'payload') {
            try {
              logText = JSON.stringify(msg.payload);
              if (debugWindow) {
                sendDebug({
                  id: node.id,
                  z: node.z,
                  _alias: node._alias,
                  path: node._flow.path,
                  name: name,
                  topic: msg.topic,
                  msg: msg.payload
                });
              }
              if (console) {
                sendConsole(msg.payload);
              }
            } catch (err) {
              node.status({
                fill: 'red',
                shape: 'ring',
                text: `Can't write payload to the file (msgid: ${msg._msgid}).`
              });
              return;
            }
          } else {
            try {
              const expr = RED.util.prepareJSONataExpression(config.logType, this);
              logText = RED.util.evaluateJSONataExpression(expr, msg);
              if (debugWindow) {
                sendDebug({
                  id: node.id,
                  z: node.z,
                  _alias: node._alias,
                  path: node._flow.path,
                  name: name,
                  topic: msg.topic,
                  msg: logText
                });
              }
              if (console) {
                sendConsole(logText);
              }
              msg.payload = logText;
            } catch (err) {
              node.status({fill: 'red', shape: 'ring', text: `Error while parsing JSONata (msgid: ${msg._msgid}).`});
              return;
            }
          }
          wstream.end(logText);
        })
        node.status({fill: 'green', shape: 'ring', text: `Log successfully created (msgid: ${msg._msgid}).`})
        setTimeout(() => {
          node.status({fill: '', shape: '', text: ``});
        }, 5000);

      } catch (err) {
        this.status({fill: 'red', shape: 'ring', text: `Can't create log (msgid: ${msg._msgid}).`});
        node.error(err);
        return;
      }
      node.send(msg);
      done();
    });
  }

  RED.nodes.registerType('Logger', LoggerNode);
}
