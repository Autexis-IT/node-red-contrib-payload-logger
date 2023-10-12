const cron = require('node-cron');
const fs = require('fs/promises');
const dateFns = require('date-fns');
const path = require('path');
const AdmZip = require('adm-zip');

module.exports = function (RED) {
  function ConfigNode(n) {
    RED.nodes.createNode(this, n);
    this.days = n.days;
    this.archiveSequences = n.archiveSequences;
    const node = this;

    // DEBUG MODE
    const debugMode = true;
    const debug = (message) => (debugMode ? node.warn(message) : null);

    // Filecontrol
    let totalFileCounter = 0;
    let totalArchivedFileCounter = 0;
    const zipSize = 65535;
    // Limitation: one zip file can contain 65535 files!
    // --> source: https://www.artpol-software.com/ziparchive/KB/0610051629.aspx

    node.archiveSequences.forEach((sequence) => {
      const logsPath = sequence.logsPath.value;
      const archivePath = sequence.archivePath.value;
      const daysToArchive = sequence.daysToArchive.value;
      const daysToDeleteArchive = sequence.daysToDeleteArchive.value;
      const logIntervallUnits = sequence.selectIntervalUnits.value;
      const ArchiveIntervalUnits = sequence.selectArchiveIntervalUnits.value;
      let dateToArchive;
      if (daysToArchive === '' || archivePath === '') {
        return;
      }
      const date = (new Date()).setHours(24, 0, 0, 0);
      if (logIntervallUnits === 'd') {
        dateToArchive = dateFns.add(date, { days: -daysToArchive });
      } else if (logIntervallUnits === 'w') {
        dateToArchive = dateFns.add(date, { weeks: -daysToArchive });
      } else {
        dateToArchive = dateFns.add(date, { months: -daysToArchive });
      }
      let dateToDelete;
      if (daysToDeleteArchive === '') {
        dateToDelete = undefined;
      } else if (ArchiveIntervalUnits === 'd') {
        dateToDelete = dateFns.add(date, { days: -daysToDeleteArchive });
      } else if (ArchiveIntervalUnits === 'w') {
        dateToDelete = dateFns.add(date, { weeks: -daysToDeleteArchive });
      } else {
        dateToDelete = dateFns.add(date, { months: -daysToDeleteArchive });
      }
      let execTime = sequence.executingTime.value;
      if (execTime === '') {
        execTime = '00:00';
      }
      // eslint-disable-next-line max-len
      const currentArchivePath = path.join(archivePath, dateFns.format(dateFns.add(dateToArchive, { days: -1 }), 'yyyy-MM-dd'));

      // The timer is needed to unblock the eventloop.
      //   Do not remove the instances or the gateway will get blocked!
      const timer = (ms) => new Promise((res) => setTimeout(res, ms));

      try {
        const splitedTime = execTime.split(':');
        cron.schedule(`${splitedTime[1]} ${splitedTime[0]} * * *`, () => {
          /** *****************************************************************************
           * try to initialize the zip archive
           ***************************************************************************** */
          async function createNewArchive(srcPath, name) {
            try {
              // eslint-disable-next-line max-len
              const archiveSubPath = path.join(currentArchivePath, path.relative(path.resolve(logsPath), path.resolve(srcPath)));
              let fullArchivePath = path.join(archiveSubPath, `${name}.zip`);
              debug(`[createNewArchive] Trying to create a new archive: ${fullArchivePath}`);

              try {
                await fs.access(archiveSubPath);
                debug(`[createNewArchive] ${archiveSubPath} dir already exists`);
              } catch (err) {
                debug(`[createNewArchive] ${archiveSubPath} does not exist. creating..`);
                try {
                  await fs.mkdir(archiveSubPath, { recursive: true });
                  debug(`[createNewArchive] Archive path "${archiveSubPath}" created.`);
                } catch (err) {
                  throw `[createNewArchive] Error creating directory${archiveSubPath}. Error: ${err}`;
                }
              }
              try {
                await fs.access(fullArchivePath);
                debug(`[createNewArchive] ${fullArchivePath} already exists. Added postfix to filename`);
                // eslint-disable-next-line max-len
                fullArchivePath = path.join(archiveSubPath, `${name}_conflict-${dateFns.format(new Date(), 'yyyy-MM-dd_HH-mm-ss')}.zip`);
              } catch (err) {
                debug(`[createNewArchive] ${fullArchivePath} does not exist. creating..`);
              }

              const tempZip = new AdmZip();
              tempZip.writeZip(fullArchivePath);
              debug(`[createNewArchive] Archive "${fullArchivePath}" created.`);

              return {
                zipper: tempZip,
                name: fullArchivePath,
              };
            } catch (err) {
              node.error(`[createNewArchive] Creating archive failed: ${err}`);
              node.error('[createNewArchive] Please cleanup archive files.');
              throw err;
            }
          }

          /** *****************************************************************************
           * deleteFiles
           *   an async function to delete files
           *   -> handles file after file and await the deletion
           ***************************************************************************** */
          async function deleteFiles(files) {
            if (!files.length) {
              return 0;
            }
            do {
              const file = files.shift();
              try {
                await fs.rm(file);
              } catch (err) {
                if (JSON.stringify(err)
                  .indexOf('EBUSY') >= 0) {
                  node.warn(`[deleting files] Error: ${JSON.stringify(err)}`);
                  // eslint-disable-next-line max-len
                  node.warn('[deleting files] nssm or an other software may use the file. In this case you can ignore the error above.');
                } else {
                  node.error(`[deleting files] Error: ${JSON.stringify(err)}`);
                }
              }
              if (files.length % 500 === 0) {
                await timer(25);
              }
            } while (files.length);
            return 1;
          }

          /** *****************************************************************************
           * dirCrawler
           *   async file reader, filter and archiver to prevent blocking the eventloop
           *   -> archiver works synchronous..
           ***************************************************************************** */
          async function dirCrawler(srcPath, fileArray = []) {
            try {
              let filecounter = 0;

              // get all the files and directories in srcPath
              debug(`get all the files and directories from ${srcPath}`);
              let entries = await fs.readdir(srcPath, { withFileTypes: true });
              // filter and sort files that has to be archived
              const dirs = entries.filter((path) => path.isDirectory())
                .map((dirent) => dirent.name);
              let files = entries.filter((path) => path.isFile())
                .map((dirent) => dirent.name);
              totalFileCounter += files.length;
              debug('filter and sort files that has to be archived');
              let filesToArchive = [];
              for (let i = files.length - 1; i >= 0; i--) {
                // check if file is outdated
                const file = files[i];
                const filePath = path.join(srcPath, file);
                try {
                  const stat = await fs.stat(path.resolve(filePath));
                  if (!stat.size) {
                    node.warn(`[dirCrawler - processFile] Got empty file! Deleting file ${filePath} ..`);
                    await deleteFiles([filePath]);
                    node.warn('[dirCrawler - processFile]    .. deleted.');
                  } else if (new Date(stat.mtimeMs) < dateToArchive) {
                    filesToArchive.push({
                      filePath,
                      time: stat.mtime,
                    });
                  }
                } catch (err) {
                  node.warn(`[dirCrawler - processFile] Failed to read stats of file ${file}`);
                }
              }
              filesToArchive.sort((a, b) => a.time - b.time);

              // split sorted files into batches of max 'zipSize' files to process
              debug('split sorted files into batches of max zipSize files to process');
              if (filesToArchive.length) {
                let offset = 0;
                do {
                  let zip = {
                    name: '',
                    zipper: {},
                  };
                  const batchToProcess = filesToArchive.slice(offset, offset + zipSize);
                  const currentFileAmount = offset + batchToProcess.length;
                  offset += zipSize;
                  const lastElement = batchToProcess.slice(-1);

                  // eslint-disable-next-line max-len
                  const zipName = `${dateFns.format(new Date(batchToProcess[0].time), 'yyyy-MM-dd_HH-mm-ss')}_to_${dateFns.format(new Date(lastElement[0].time), 'yyyy-MM-dd_HH-mm-ss')}`;
                  debug(`=== Filename: ${zipName}`);

                  // create new archive
                  try {
                    zip = await createNewArchive(srcPath, zipName);
                    debug(`====== ${zip.name}`);
                  } catch (err) {
                    throw `[dirCrawler] Creating archive failed: ${err}`;
                  }

                  // process files in batch
                  let filesToDelete = [];
                  do {
                    const file = batchToProcess.pop();
                    const { filePath } = file;
                    zip.zipper.addLocalFile(filePath);
                    filesToDelete.push(filePath);
                  } while (batchToProcess.length);

                  // try to write zip
                  try {
                    const res = await zip.zipper.writeZipPromise(zip.name);
                  } catch (err) {
                    // reset filesToDelete to prevent deletion after zip writing failed
                    filesToDelete = [];
                    node.error(`[dirCrawler - processFile] FAILED TO WRITE ZIP FILE! ${err}`);
                  }
                  filecounter += filesToDelete.length;
                  totalArchivedFileCounter += filesToDelete.length;

                  // delete zipped files
                  await deleteFiles(filesToDelete);
                  debug(`(${new Date().toISOString()}) Batch proceed`);
                } while (offset < filesToArchive.length);
              }

              // log
              // eslint-disable-next-line max-len
              const message = `${dirs.length ? `dir ${path.join(srcPath, dirs.toString())}` : `end of dir ${srcPath}`} ${filesToArchive.length} files to process and ${filecounter} outdated files`;
              node.log(message);

              // leave garbage in old space
              entries = undefined;
              files = undefined;
              filesToArchive = undefined;

              return dirs;
            } catch (err) {
              node.error(`[dirCrawler] ${err}`);
              return '';
            }
          }

          /** *****************************************************************************
           * archiveCleanup
           ***************************************************************************** */
          async function archiveCleanup() {
            try {
              const entries = await fs.readdir(archivePath, { withFileTypes: true });
              const dirs = entries.filter((path) => path.isDirectory())
                .map((dirent) => dirent.name);
              node.log(`[archiveCleanup] started cleaning up archives. ${dirs.length} archive dirs found.`);

              if (dirs.length) {
                do {
                  const archiveName = dirs.pop();
                  let archiveDate;
                  try {
                    archiveDate = dateFns.parseISO(archiveName);
                  } catch (err) {
                    node.warn(`[archiveCleanup] Parsing archive date failed. Archive ${archiveName} skipped.`);
                  }

                  try {
                    if (dateToDelete !== undefined) {
                      if (archiveDate < dateToDelete) {
                        await fs.rm(path.resolve(path.join(archivePath, archiveName)), {
                          force: true,
                          recursive: true,
                        });
                      }
                    }
                  } catch (err) {
                    node.error(`[archiveCleanup - Error while deleting dir ${archiveName}] ${err}`);
                  }
                } while (dirs.length);
              }
            } catch (err) {
              node.error(`[archiveCleanup] ${err}`);
            }

            return 'done';
          }

          /** *****************************************************************************
           * MainLoop
           *  - executing the crawler sequenzed to prevent overflow of CallStack
           ***************************************************************************** */
          async function mainLoop(logsPath) {
            const pendingDirs = [logsPath];
            do {
              try {
                debug(`Pending dirs: ${JSON.stringify(pendingDirs)}`);
                const currentDir = pendingDirs.pop();
                const newPaths = await dirCrawler(currentDir);
                debug(`New Paths: ${JSON.stringify(newPaths)}`);
                for (let i = newPaths.length - 1; i >= 0; i--) {
                  pendingDirs.push(path.join(currentDir, newPaths[i]));
                }
              } catch (err) {
                node.error(`[mainLoop] ${JSON.stringify(err)}`);
              }
            } while (pendingDirs.length > 0);

            return 'done';
          }

          /** *****************************************************************************
           * Main
           ***************************************************************************** */
          mainLoop(logsPath)
            .then((res) => {
              node.log(`Archiving finished. ${totalArchivedFileCounter} of ${totalFileCounter} files archived.`);
            })
            .catch((err) => {
              node.error(`PANIC: ${JSON.stringify(err)}`);
            })
            .then(archiveCleanup)
            .then((res) => {
              node.log('Cleaning up archives finished.');
            })
            .finally(() => {
              debug('FINALLY!');
            });
        });
      } catch (err) {
        node.error(`Can't create cron-job for execution: ${err}`);
      }
    });
  }

  RED.nodes.registerType('LogConfig', ConfigNode);
};
