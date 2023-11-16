const util = require('util');
const _ = require('lodash');
const fs = require('fs/promises');
const path = require('path');
const format = require('date-fns/format');

// eslint-disable-next-line func-names
module.exports = function (RED) {
  function LoggerNode(config) {
    this.filePath = '';
    RED.nodes.createNode(this, config);
    const node = this;
    node.on('input', async (msg, send, done) => {
      const formattedDate = format(new Date(), 'yyyy-MM-dd', { useAdditionalDayOfYearTokens: true });
      const {
        name,
        debugWindow,
        console,
        appendingToFile,
        appendNewline,
        filesize,
        filesizeBytes,
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
      let bytes;
      switch (filesizeBytes) {
        case 'kb':
          bytes = filesize * 1024;
          break;
        case 'mb':
          bytes = filesize * 1024 * 1024;
          break;
        case 'gb':
          bytes = filesize * 1024 * 1024 * 1024;
          break;
        default:
          bytes = 10 * 1024 * 1024;
          break;
      }

      // reading JSONata
      const identifierPath = config.identifier || msg.identifier || 'empty';
      const preparedEditExpression = RED.util.prepareJSONataExpression(identifierPath, this);
      const identifier = RED.util.evaluateJSONataExpression(preparedEditExpression, msg);

      function debug(message) {
        const debugmessage = {
          id: node.id,
          z: node.z,
          // eslint-disable-next-line no-underscore-dangle
          _alias: node._alias,
          // eslint-disable-next-line no-underscore-dangle
          path: node._flow.path,
          name,
          topic: msg.topic,
          msg: message,
        };

        RED.comms.publish('debug', RED.util.encodeObject(debugmessage));
      }

      // Write into Console
      function sendConsole(message) {
        if (typeof message === 'string') {
          node.log((message.indexOf('\n') !== -1 ? '\n' : '') + message);
        } else if (typeof message === 'object') {
          node.log(`\n${util.inspect(message)}`);
        } else {
          node.log(util.inspect(message));
        }
      }

      // read log file
      const readfile = async (dir) => fs.readFile(dir, 'utf8');

      // Write log file
      const writeFile = (dir, logText) => fs.writeFile(dir, logText);

      // Append to file just for json
      const appendJson = async (dir, payload) => {
        let logText = payload;
        try {
          await fs.access(dir);
          node.debug(`[createNewArchive] ${dir} dir already exists`);
        } catch (err) {
          await writeFile(dir, JSON.stringify(logText, null, 2));
          return;
        }
        const file = await readfile(dir);
        try {
          if (file.startsWith('[')) {
            const convertData = JSON.parse(file);
            convertData.push(logText);
            logText = JSON.stringify(convertData, null, 2);
          } else {
            let newObject;
            try {
              newObject = [JSON.parse(file)];
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
            // eslint-disable-next-line no-underscore-dangle
            text: `Error while parsing JSON from File. (msgid: ${msg._msgid}).`,
          });
          node.error(jsonError);
          return;
        }
        await writeFile(dir, logText);
      };

      const appendFile = async (dir, logText) => fs.appendFile(dir, logText);

      const getfileSize = async (dir) => {
        try {
          const stats = await fs.stat(dir);
          return stats.size;
        } catch (e) {
          return 0;
        }
      };

      const rotation = async (files, prefixIdentifierPattern, index) => {
        let highestFileNumber = -1; // Initialize with a low number
        let highestNumberFile = null;

        files.forEach((file) => {
          const match = prefixIdentifierPattern.exec(file);

          if (match) {
            const fileNumber = parseInt(match[index], 10);
            if (fileNumber > highestFileNumber) {
              highestFileNumber = fileNumber;
              highestNumberFile = file;
            }
          }
        });
        return {
          highestFileNumber,
          highestNumberFile,
        };
      };
      const creatingFileName = async (dir) => {
        let index;
        if (await getfileSize(dir) >= bytes) {
          const {
            highestNumberFile,
            highestFileNumber,
          } = await rotation(
            await fs.readdir(this.filePath),
            new RegExp(`${prefix}_${identifier}_${formattedDate}(?:_node-(\\w+))?_(\\d+)\\.csv`),
            2
          );
          if (highestNumberFile) {
            const file = `${this.filePath}/${highestNumberFile}`;
            if (await getfileSize(file) < bytes) {
              return file;
            }
            index = highestFileNumber + 1;
          } else {
            index = 1;
          }
          return `${dir.slice(0, -4)}_${index}.${extension}`;
        }
        return dir;
      };

      const checkCSVFile = async (dir, csvHeader, csvValues) => {
        try {
          const file = await readfile(dir);
          if (file) {
            const actualHeader = file.split('\n')[0].trim();
            if (actualHeader === csvHeader) {
              await appendFile(dir, `${csvValues}\n`);
              return true;
            }
            return false;
          }
        } catch (e) {
          node.debug(`creating new file ${dir}`);
        }
        if (dir) {
          await writeFile(dir, `${csvHeader}\n${csvValues}\n`);
          return true;
        }
        return false;
      };

      const appendCSV = async (dir, logText) => {
        // Columns
        const columnKeys = Object.keys(logText);
        const csvHeader = columnKeys.join(';');
        // Values
        const values = Object.values(logText)
          .map((value) => (
            typeof value === 'object' ? JSON.stringify(value) : value
          ));
        const csvValues = values.join(';');
        if (!await checkCSVFile(dir, csvHeader, csvValues)) {
          let newFile;
          try {
            await readfile(`${dir.slice(0, -4)}_node-${node.id}.csv`);
            const {
              highestNumberFile,
              highestFileNumber,
            } = await rotation(
              await fs.readdir(this.filePath),
              new RegExp(`${prefix}_${identifier}_${formattedDate}_(\\w+)_node-(\\w+)_(\\d+).csv`),
              3
            );
            let index = highestFileNumber;
            let filepath = null;
            if (highestNumberFile) {
              filepath = path.join(this.filePath, highestNumberFile);
            }
            if (!await checkCSVFile(filepath, csvHeader, csvValues)) {
              if (index < 0) {
                index = 1;
              } else {
                index += 1;
              }
              newFile = `${dir.slice(0, -4)}_node-${node.id}_${index}.csv`;
              await checkCSVFile(newFile, csvHeader, csvValues);
              return;
            }
            return;
          } catch (e) {
            newFile = `${dir.slice(0, -4)}_node-${node.id}.csv`;
          }
          await writeFile(newFile, `${csvHeader}\n${csvValues}\n`);
        }
      };

      // Append to file for all other extensions
      const appendToFile = async (dir, payload) => {
        let logText = payload;
        if (appendNewline) {
          try {
            await fs.access(dir);
            node.debug(`[createNewArchive] ${dir} dir already exists`);
          } catch (err) {
            await writeFile(dir, logText);
            return;
          }
          const file = await readfile(dir);
          if (file.length !== 0) {
            logText = `\n${logText}`;
          }
          await appendFile(dir, logText);
        } else {
          await appendFile(dir, logText);
        }
      };

      const append = async (dir, logText) => {
        const newdir = await creatingFileName(dir);
        if (extension === 'json') {
          await appendJson(newdir, logText);
        } else if (extension === 'csv') {
          await appendCSV(newdir, logText);
        } else {
          await appendToFile(newdir, JSON.stringify(logText));
        }
      };

      if (config.extensionHidden === 'str') {
        extension = config.extension || msg.extension;
      }
      let dir;

      this.filePath = path.join(`${PAYLOAD_LOGS_PATH}`, `${folder}`);
      // creating File directory
      if (!_.isNil(identifier)) {
        if (appendingToFile === 'true') {
          dir = path.join(this.filePath, `${prefix}_${identifier}_${formattedDate}.${extension}`);
        } else {
          // eslint-disable-next-line no-underscore-dangle
          dir = path.join(this.filePath, `${prefix}_${identifier}_${msg._msgid}.${extension}`);
        }
      } else if (appendingToFile === 'true') {
        dir = path.join(this.filePath, `${prefix}_${formattedDate}.${extension}`);
      } else {
        // eslint-disable-next-line no-underscore-dangle
        dir = path.join(this.filePath, `${prefix}_${msg._msgid}.${extension}`);
      }

      try {
        await fs.mkdir(this.filePath, { recursive: true });
      } catch (error) {
        node.debug('Path already exists');
      }
      let logText;
      try {
        if (config.logContent === 'payload') {
          try {
            logText = msg.payload;
            if (appendingToFile === 'true') {
              await append(dir, logText);
            } else {
              if (typeof logText === 'object' && logText !== null) {
                logText = JSON.stringify(logText, null, 2);
              }
              await writeFile(dir, logText);
            }
            if (debugWindow) {
              debug(msg.payload);
            }
            if (console) {
              sendConsole(msg.payload);
            }
          } catch (err) {
            node.status({
              fill: 'red',
              shape: 'ring',
              // eslint-disable-next-line no-underscore-dangle
              text: `Can't write payload to the file (msgid: ${msg._msgid}).`,
            });
            node.error(err);
            return;
          }
        } else {
          try {
            const expr = RED.util.prepareJSONataExpression(config.logType, node);
            logText = RED.util.evaluateJSONataExpression(expr, msg);
            if (appendingToFile === 'true') {
              await append(dir, logText, extension);
            } else {
              await writeFile(dir, JSON.stringify(logText));
            }

            if (debugWindow) {
              debug(logText);
            }
            if (console) {
              sendConsole(logText);
            }
            // eslint-disable-next-line no-param-reassign
            msg.payload = logText;
          } catch (err) {
            node.status({
              fill: 'red',
              shape: 'ring',
              // eslint-disable-next-line no-underscore-dangle
              text: `Error while parsing JSONata (msgid: ${msg._msgid}).`,
            });
            return;
          }
        }
        node.status({
          fill: 'green',
          shape: 'ring',
          // eslint-disable-next-line no-underscore-dangle
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
        node.status({
          fill: 'red',
          shape: 'ring',
          // eslint-disable-next-line no-underscore-dangle
          text: `Can't create log (msgid: ${msg._msgid}).`,
        });
        node.error(err);
        return;
      }
      node.send(msg);
      done();
    });
  }

  RED.nodes.registerType('Logger', LoggerNode);
};
