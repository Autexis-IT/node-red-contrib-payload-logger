const fs = require('fs-extra');
const { id } = require('date-fns/locale');
module.exports = function (RED) {
  const util = require('util');
  const _ = require('lodash');
  const fs = require('fs-extra');
  const path = require('path');

  function LoggerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.on('input', function (msg, send, done) {
      const {
        name,
        debugWindow,
        console,
        appendingToFile,
        appendNewline,
      } = config;
      const PAYLOAD_LOGS_PATH = process.env.PAYLOAD_LOGS_PATH || './logs';
      const folder = config.folder || msg.folder;
      if (_.isNil(folder)) {
        node.error('folder is undefined');
        return;
      }
      const prefix = config.prefix || msg.prefix || msg.type;
      if (_.isNil(prefix)) {
        node.error('prefix is undefined');
        return;
      }
      let extension = config.extensionHidden;
      if (_.isNil(extension)) {
        node.error('extension is undefined');
        return;
      }

      function sendDebug(msg) {
        msg = RED.util.encodeObject(msg);
        RED.comms.publish('debug', msg);
      }

      // Write into Console
      function sendConsole(msg) {
        if (typeof msg === 'string') {
          node.log((msg.indexOf('\n') !== -1 ? '\n' : '') + msg);
        } else if (typeof msg === 'object') {
          node.log(`\n${util.inspect(msg)}`);
        } else {
          node.log(util.inspect(msg));
        }
      }

      // read log file
      function readfile(dir, callback) {
        fs.readFile(dir, 'utf8', (err, existingData) => {
          callback(err, existingData);
        });
      }

      // Write log file
      function writeFile(dir, logText) {
        fs.writeFile(dir, logText, (err) => {
          if (err) throw err;
        });
      }

      // Append to file just for json
      function appendJson(dir, payload) {
        let logText = payload;
        fs.exists(dir, (exists) => {
          if (exists) {
            readfile(dir, (err, data) => {
              try {
                //   const convertData = JSON.parse(data);
                if (data.startsWith('[')) {
                  const convertData = JSON.parse(data);
                  convertData.push(logText);
                  logText = JSON.stringify(convertData, null, 2);
                } else {
                  let newObject;
                  try {
                    newObject = [JSON.parse(data)];
                    // eslint-disable-next-line no-shadow
                  } catch (err) {
                    newObject = [];
                  }
                  newObject.push(logText);
                  logText = JSON.stringify(newObject, null, 2);
                }
              } catch (jsonError) {
                node.status({
                  fill: 'red',
                  shape: 'ring',
                  text: `Error while parsing JSON from File. (msgid: ${msg._msgid}).`,
                });
                node.error(jsonError);
                return;
              }
              writeFile(dir, logText);
            });
          } else {
            writeFile(dir, JSON.stringify(logText, null, 2));
          }
        });
      }

      function appendFile(dir, logText) {
        fs.appendFile(dir, logText, (err) => {
          if (err) throw err;
        });
      }

      // Append to file for all other extensions
      function appendToFile(dir, payload) {
        let logText = payload;
        if (appendNewline) {
          fs.exists(dir, (exists) => {
            if (exists) {
              readfile(dir, (err, data) => {
                if (data.length !== 0) {
                  logText = `\n${logText}`;
                }
                appendFile(dir, logText);
              });
            } else {
              writeFile(dir, logText);
            }
          });
        } else {
          appendFile(dir, logText);
        }
      }

      // reading JSONata
      const identifierPath = config.identifier || msg.identifier;
      const preparedEditExpression = RED.util.prepareJSONataExpression(identifierPath, this);
      RED.util.evaluateJSONataExpression(preparedEditExpression, msg, (error, value) => {
        const identifier = value;

        if (config.extensionHidden === 'str') {
          extension = config.extension || msg.extension;
        }
        let dir;

        // creating File directory
        if (!_.isNil(identifier)) {
          if (appendingToFile === 'true') {
            dir = path.join(`${PAYLOAD_LOGS_PATH}`, `${folder}`, `${prefix}_${identifier}.${extension}`);
          } else {
            dir = path.join(`${PAYLOAD_LOGS_PATH}`, `${folder}`, `${prefix}_${identifier}_${msg._msgid}.${extension}`);
          }
        } else {
          if (appendingToFile === 'true') {
            dir = path.join(`${PAYLOAD_LOGS_PATH}`, `${folder}`, `${prefix}.${extension}`);
          } else {
            dir = path.join(`${PAYLOAD_LOGS_PATH}`, `${folder}`, `${prefix}_${msg._msgid}.${extension}`);
          }
        }

        try {
          fs.ensureDirSync(path.dirname(dir));
        } catch (err) {
          node.status({
            fill: 'red',
            shape: 'ring',
            text: `Can't create File (msgid: ${msg._msgid}).`,
          });
          node.error(err);
          return;
        }
        let logText;
        try {
          if (config.logContent === 'payload') {
            try {
              // Just stringify when its a json object
              if (typeof logText === 'object' && logText !== null) {
                logText = JSON.stringify(logText);
              } else {
                logText = msg.payload;
              }

              if (appendingToFile === 'true') {
                if (extension === 'json') {
                  appendJson(dir, logText);
                } else {
                  appendToFile(dir, logText);
                }
              } else {
                if (typeof logText === 'object' && logText !== null) {
                  logText = JSON.stringify(logText);
                }

                writeFile(dir, logText);
              }
              if (debugWindow) {
                sendDebug({
                  id: node.id,
                  z: node.z,
                  _alias: node._alias,
                  path: node._flow.path,
                  name: name,
                  topic: msg.topic,
                  msg: msg.payload,
                });
              }
              if (console) {
                sendConsole(msg.payload);
              }
            } catch (err) {
              node.status({
                fill: 'red',
                shape: 'ring',
                text: `Can't write payload to the file (msgid: ${msg._msgid}).`,
              });
              node.error(err);
              return;
            }
          } else {
            try {
              const expr = RED.util.prepareJSONataExpression(config.logType, node);
              RED.util.evaluateJSONataExpression(expr, msg, (err, jsonatavalue) => {
                logText = jsonatavalue;
                if (appendingToFile === 'true') {
                  if (extension === 'json') {
                    appendJson(dir, logText);
                  } else {
                    appendToFile(dir, logText);
                  }
                } else {
                  writeFile(dir, logText);
                }

                if (debugWindow) {
                  sendDebug({
                    id: node.id,
                    z: node.z,
                    _alias: node._alias,
                    path: node._flow.path,
                    name: name,
                    topic: msg.topic,
                    msg: logText,
                  });
                }
                if (console) {
                  sendConsole(logText);
                }
                msg.payload = logText;
              });
            } catch (err) {
              node.status({
                fill: 'red',
                shape: 'ring',
                text: `Error while parsing JSONata (msgid: ${msg._msgid}).`,
              });
              return;
            }
          }
          node.status({
            fill: 'green',
            shape: 'ring',
            text: `Log successfully created (msgid: ${msg._msgid}).`,
          });
          setTimeout(() => {
            node.status({
              fill: '',
              shape: '',
              text: '',
            });
          }, 5000);
        } catch (err) {
          this.status({
            fill: 'red',
            shape: 'ring',
            text: `Can't create log (msgid: ${msg._msgid}).`,
          });
          node.error(err);
          return;
        }
        node.send(msg);
        done();
      });
    });
  }

  RED.nodes.registerType('Logger', LoggerNode);
};
